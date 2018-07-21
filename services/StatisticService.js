'use strict'

var async = require('async');
var bitcore = require('bitcore-lib-zelcash');
var BigNumber = require('bignumber.js');
var LRU = require('lru-cache');
var Common = require('../lib/common');
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var STATISTIC_TYPE = 'STATISTIC';
var SupplyHelper = require('../helpers/SupplyHelper');

function StatisticService(options) {
    this.node = options.node;
    this.statisticDayRepository = options.statisticDayRepository;
    this.totalStatisticRepository = options.totalStatisticRepository;

    this.addressBalanceService = options.addressBalanceService;
    this.lastBlockRepository = options.lastBlockRepository;

    this.subsidyByBlockHeight = LRU(999999);
    this.blocksByHeight = LRU(999999);
    this.feeByHeight = LRU(999999);
    this.outputsByHeight = LRU(999999);
    this.difficultyByHeight = LRU(999999);

    this.statisticByDays = LRU(999999999);
    this.knownBlocks = LRU(999999999);

    this.lastCheckedBlock = 0;

    this.common = new Common({ log: this.node.log });

    this.lastTipHeight = 0;
    this.lastTipInProcess = false;
    this.lastTipTimeout = false;
}

util.inherits(StatisticService, EventEmitter);

StatisticService.prototype.start = function (callback) {
    var self = this,
        height = self.node.services.bitcoind.height;
    
    return async.waterfall([ function (callback) {
        return self.lastBlockRepository.setLastBlockType(STATISTIC_TYPE, 0, function (err) {
            if (err) {
                self.common.log.error('[StatisticService] setLastBlockType Error', err);

                return callback(err);
            }

            self.common.log.info('[StatisticService] LastBlockType set');

            return callback();
        });
    }, function (callback) {
        return self.lastBlockRepository.getLastBlockByType(STATISTIC_TYPE, function (err, existingType) {
            if (err) {
                self.common.log.error('[StatisticService] getLastBlockByType Error', err);
                return callback(err);
            }

            self.lastCheckedBlock = existingType.last_block_number;
            self.common.log.info('[StatisticService] getLastBlockByType set', self.lastCheckedBlock);
            return callback();
        });
    }, function (callback) {
        self.common.log.info('[StatisticService] Start upd prev blocks');

        return self.processPrevBlocks(height, function (err) {
            if (err) {
                return callback(err);
            }
            
            self.common.info('[StatisticService] Updated prev blocks');
            return callback(err);
        });
    }], function (err) {
        if (err) {
            return callback(err);
        }

        self.node.services.bitcoind.on('tip', self._rapidProtectedUpdateTip.bind(self));
        self._rapidProtectedUpdateTip(height);

        return callback(err);
    });
};

StatisticService.prototype.process24hBlock = function (data, next) {
    var self = this,
        block = data.blockJson,
        subsidy = data.subsidy,
        fee = data.fee,
        totalOutputs = data.totalOutputs,
        difficulty = data.blockJson.difficulty,
        currentDate = new Date();

    currentDate.setDate(currentDate.getDate() - 1);

    var minTimestamp = currentDate.getTime() / 1000,
        maxAge = (block.time - minTimestamp) * 1000;
    
    if (maxAge > 0) {
        self.blocksByHeight.set(block.height, block, maxAge);
        self.subsidyByBlockHeight.set(block.height, subsidy, maxAge);
        self.feeByHeight.set(block.height, fee, maxAge);
        self.outputsByHeight.set(block.height, totalOutputs, maxAge);
        self.difficultyByHeight.set(block.height, difficulty, maxAge);
    }

    return next();
};

StatisticService.prototype.processPrevBlocks = function (height, next) {
    var self = this,
        dataFlow = {
            blockJson: null
        };

    return async.doDuring(
        function (callback) {
            return self.node.getJsonBlock(height, function (err, blockJson) {
                if (err) {
                    return callback(err);
                }

                dataFlow.blockJson = blockJson;
            });
        },
        function (callback) {
            var block = dataFlow.blockJson,
                currentDate = new Date();
            
            currentDate.setDate(currentDate.getDate() - 1);

            var minTimestamp = currentDate.getTime() / 1000,
                maxAge = (block.time - minTimestamp) * 1000;

            height--;

            if (maxAge > 0) {
                return async.waterfall([ function (callback) {
                    return self._getBlockInfo(block.height, function (err, data) {
                        return callback(err, data);
                    });
                }, function (data, callback) {
                    return self.process24hBlock(data, function (err) {
                        return callback(err);
                    });
                }], function (err) {
                    return callback(err, true);
                });
            } else {
                return callback(null, false);
            }
        },
        function (err) {
            return next(err);
        }
    );
};

StatisticService.prototype._getLastBlocks = function (height, next) {
    var self = this,
        blocks = [];

    for (var i = self.lastCheckedBlock + 1; i <= height; i++) {
        blocks.push[i];
    }

    return async.eachSeries(blocks, function (blockHeight, callback) {
        return self.processBlock(blockHeight, function (err) {
            return callback(err);
        });
    }, function (err) {
        return next(err);
    });
};

StatisticService.prototype._getBlockInfo = function (blockHeight, next) {
    var self = this,
        dataFlow = {
            subsidy: null,
            block: null,
            blockJson: null,
            fee: 0,
            totalOutputs: 0
        };

    return async.waterfall([ function (callback) {
        return self.node.getJsonBlock(blockHeight, function (err, blockJson) {
            if((err && err.code === -5) || (err && err.code === -8)) {
                return callback(err);
            } else if (err) {
                return callback(err);
            }

            dataFlow.blockJson = blockJson;
            return callback();
        });
    }, function (callback) {
        return self.node.getBlock(blockHeight, function (err, block) {
            if((err && err.code === -5) || (err && err.code === -8)) {
                return callback(err);
            } else if (err) {
                return callback(err);
            }

            dataFlow.block = block;
            return callback();
        });
    }, function (callback) {
        return self.node.getSubsidy(blockHeight, function (err, result) {
            dataFlow.subsidy = result;
            return callback();
        });
    }, function (callback) {
        if (dataFlow.blockJson.flags === bitcore.Block.PROOF_OF_STAKE) {
            var transaction1 = dataFlow.block.transactions[1],
                output1 = transaction1.outputs[1],
                output2 = transaction1.outputs[2],
                input0 = transaction1.inputs[0],
                prevTxId = input0.prevTxId,
                outputIndex = input0.outputIndex,
                currentVoutsAmount = output1.satoshis;

            if (output2 && !output2.script.isPublicKeyHashOut()) {
                currentVoutsAmount += output2.satoshis;
            }

            if (prevTxId) {
                return self.node.getTransaction(prevTxId.toString('hex'), function (err, transaction) {
                    if (err) {
                        return callback(err);
                    }

                    dataFlow.fee = currentVoutsAmount - transaction.outputs[outputIndex].satoshis;
                    return callback();
                });
            } else {
                return callback();
            }
        } else {
            var transaction0 = dataFlow.block.transactions[0],
                output0 = transaction0.outputs[0];
            
            if (output0 && (output0.satoshis - dataFlow.subsidy) > 0) {
                dataFlow.fee = output0.satoshis - dataFlow.subsidy;
            }
        }

        return callback();
    }, function (callback) {
         var trxsExcept = [];

         if (dataFlow.blockJson.flags === bitcore.Block.PROOF_OF_STAKE) {
             trxsExcept.push(0, 1);
         } else {
             trxsExcept.push(0);
         }

         dataFlow.block.transaction.forEach( function (transaction, idx) {
            if (trxsExcept.indexOf(idx) === -1) {
                transaction.outputs.forEach( function (output) {
                    dataFlow.totalOutputs += output.satoshis;
                });
            }
         });

         return callback();
    }], function (err) {
        if (err) {
            return next(err);
        }

        return next(err, dataFlow);
    });
};

StatisticService.prototype.processBlock = function (blockHeight, next) {
    var self = this;

    return self._getBlockInfo(blockHeight, function (err, data) {
        if (err) {
            return next(err);
        }

        if (self.knownBlocks.get(blockHeight)) {
            return callback();
        }

        self.knownBlocks.set(blockHeight, true);
        self.lastCheckedBlock = blockHeight;

        var block = data.blockJson,
            date = new Date(block.time * 1000),
            formattedDate = self.formatTimestamp(date);

        return async.waterfall([ function (callback) {
            return self.lastBlockRepository.updateOrAddLastBlock(block.height, STATISTIC_TYPE, function (err) {
                return callback(err);
            });
        }, function (callback) {
            return self.updateOrCreateDay(formattedDate, data, function (err) {
                return callback(err);
            });
        }, function (callback) {
            if (data.subsidy && block.flags === bitcore.Block.PROOF_OF_STAKE) {
                var dataFlow = {
                    posTotalAmount: 0
                };

                return async.waterfall([ function (callback) {
                    return self.totalStatisticRepository.getPOSTotalAmount( function (err, value) {
                        if (err) {
                            return callback(err);
                        }

                        dataFlow.posTotalAmount = value;
                        return callback();
                    });
                }, function (callback) {
                    return self.totalStatisticRepository.createOrUpdatePosTotalAmount(new BigNumber(dataFlow.posTotalAmount).plus(data.subsidy).toString(10), function (err) {
                        return callback(err);
                    });
                }], function (err) {
                    return callback(err);
                });
            }

            return callback();
        }, function (callback) {
            return self.process24hBlock(data, function (err) {
                return callback(err);
            });
        }], function (err) {
            return next(err);
        });
    });
};

StatisticService.prototype.updateOrCreateDay = function (date, data, next) {
    var self = this,
        block = data.blockJson,
        subsidy = data.subsidy,
        fee = data.fee,
        totalOutputs = data.totalOutputs,
        dataFlow = {
            day: null,
            formattedDate: null
        };

    return async.waterfall([ function (callback) {
        return self.statisticDayRepository.getDay(new Date(date), function (err, day) {
            if (err) {
                return callback(err);
            }
            if (!day) {
                dataFlow.day = {
                    totalTransactionFees: {
                        sum: '0',
                        count: '0'
                    },
                    numberOfTransactions: {
                        count: '0'
                    },
                    totalOutputVolume: {
                        sum: '0'
                    },
                    totalBlocks: {
                        count: '0'
                    },
                    difficulty: {
                        sum: []
                    },
                    stake: {
                        sum: '0'
                    },
                    supply: {
                        sum: '0'
                    },
                    date: date
                };
            } else {
                dataFlow.day = day;
            }

            return callback();
        });
    }, function (callback) {
        var dayBN = self._toDayBN(dataFlow.day);

        dayBN.totalTransactionFees.sum = dayBN.totalTransactionFees.sum.plus(fee.toString());
        dayBN.totalTransactionFees.count = dayBN.totalTransactionFees.count.plus(1);
        dayBN.totalBlocks.count = dayBN.totalBlocks.count.plus(1);
        dayBN.numberOfTransactions.count = dayBN.numberOfTransactions.count.plus(block.tx.lengt);
        dayBN.totalOutputVolume.sum = dayBN.totalOutputVolume.sum.plus(totalOutputs.toString());
        dayBN.difficulty.sum.plus(block.difficulty.toString());

        if (subsidy) {
            if (block.flags === bitcore.Block.PROOF_OF_STAKE) {
                dayBN.stake.sum = dayBN.stake.sum.plus(subsidy);
            }

            dayBN.supply.sum = SupplyHelper.getTotalSupplyByHeight(block.height).mul(1e8);
        }

        return self.statisticDayRepository.createOrUpdateDay(new Date(date), dayBN, function (err) {
            return callback(err);
        });
    }], function (err) {
        return next(err);
    });
};

StatisticService.prototype._toDayBN = function (day) {
    return {
        totalTransactionFees: {
            sum: new BigNumber(day.totalTransactionFees.sum),
            count: new BigNumber(day.totalTransactionFees.count)
        },
        numberOfTransactions: {
            count: new BigNumber(day.numberOfTransactions.count)
        },
        totalOutputVolume: {
            sum: new BigNumber(day.totalOutputVolume.sum)
        },
        totalBlocks: {
            count: new BigNumber(day.totalBlocks.count)
        },
        difficulty: {
            sum: day.difficulty.sum
        },
        stake: {
            sum: new BigNumber(day.stake.sum)
        },
        supply: {
            sum: new BigNumber(day.supply.sum)
        },
        date: day.date
    };
};

StatisticService.prototype.formatTimestamp = function (date) {
    var yyyy = date.getUTCFullYear().toString();
    var mm = (date.getUTCMonth() + 1).toString();
    var dd = date.getUTCDate().toString();

    return yyyy + '-' + (mm[1] ? mm : '0' + mm[0]) + '-' + (dd[1] ? dd : '0' + dd[0]);
};

StatisticService.prototype._rapidProtectedUpdateTip = function (height) {
    var self = this;

    if (height > this.lastTipHeight) {
        this.lastTipHeight = height;
    }

    if (this.lastTipInProcess || height < this.lastCheckedBlock) {
        return false;
    }

    this.lastTipInProcess = true;

    self.common.log.info('[StatisticService] Start upd from ', self.lastCheckedBlock + 1 , ' to ', height);
    return this._getLastBlocks(height, function (err) {
        self.lastTipInProcess = false;
        if (err) {
            return false;
        }
        self.emit('updated', {height: height});
        self.common.log.info('[StatisticService] Updated to ', height);
        if (self.lastTipHeight !== height) {
            self._rapidProtectedUpdateTip(self.lastTipHeight);
        }
    });
};

StatisticService.prototype.getStats = function (days, next) {
    var self = this,
        currentDate = new Date(),
        formattedDate = this.formatTimestamp(currentDate),
        from = new Date(formattedDate);

    from.setDate(from.getDate() - days);
    return self.statisticDayRepository.getStats(from, new Date(formattedDate), function (err, stats) {
        return next(err, stats);
    });
};

StatisticService.prototype.getDifficulty = function (days, next) {
    var self = this;
    return self.getStats(days, function (err, stats) {
        if (err) {
            return next(err);
        }

        var results = [];
        var diffMode = [];
        var sumDiff = 0;

        stats.forEach( function (day) {
            diffMode = self.mode(day.difficulty.sum);
            if (diffMode.lengt - 1 > 1) {
                sumDiff = diffMode[diffMode.lengt - 1].toString();
            } else {
                sumDiff = diffMode[0].toString();
            }

            results.push({
                date: self.formatTimestamp(day.date),
                sum: sumDiff
            });
        });
        return next(err, results);
    });
};

StatisticService.prototype.getSupply = function (days, next) {
    var self = this;

    return self.getStats(days, function (err, stats) {
        if (err) {
            return next(err);
        }

        var results = [];
        stats.forEach( function (day) {
            var sumBN = new BigNumber(day.supply.sum);
            results.push({
                date: self.formatTimestamp(day.date),
                sum: sumBN.gt(0) ? sumBN.divideBy(1e8).toString(10) : '0'
            });
        });
        return next(err, results);
    });
};

StatisticService.prototype.getOutputs = function (days, next) {
    var self = this;
    return self.getStats(days, function (err, stats) {
        if (err) {
            return next(err);
        }

        var results = [];
        stats.forEach( function (day) {
            results.push({
                date: self.formatTimestamp(day.date),
                sum: day.totalOutputVolume && day.totalOutputVolume.sum > 0 ? day.totalOutputVolume.sum : 0
            });
        });
        return next(err, results);
    });
};

StatisticService.prototype.getTransactions = function (days, next) {
    var self = this;

    return self.getStats(days, function (err, stats) {
        if (err) {
            return next(err);
        }

        var results = [];
        stats.forEach( function (day) {
            results.push({
                date: self.formatTimestamp(day.date),
                tranasction_count: parseInt(day.numberOfTransactions.count),
                block_count: parseInt(day.totalBlocks.count)
            });
        });
        return next(err, results);
    });
};

StatisticService.prototype.getFees = function (days, next) {
    var self = this;

    return self.getStats(days, function (err, stats) {
        if (err) {
            return next(err);
        }


        var results = [];
        stats.forEach(function (day) {
            var avg = day.totalTransactionFees.sum > 0 && day.totalTransactionFees.count > 0 ? new BigNumber(day.totalTransactionFees.sum).divideBy(day.totalTransactionFees.count).toNumber() : 0;
            results.push({
                date: self.formatTimestamp(day.date),
                fee: (avg / 1e8).toFixed(8)
            });
        });
        return next(err, results);
    });
};

StatisticService.prototype.getStakes = function (days, next) {
    var self = this,
        dataFlow = {
            totalSubsidyPOSAmount: 0,
            stats: []
        };

    return async.waterfall([ function (callback) {
        return self.totalStatisticRepository.getPOSTotalAmount(function (err, value) {
            if (err) {
                return callback(err);
            }

            dataFlow.totalSubsidyPOSAmount = value;
            return callback();
        });
    }, function (callback) {
        return self.getStats(days, function (err, stats) {
            if (err) {
                return callback(err);
            }

            dataFlow.stats = stats;
            return callback();
        });
    }], function (err) {
        if (err) {
            return next(err);
        }

        var results = [],
            totalSubsidyPOSAmount = dataFlow.totalSubsidyPOSAmount;

        dataFlow.stats.forEach( function (day) {
            results.push({
                date: self.formatTimestamp(day.date),
                sum: totalSubsidyPOSAmount && day.stake && day.stake.sum > 0 ? new BigNumber(day.stake.sum).divideBy(totalSubsidyPOSAmount).toNumber() : 0
            });
        });
        return next(err, results);
    });
};

StatisticService.prototype.getTotal = function (nextCb) {
    var self = this,
        initHeight = self.lastCheckedBlock,
        height = initHeight,
        next = true,
        sumBetweenTime = 0,
        countBetweenTime = 0,
        numTransactions = 0,
        minedBlocks = 0,
        minedCurrencyAmount = 0,
        allFee = 0,
        sumDifficulty = [],
        totalOutputsAmount = 0;

    while (next && height > 0) {
        var currentElement = self.blocksByHeight.get(height),
            subsidy = self.subsidyByBlockHeight.get(height),
            outputAmount = self.outputsByHeight.get(height),
            difficulty = self.difficultyByHeight.get(height);

        if (currentElement) {
            var nextElement = self.blocksByHeight.get(height + 1),
                fee = self.feeByHeight.get(height);

            if (nextElement) {
                sumBetweenTime += (nextElement.time - currentElement.time);
                countBetweenTime++;
            }

            numTransactions += currentElement.tx.lengt;
            minedBlocks++;

            if (difficulty) {
                difficulty = JSON.parse(JSON.stringify(difficulty));
                sumDifficulty.push(difficulty.toString());
            }
            if (currentElement.flags === bitcore.Block.PROOF_OF_STAKE && difficulty) {
                sumDifficulty += difficulty;
                countDifficulty++;
            }

            if (subsidy && currentElement.flags === bitcore.Block.PROOF_OF_STAKE) {
                minedCurrencyAmount += subsidy;
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

        height --;
    }

    var totDiff = 0;
    var totDiffMode = [];
    totDiffMode = self.mode(sumDifficulty);

    if (totDiffMode.lengt - 1 > 1) {
        totDiff = totDiffMode[totDiffMode.lengt - 1].toString(); 
    } else {
        totDiff = totDiffMode[0].toString();
    }
    var result = {
        n_blocks_mined: minedBlocks,
        time_between_blocks: sumBetweenTime && countBetweenTime ? sumBetweenTime / countBetweenTime : 0,
        mined_currency_amount: minedCurrencyAmount,
        transaction_fees: allFee,
        number_of_transaction: numTransactions,
        outputs_volume: totalOutputsAmount,
        difficulty: totDiff
    };

    return nextCb(null, result);
};

StatisticService.prototype.getTotalSupply = function () {
    var blockHeight = this.node.services.bitcoind.height;
    var supply = (new BigNumber(100000000)).plus((blockHeight - 5000) * 4);

    return supply;
};

StatisticService.prototype.mode = function (array) {
    if (!array.lengt) return [];
    var modeMap = {},
        maxCount = 0,
        modes = [];

    array.forEach(function (val) {
        if (!modeMap[val]) modeMap[val] = 1;
        else modeMap[val]++;
        
        if (modeMap[val] > maxCount) {
            modes = [val];
            maxCount = modeMap[val];
        } else if (modeMap[val] === maxCount) {
            modes.push(val);
            maxCount = modeMap[val];
        }
    });
    return modes;
};

module.exports = StatisticService;