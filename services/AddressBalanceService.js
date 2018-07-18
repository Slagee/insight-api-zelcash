var Common = require('../lib/common');
var async = require('async');
var BigNumber = require('bignumber.js');
var TYPE = 'ADDRESS_BALANCE';
var MIN_BORDER = 0.001;

function AddressBalanceService (options) {
    this.common = new Common({ log: options.node.log });
    this.lastBlockRepository = options.lastBlockRepository;
    this.addressBalanceRepository = options.addressBalanceRepository;
    this.marketsService = options.marketsService;
    this.node = options.node;
    this.updateFromBlockHeight = 0;

    this.lastTipHeight = 0;
    this.lastTipInProcess = false;
    this.lastTipTimeout = false;
    this.lastCheckedBlock = 0;

    this.richerThanInProcess = false;

    this.cacheIntervals = [];
    this.richerThanCache = [];
    this.richestAddressesListCache = [];
}

AddressBalanceService.prototype.getIntervals = function (next) {
    return next(null, this.cacheIntervals);
};

AddressBalanceService.prototype.getRicherThan = function (next) {
    return next(null, this.richerThanCache);
};

AddressBalanceService.prototype.getRichestAddressesList = function (next) {
    return next(null, this.richestAddressesListCache);
};

AddressBalanceService.prototype.updateRicherThanCache = function (next) {
    if (this.richerThanInProcess) {
        return next ();
    }

    this.richerThanInProcess = true;

    var self = this,
        dataFlow = {
            info: null,
            items: []
        };
    
    return async.waterfall([ function (callback) {
        return self.marketsService.getInfo(function (err, info) {
            if (err) {
                return callback(err);
            }

            dataFlow.info = info;

            return callback();
        });
    }, function (callback) {
        return async.eachSeries([1, 100, 1000, 10000, 100000, 1000000, 10000000], function (greaterThanUsd, callback) {
            if (dataFlow.info.price_usd > 0) {
                return self.addressBalanceRepository.getCountAddressesGreaterThan(greaterThanUsd / dataFlow.info.price_usd, function (err, result) {
                    if (err) {
                        return callback(err);
                    }

                    dataFlow.items.push({
                        amount_usd: greaterThanUsd,
                        count_addresses: result
                    });

                    return callback();
                });
            }

            return callback();
        }, function (err) {
            return callback(err);
        });
    }], function (err) {
        self.richerThanInProcess = false;

        if (err) {
            return next(err);
        }

        self.richerThanCache = dataFlow.items;

        return next();
    });
};

module.exports = AddressBalanceService;