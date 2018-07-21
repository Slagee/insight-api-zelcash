var BigNumber = require('bignumber.js');

module.exports = {
    getTotalSupplyByHeight: function (height) {
        return (new BigNumber(0)).plus((height) * 5000);
    }
};