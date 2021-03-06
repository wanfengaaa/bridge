'use strict';

const assert = require('assert');
const CronJob = require('cron').CronJob;
const Config = require('../config');
const Storage = require('storj-service-storage-models');
const points = Storage.constants.POINTS;
const log = require('../logger');

function StorageEventsCron(config) {
  if (!(this instanceof StorageEventsCron)) {
    return new StorageEventsCron(config);
  }

  assert(config instanceof Config, 'Invalid config supplied');

  this._config = config;
}

StorageEventsCron.CRON_TIME = '00 */10 * * * *'; // every ten minutes
StorageEventsCron.MAX_RUN_TIME = 600000; // 10 minutes
StorageEventsCron.FINALITY_TIME = 10800000; // 3 hours

StorageEventsCron.prototype.start = function(callback) {
  log.info('starting the storage events cron');

  this.storage = new Storage(
    this._config.storage.mongoUrl,
    this._config.storage.mongoOpts,
    { logger: log }
  );

  this.job = new CronJob({
    cronTime: StorageEventsCron.CRON_TIME,
    onTick: this.run.bind(this),
    start: false,
    timeZone: 'UTC'
  });

  this.job.start();

  callback();
};

StorageEventsCron.prototype._resolveCodes = function(event, user) {
  const threshold = this._config.application.unknownReportThreshold;

  let success = event.success;
  let unknown = success ? false : true;
  if (unknown) {
    resolveCodes();
  }

  function resolveCodes() {
    const failureCode = 1100;
    const successCode = 1000;

    const clientCode = event.clientReport ?
          event.clientReport.exchangeResultCode : undefined;
    const farmerCode = event.farmerReport ?
          event.farmerReport.exchangeResultCode : undefined;

    /* jshint eqeqeq: false */
    if (clientCode == successCode) {
      success = true;
      unknown = false;
    } else if (farmerCode == failureCode && !clientCode) {
      success = false;
      unknown = false;
    } else if (farmerCode == failureCode && clientCode == failureCode) {
      success = false;
      unknown = false;
    } else if (!farmerCode && clientCode == failureCode) {
      success = false;
      unknown = false;
    } else if (user.exceedsUnknownReportsThreshold(threshold)) {
      success = true;
      unknown = true;
    }
  }

  return {
    success: success,
    unknown: unknown
  };

};

StorageEventsCron.prototype._updateReputation = function(nodeID, points) {
  this.storage.models.Contact.findOne({_id: nodeID}, (err, contact) => {
    if (err || !contact) {
      log.warn('updateReputation: Error trying to find contact ' +
               ' %s, reason: %s', nodeID, err ? err.message : 'unknown');
      return;
    }
    contact.recordPoints(points).save((err) => {
      if (err) {
        log.warn('updateReputation: Error saving contact ' +
                 ' %s, reason: %s', nodeID, err.message);
      }
    });
  });
};

StorageEventsCron.prototype._resolveEvent = function(event, callback) {

  this.storage.models.User.findOne({_id: event.user}, (err, user) => {
    if (err) {
      return callback(err);
    }

    const {success, unknown} = this._resolveCodes(event, user);

    // Mark the event as processed as to avoid counting this storage
    // event multiple times in reporting rates
    event.processed = true;

    // Set the event success status based on how it's resolved
    event.success = success;

    // Award points to the farmer for the success or failure
    if (success) {
      this._updateReputation(event.farmer, points.TRANSFER_SUCCESS);
    } else {
      this._updateReputation(event.farmer, points.TRANSFER_FAILURE);
    }

    event.save((err) => {
      if (err) {
        return callback(err);
      }
      finalize();
    });


    function finalize() {
      const bytes = event.storage || event.downloadBandwidth;
      user.updateUnknownReports(unknown, event.timestamp, bytes, (err) => {
        if (err) {
          return callback(err);
        }

        callback(null, event.timestamp);
      });
    }
  });
};

StorageEventsCron.prototype._run = function(lastTimestamp, callback) {

  const StorageEvent = this.storage.models.StorageEvent;
  const finalityTime = new Date(Date.now() - StorageEventsCron.FINALITY_TIME);

  // There is a slight overlap between work to make sure that the edge
  // case where events have the same timestamp are not left behind in the
  // processing. It's important that all updates are safetly repeatable.
  // We also make sure to only query storage events that have not already
  // been processed to make sure that they are not processed multiple
  // times that would give incorrect reporting rates.
  const cursor = StorageEvent.find({
    timestamp: {
      $lt: finalityTime,
      $gte: lastTimestamp
    },
    processed: { $eq: false },
    user: {
      $exists: true,
      $ne: null
    }
  }).sort({timestamp: 1}).cursor();

  const timeout = setTimeout(() => {
    finish(new Error('Job exceeded max duration'));
  }, StorageEventsCron.MAX_RUN_TIME);

  let callbackCalled = false;

  function finish(err) {
    clearTimeout(timeout);
    cursor.close();
    if (!callbackCalled) {
      callbackCalled = true;
      callback(err, lastTimestamp);
    }
  }

  cursor.on('error', finish);

  cursor.on('data', (event) => {
    cursor.pause();
    this._resolveEvent(event, (err, _lastTimestamp) => {
      if (err) {
        return finish(err);
      }
      lastTimestamp = _lastTimestamp;
      cursor.resume();
    });
  });

  cursor.on('end', finish);
};

StorageEventsCron.prototype.run = function() {
  const name = 'StorageEventsFinalityCron';
  const Cron = this.storage.models.CronJob;
  Cron.lock(name, StorageEventsCron.MAX_RUN_TIME, (err, locked, res) => {
    if (err) {
      return log.error('%s lock failed, reason: %s', name, err.message);
    }
    if (!locked) {
      return log.warn('%s already running', name);
    }

    log.info('Starting %s cron job', name);

    let lastTimestamp = new Date(0);
    if (res &&
        res.value &&
        res.value.rawData &&
        res.value.rawData.lastTimestamp) {
      lastTimestamp = new Date(res.value.rawData.lastTimestamp);
    } else {
      log.warn('%s cron has unknown lastTimestamp', name);
    }

    this._run(lastTimestamp, (err, _lastTimestamp) => {
      if (err) {
        let message = err.message ? err.message : 'unknown';
        log.error('Error running %s, reason: %s', name, message);
      }

      log.info('Stopping %s cron', name);
      const rawData = {};
      if (_lastTimestamp) {
        rawData.lastTimestamp = _lastTimestamp.getTime();
      }

      Cron.unlock(name, rawData, (err) => {
        if (err) {
          return log.error('%s unlock failed, reason: %s', name, err.message);
        }
      });

    });
  });
};

module.exports = StorageEventsCron;
