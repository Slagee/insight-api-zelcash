'use strict'

var async = require('async');
var bitcore = require('bitcore-lib-zelcash');
var _ = bitcore.deps_;
var BN = bitcore.crypto.BN;
var LRU = require('lru-cache');
var Common = require('./common');

function StatisticController (options) {
    this.node = options.node;
    this.node.services.bitcoind.on('tip', this._rapidProtectedUpdateTip.bind(this));
    this.common = new Common({ log: this.node.log });
    
    this.blocksByHeight = LRU(999999);
    this.feeByHeight = LRU(999999);
    this.outputsByHeight = LRU(999999);

    this.statisticByDays = LRU(999999999);

    this.lastRequestedBlock = 0;
    this.lastCheckedBlock = 0;

    this.lastTipHeight = 0;
    this.lastTipInProcess = false;
    this.lastTipTimeout = false;
}

StatisticController.DEFAULT_STATISTIC_COUNT_DAYS = 365;
StatisticController.DEFAULT_STATISTIC_MAX_COUNT_DAYS = 365 * 2;

StatisticController.prototype.getTimeSpan = function (req) {
    var days = req.query.days,
        defaultCountDays = StatisticController.DEFAULT_STATISTIC_COUNT_DAYS,
        maxDays = StatisticController.DEFAULT_STATISTIC_MAX_COUNT_DAYS;

    if (days && !isNaN(parseInt(days)) && days > 0) {
        if (maxDays < parseInt(days)) {
            return maxDays;
        }

        return parseInt(days);
    }

    return defaultCountDays;
};

StatisticController.prototype.difficulty = function (req, res) {
    var self = this,
        currentDate = new Date(),
        formattedDate = this.formatTimestamp(currentDate),
        results = [],
        days = self.getTimeSpan(req),
        iterator = 0;

    while (self.statisticByDays.get(formattedDate) && days > iterator) {
        var cachedDay = self.statisticByDays.get(formattedDate),
            sum = cachedDay.difficulty && cachedDay.difficulty.sum && cachedDay.difficulty.count ? cachedDay.difficulty.sum / cachedDay.difficulty.count : 0;
        
        results.push({
            date: formattedDate,
            sum: sum
        });

        currentDate.setDate(currentDate.getDate() - 1);
        formattedDate = this.formatTimestamp(currentDate);
        iterator++;
    }
    return res.jsonp(results);
};

StatisticController.prototype.outputs = function (req, res) {
    var self = this,
        currentDate = new Date(),
        formattedDate = this.formatTimestamp(currentDate),
        results = [],
        iterator = 0,
        days = self.getTimeSpan(req);
    
    while (self.statisticByDays.get(formattedDate) && days > iterator) {
        var cachedDay = self.statisticByDays.get(formattedDate),
            sum = cachedDay.totalOutputVolume && cachedDay.totalOutputVolume.sum ? cachedDay.totalOutputVolume.sum : 0;

        results.push({
            date: formattedDate,
            sum: sum
        });

        currentDate.setDate(currentDate.getDate() - 1);
        formattedDate = this.formatTimestamp(currentDate);
        iterator++;
    }
    return res.jsonp(results);
};

StatisticController.prototype.transactions = function (req, res) {
    var self = this,
        currentDate = new Date(),
        formattedDate = this.formatTimestamp(currentDate),
        days = self.getTimeSpan(req),
        iterator = 0,
        results = [];

    while (self.statisticByDays.get(formattedDate) && days > iterator) {
        var cachedDay = self.statisticByDays.get(formattedDate);
        results.push({
            date: formattedDate,
            transactions_count: cachedDay.numberOfTransactions.count,
            block_count: cachedDay.totalBlocks.count
        });

        currentDate.setDate(currentDate.getDate() - 1);
        formattedDate = this.formatTimestamp(currentDate);
        iterator++;
    }
    return res.jsonp(results);
};

StatisticController.prototype.fees = function (req, res) {
    var self = this,
        currentDate = new Date(),
        formattedDate = this.formatTimestamp(currentDate),
        results = [],
        iterator = 0,
        days = self.getTimeSpan(req);

    while (self.statisticByDays.get(formattedDate) && days > iterator) {
        var cachedDay = self.statisticByDays.get(formattedDate),
            avg = cachedDay.totalTransactionFees.sum && cachedDay.totalTransactionFees.count ? cachedDay.totalTransactionFees.sum / cachedDay.totalTransactionFees.count : 0;

        results.push({
            date: formattedDate,
            fee: avg
        });

        currentDate.setDate(currentDate.getDate() - 1);
        formattedDate = this.formatTimestamp(currentDate);
        iterator++;
    }

    return res.jsonp(results);
};

StatisticController.prototype.total = function (req, res) {
    var self = this,
        height = self.lastCheckedBlock,
        next = true,
        sumBetweenTime = 0,
        countBetweenTime = 0,
        numTransactions = 0,
        minedBlocks = 0,
        minedCurrencyAmount = 0,
        allFee = 0,
        sumDifficulty = 0,
        totalOutputsAmount = 0;

    while (next && height > 0) {
        var currentElement = self.blocksByHeight.get(height),
            outputAmount = self.outputsByHeight.get(height);

        if (currentElement) {
            var nextElement = self.blocksByHeight.get(height - 1),
                fee = self.feeByHeight.get(height);

            if (nextElement) {
                sumBetweenTime += (nextElement.header.time - currentElement.header.time);
                countBetweenTime++;
            }

            numTransactions += currentElement.transactions.length;
            minedBlocks++;

            var difficulty = currentElement.header.getDifficulty();

            if (difficulty) {
                sumDifficulty += difficulty;
            }
            if (fee) {
                allFee += fee;
            }
            if (outputAmount) {
                totalOutputsAmount += outputAmount;
            }
        } else {
            next = false;
        }

        height--;
    }

    var result = {
        n_blocks_mined: minedBlocks,
        time_between_blocks: sumBetweenTime,
        mined_currency_amount: minedCurrencyAmount,
        transactions_fees: allFee,
        number_of_transactions: numTransactions,
        outputs_volume: totalOutputsAmount,
        difficulty: sumDifficulty
    };
    return res.jsonp(result);
};

StatisticController.prototype.formatTimestamp = function(date) {
    var yyyy = date.getUTCFullYear().toString();
    var mm = (date.getUTCMonth() + 1).toString(); // getMonth() is zero-based
    var dd = date.getUTCDate().toString();

    return yyyy + '-' + (mm[1] ? mm : '0' + mm[0]) + '-' + (dd[1] ? dd : '0' + dd[0]); //padding
};

StatisticController.prototype._getLastBlocks = function(height, next) {
    var self = this,
        blocks = [];

    for (var i = self.lastRequestedBlock + 1; i <= height; i++) {
        blocks.push(i);
    }

    self.lastRequestedBlock = height;
    return async.eachSeries(blocks, function (blockHeight, callback) {
        var dataFlow = {
            block: null,
            fee: 0,
            totalOutputs: 0
        };

        return async.waterfall([ function (callback) {
            return self.node.getBlock(blockHeight, function (err, block) {
                if ((err && err.code === -5) || (err && err.code === -8)) {
                    return callback(err);
                } else if (err) {
                    return callback(err);
                }
    
                dataFlow.block = block;
                return callback();
            });
        }, function (callback) {
            var transaction0 = dataFlow.block.transactions[0],
                output0 = transaction0.outputs[0];
            
            if ((output0.satoshis) > 0) {
                dataFlow.fee = output0.satoshis;
            }
            return callback();
        }, function (callback) {
            var trxsExcept = [];
            trxsExcept.push(0);

            dataFlow.block.transactions.forEach( function (transaction, idx) {
                if (trxsExcept.indexOf(idx) === -1) {
                    transaction.outputs.forEach( function (output) {
                        dataFlow.totalOutputs += output.satoshis;
                    });
                }
            });

            return callback();
        }], function (err) {
            if (err) {
                return callback(err);
            }

            var block = dataFlow.block,
                fee = dataFlow.fee,
                totalOutputs = dataFlow.totalOutputs,
                currentDate = new Date();

            currentDate.setDate(currentDate.getDate() - 1);
            var minTimestamp = currentDate.getTime() / 1000,
                maxAge = (block.header.time - minTimestamp) * 1000;

            if (maxAge > 0) {
                self.blocksByHeight.set(blockHeight, block, maxAge);
                self.feeByHeight.set(blockHeight, fee, maxAge);
                self.outputsByHeight.set(blockHeight, totalOutputs, maxAge);
            }
            var date = new Date(block.header.time * 1000),
                formattedDate = self.formatTimestamp(date),
                cachedStatisticDay = self.statisticByDays.get(formattedDate);

            if (!cachedStatisticDay) {
                cachedStatisticDay = {
                    totalTransactionFees: {
                        sum: 0,
                        count: 0
                    }, numberOfTransactions: {
                        count: 0
                    }, totalOutputVolume: {
                        sum: 0
                    }, totalBlocks: {
                        count: 0
                    }, difficulty: {
                        sum: 0,
                        count: 0
                    }
                }
            }

            cachedStatisticDay.totalTransactionFees.sum += fee;
            cachedStatisticDay.totalTransactionFees.count += 1;
            cachedStatisticDay.totalBlocks.count += 1;
            cachedStatisticDay.numberOfTransactions.count += block.transactions.length;
            cachedStatisticDay.totalOutputVolume.sum += totalOutputs;
            cachedStatisticDay.difficulty.sum += block.header.getDifficulty();
            cachedStatisticDay.difficulty.count += 1;

            self.statisticByDays.set(formattedDate, cachedStatisticDay);
            return callback();
        });
    }, function (err) {
        if (err) {
            self.common.log.error('[Statistic] Update Error', err);
            return false;
        }

        self.lastCheckedBlock = height;
        return next();
    });
};

StatisticController.prototype._rapidProtectedUpdateTip = function (heigh) {
    var self = this;

    this.lastTipHeight = heigh;
    if (this.lastTipInProcess) {
        return false;
    }

    this.lastTipInProcess = true;
    
    return this._getLastBlocks(heigh, function () {
        self.lastTipInProcess = false;

        if (self.lastTipHeight !== heigh) {
            self._rapidProtectedUpdateTip(self.lastTipHeight);
        }
    });
};

module.exports = StatisticController;