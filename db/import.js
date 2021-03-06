var payshares   = require('payshares-lib');
var env      = process.env.NODE_ENV || "development";
var config   = require('../deployment.environments.json')[env];
var DBconfig = require('../db.config.json')[env];
var db       = require('nano')({url:DBconfig.protocol+
    '://'  + DBconfig.username + 
    ':'    + DBconfig.password + 
    '@'    + DBconfig.host + 
    ':'    + DBconfig.port + 
    '/'    + DBconfig.database,
    request_defaults : {timeout :10 * 1000}, //30 seconds max for couchDB 
    });
var indexer = require('./indexer.js');
var moment  = require('moment');
var diff    = require('deep-diff');
var async   = require('async');
var store   = require('node-persist');
var Ledger  = require('../node_modules/payshares-lib/src/js/ripple/ledger').Ledger;
var winston = require('winston');
var http     = require('http');
var https    = require('https');
var maxSockets;
  
//this is the maximum number of concurrent requests to couchDB
maxSockets = config.maxSockets || 100;
http.globalAgent.maxSockets = https.globalAgent.maxSockets = maxSockets;
var options = {
    
    trace   : false,
    trusted : false,
    
    servers: [
      { host: 'http://live.payshares.org', port: 9002, secure: true }
    ],

    connection_offset: 0,
    allow_partial_history : false,
    //last close reconnect
  };

var reset = process.argv.indexOf('--reset') !== -1 ? true : false;

store.initSync();
var importer = { };

if (reset) {
  importer.validated = null;
  importer.last      = null;
  store.setItem('first', null);
  store.setItem('validated', null);
  store.setItem('last', null);
} else {
  importer.validated = store.getItem('validated');
  importer.last      = store.getItem('last');
}

importer.first  = {index : config.startIndex || 0};
importer.remote = new payshares.Remote(options);

winston.info("first ledger: ", importer.first ? importer.first.index : "");
winston.info("last validated ledger: ", importer.validated ? importer.validated.index : "");
winston.info("latest ledger: ", importer.last ? importer.last.index : "");



importer.start = function () {
  importer.remote.connect();
  
  importer.remote.on('ledger_closed', function(resp){
    winston.info("ledger closed:", resp.ledger_index); 
    importer.getLedger(resp.ledger_index, function(err, ledger) {
      if (ledger) indexer.pingCouchDB();
    });
  });

  importer.remote.on('connect', function() {
    winston.info("connected");
    importer.catchUp  = true;
    importer.fetching = false;
    importer.fetchHistorical();
  });
  
  importer.remote.on('disconnect', function() {
    winston.info("disconnected");
  });  
};

 
importer.getLedger = function (ledgerIndex, callback) {
  var options = {
    transactions:true, 
    expand:true,
  }
  
  if (isNaN(ledgerIndex)) {
    if (typeof callback === 'function') callback("invalid ledger index");
    return;  
  }
  
  var request = importer.remote.request_ledger(ledgerIndex, options, function(err, resp) {
    var ledgerIndex = this.message.ledger;
    if (err || !resp || !resp.ledger) {
      winston.error("error:", err);  
      setTimeout(function(){
        importer.getLedger(ledgerIndex, callback);            
      }, 500);
      return;
    }    
    
    importer.handleLedger(resp.ledger, ledgerIndex, callback);    
  }); 
  
  var info = request.server ? request.server._url + " " + request.server._hostid : "";
  winston.info("requesting ledger:", ledgerIndex, info, '['+new Date().toISOString()+']');  
};

importer.handleLedger = function(remoteLedger, ledgerIndex, callback) {

  var ledger;
  try {
    ledger = formatRemoteLedger(remoteLedger);
  } catch (e) {
    winston.error(e);
    if (typeof callback === 'function') callback(e);
    return;  
  }
  
  if (!ledger || !ledger.ledger_index || !ledger.ledger_hash) {
    winston.error("malformed ledger");
    setTimeout(function(){
      importer.getLedger(ledgerIndex, callback);            
    },500);
    return;
  } 
  
  // keep track of which server ledgers came from
  //ledger.server = (server === 'http://0.0.0.0:9002' ? 'http://live.payshares.org:9002' : server);

  // check that transactions hash to the expected value
  var txHash;
  try {
   txHash = Ledger.from_json(ledger).calc_tx_hash().to_hex();
  } catch(err) {
    winston.error("Error calculating transaction hash: "+ledger.ledger_index +" "+ err);
    txHash = '';
  } 
  
  if (txHash && txHash !== ledger.transaction_hash) {

    winston.info('transactions do not hash to the expected value for ' + 
      'ledger_index: ' + ledger.ledger_index + '\n' +
      'ledger_hash: ' + ledger.ledger_hash + '\n' +
      'actual transaction_hash:   ' + txHash + '\n' +
      'expected transaction_hash: ' + ledger.transaction_hash);
    setTimeout(function(){
      importer.getLedger(ledgerIndex, callback);            
    },500);
    return;
  } 
  
  winston.info('Got ledger: ' + ledger.ledger_index, '['+new Date().toISOString()+']');  
  importer.saveLedger(ledger, callback);
}


/**
*  formatRemoteLedger makes slight modifications to the
*  ledger json format, according to the format used in the CouchDB database
*/
function formatRemoteLedger(ledger) {

  ledger.close_time_rpepoch   = ledger.close_time;
  ledger.close_time_timestamp = payshares.utils.toTimestamp(ledger.close_time);
  ledger.close_time_human     = moment(payshares.utils.toTimestamp(ledger.close_time))
    .utc().format("YYYY-MM-DD HH:mm:ss Z");
  ledger.from_paysharesd_api = true;

  delete ledger.close_time;
  delete ledger.hash;
  delete ledger.accepted;
  delete ledger.totalCoins;
  delete ledger.closed;
  delete ledger.seqNum;

  // parse ints from strings
  ledger.ledger_index = parseInt(ledger.ledger_index, 10);
  ledger.total_coins = parseInt(ledger.total_coins, 10);

  // add exchange rate field to metadata entries
  ledger.transactions.forEach(function(transaction) {
    if(!transaction.metaData) {
      winston.info('transaction in ledger: ' + ledger.ledger_index + ' does not have metaData');
      return;
    }

    transaction.metaData.AffectedNodes.forEach(function(affNode) {

      var node = affNode.CreatedNode || affNode.ModifiedNode || affNode.DeletedNode;

      if (node.LedgerEntryType !== "Offer") {
        return;
      }

      var fields = node.FinalFields || node.NewFields;

      if (typeof fields.BookDirectory === "string") {
        node.exchange_rate = payshares.Amount.from_quality(fields.BookDirectory).to_json().value;
      }

    });
  });

  ledger._id = importer.addLeadingZeros(ledger.ledger_index);
  return ledger;
}

/**
* addLeadingZeros converts numbers to strings and pads them with
* leading zeros up to the given number of digits
*/
importer.addLeadingZeros = function (number, digits) {
  var numStr = String(number);
  if (!digits) digits = 10;
  while(numStr.length < digits) {
    numStr = "0" + numStr;
  }

  return numStr;
};
  
importer.saveLedger = function(ledger, callback) {
  
  db.get(ledger._id, function (err, doc) {
    if (doc) {
      ledger._rev = doc._rev;
      
      // don't update docs that haven't been modified
      var diffRes = diff(ledger, doc);
      if (!diffRes || (diffRes.length === 1 && diffRes[0].path[0] === 'server')) {
        winston.info("no change to ledger:" + ledger.ledger_index);
        if (typeof callback === 'function') callback(null, ledger);
        return;
      }

      winston.info('Replacing ledger ' + doc.ledger_index + 
        '\n   Previous: ' + doc.ledger_hash +
        '\n   Replacement: ' + ledger.ledger_hash);
    }
    
    db.insert(ledger, function(err) {
      if (err) {
        //TODO: handle 409 error
        winston.info("error saving ledger:", ledger.ledger_index, err.description ? err.description : err);
        if (typeof callback === 'function') callback(err);
        return;  
      } 
      
      winston.info("saved ledger:", ledger.ledger_index, "close time:", ledger.close_time_human, '['+new Date().toISOString()+']');

      if (!importer.last || importer.last.index < ledger.ledger_index) {
        importer.setMarker('last', ledger); 
      }
      
      if (importer.catchUp || !importer.validated || 
        importer.last.index - importer.validated.index > 100) {
        importer.catchUp = false;
        importer.fetchHistorical();
      }

     if (typeof callback === 'function') callback(null, ledger);
    });
  });
};

importer.setMarker = function (name, ledger) {
  var data = {
    id    : ledger._id,
    index : ledger.ledger_index,
    hash  : ledger.ledger_hash
  }; 
  
  importer[name] = data;
  store.setItem(name, data);
};

importer.fetchHistorical = function () {
  if (importer.fetching) return;
  importer.fetching = true;

  if (!importer.validated) {
    importer.validated = {
      index : importer.first.index - 1
    };
  }
  
  var start = importer.validated.index + 1;
  var end   = importer.validated.index + 100;
  var ids   = [];
  var count = 0;
  var gotLedgers = false;
  
  if (importer.last && end > importer.last.index) end = importer.last.index;
  winston.info("fetching historical:", start, end);
  
  for (i = start; i <= end; i++) {
    ids.push(importer.addLeadingZeros(i));
  }
  
  db.fetch({keys:ids}, function(err, resp){
    if (err || !resp.rows) {
      winston.info("historical: couchdb error:", err);
      importer.fetching = false; 
      return;
    }
    
    var parentHash = importer.validated.hash; 
    resp.rows.forEach(function(row, i) {
 
      if (row.doc && parentHash &&
        row.doc.parent_hash !== parentHash) {
        resp.rows[i].doc = row.doc = undefined;    
      }  
      
      parentHash = row.doc ? row.doc.ledger_hash : null;
    });
    
    async.map(resp.rows, function(row, asyncCallback) {
    
      if (row.doc) {
        asyncCallback(null, row);
      } else {
        var ledgerIndex = parseInt(row.key, 10);
        gotLedgers = true;
        getLedger(++count, ledgerIndex, function (err, resp) {
          if (err) {
            winston.error("fetch historical:", err);
            asyncCallback (null, null);
          } else {
            row.doc = resp;
            asyncCallback (null, row);
          }
        });
      }
      
    }, 
    function (err, rows) {
  
      var validated = importer.validated;

      for(var i=0; i<rows.length; i++) {
        var row = rows[i];
        if (!row) {
          break; 
          
        } else if ((validated.index + 1 === row.doc.ledger_index &&
            validated.hash === row.doc.parent_hash) ||
            (importer.validated.index + 1 === importer.first.index)) {
          validated.index  = row.doc.ledger_index;
          validated.id     = row.doc._id;
          validated.hash   = row.doc.ledger_hash;
          validated.ledger = row.doc;
          
        } else if (validated.index >= row.doc.ledger_index) {
          continue;
          
        } else {
          winston.error("how did we get here?", validated.index, row.key);
          importer.getLedger(validated.index, function(err, ledger) {
            if (err) {
              winston.error(err);
            } else {
              importer.setMarker('validated', ledger);  
            }
            
            importer.fetching = false;
          }); 
          
          return;
        }
      }
      
      if (validated.ledger) {
        importer.setMarker('validated', validated.ledger);
      }
      
      if (gotLedgers) indexer.pingCouchDB();
      importer.fetching = false;
      winston.info("validated to:", importer.validated.index);
      if (importer.last && importer.validated &&
        importer.last.index > importer.validated.index) {
        setTimeout(function(){
          importer.fetchHistorical();   
           
        }, 1000);  
      }
    });
  });
  
  //put a little padding on the ledger requests
  function getLedger(count, index, callback) {
    setTimeout(function() { 
      importer.getLedger(index, callback)
    }, count * 200);
  }
}
  

importer.start();