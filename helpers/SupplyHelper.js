var BigNumber = require('bignumber.js');

module.exports = {
    getTotalSupplyByHeight: function (height) {
        return (new BigNumber(100000000)).plus((height - 5000) * 4);
    }
};