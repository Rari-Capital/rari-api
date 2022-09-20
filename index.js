const port = process.env.HTTP_PORT || 3000;
const express = require("express");
const asyncHandler = require("express-async-handler");
const cors = require('cors');
const Web3 = require("web3");
const web3 = new Web3(new Web3.providers.HttpProvider(process.env.WEB3_HTTP_PROVIDER_URL));
const web3WithLogs = new Web3(new Web3.providers.HttpProvider(process.env.WEB3_HTTP_PROVIDER_LOGS_URL));
const web3WithArchive = new Web3(new Web3.providers.HttpProvider(process.env.WEB3_HTTP_PROVIDER_ARCHIVE_URL));
const axios = require("axios");
const app = express();
const Big = require('big.js');

const POOL_KEYS = ["stable", "yield", "ethereum", "dai"];
const POOL_TOKEN_KEYS = { "stable": "rspt", "yield": "rypt", "ethereum": "rept", "dai": "rdpt" };
const POOL_INCEPTION_BLOCKS = {
    "stable": 10365607, // First deposit ever
    "yield": 11095700, // 11095700 is close enough
    "ethereum": 11095700, // 11095700 is close enough
    "dai": 11441321 // Block original RariFundController was deployed at
};
const POOL_INCEPTION_TIMESTAMPS = { // Currently only used for Stable Pool
    "stable": 1593499687, // First deposit ever
};

const POOL_BALANCE_DOWN_AT_BLOCKS = {
  "stable": [
    [11821050, 11821087],
    [10458017, 10458037],
    [12909767, 12909767],
  ],
  "yield": [
    [11854021, 11854027],
    [12904354, 12904355],
  ],
  "ethereum": [
    [11819250, 11819255],
    [12168303, 12168536],
    [12395227, 12396284], // TODO: Fix incorrect data from blocks 12396285 to 12904200
    [12904333, 12904334],
    [12904645, 12904647],
  ],
  "dai": [
    [12904269, 12904271],
    [12904287, 12904288]
  ],
};

function getBestFundBalanceBlockNumber(poolKey, i) {
    if (POOL_BALANCE_DOWN_AT_BLOCKS[poolKey] !== undefined) for (const pair of POOL_BALANCE_DOWN_AT_BLOCKS[poolKey]) if (i >= pair[0] && i <= pair[1]) return pair[0] - 1;
    return i;
}

app.use(cors({ origin: process.env.ACCESS_CONTROL_ALLOW_ORIGIN }));
app.use(express.json());

function calculateApyBN(startTimestamp, startRsptExchangeRate, endTimestamp, endRsptExchangeRate) {
    const SECONDS_PER_YEAR = 365 * 86400;
    var timeDiff = endTimestamp - startTimestamp;
    return Web3.utils.toBN((new Big((((endRsptExchangeRate.toString() / startRsptExchangeRate.toString()) ** (SECONDS_PER_YEAR / timeDiff)) - 1) * 1e18)).toFixed(0));
}

function getRgtDistributed(blockNumber) {
  var startBlock = parseInt(process.env.DISTRIBUTION_START_BLOCK);
  if (blockNumber <= startBlock) return web3.utils.toBN(0);
  if (blockNumber >= startBlock + 390000) return web3.utils.toBN(8750000).mul(web3.utils.toBN(1e18));
  var blocks = blockNumber - startBlock;
  if (blocks < 6500 * 15)
    return web3.utils.toBN(1e18).mul(web3.utils.toBN(blocks).pow(web3.utils.toBN(2))).divn(2730)
      .add(web3.utils.toBN("1450000000000000000000").muln(blocks).divn(273));
  if (blocks < 6500 * 30)
    return web3.utils.toBN("14600000000000000000000").muln(blocks).divn(273)
      .sub(web3.utils.toBN("2000000000000000000").mul(web3.utils.toBN(blocks).pow(web3.utils.toBN(2))).divn(17745))
      .sub(web3.utils.toBN("1000000000000000000000000").divn(7));
  if (blocks < 6500 * 45)
    return web3.utils.toBN(1e18).mul(web3.utils.toBN(blocks).pow(web3.utils.toBN(2))).divn(35490)
      .add(web3.utils.toBN("39250000000000000000000000").divn(7))
      .sub(web3.utils.toBN("950000000000000000000").muln(blocks).divn(273));
  return web3.utils.toBN(1e18).mul(web3.utils.toBN(blocks).pow(web3.utils.toBN(2))).divn(35490)
    .add(web3.utils.toBN("34750000000000000000000000").divn(7))
    .sub(web3.utils.toBN("50000000000000000000").muln(blocks).divn(39));
}

async function getRgtPrice() {
    // TODO: RGT price getter function from CoinGecko
    /* try {
        return Web3.utils.toBN(Math.trunc((await axios.get("https://api.coingecko.com/api/v3/simple/price?vs_currencies=usd&ids=rgt")).data.rgt.usd * 1e18));
    } catch (error) {
        throw "Error retrieving data from CoinGecko API: " + error;
    } */

    try {
        var data = (await axios.post("https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v2", { query: `{
          ethRgtPair: pair(id: "0xdc2b82bc1106c9c5286e59344896fb0ceb932f53") {
            token0Price
          }
          ethUsdtPair: pair(id: "0x0d4a11d5eeaac28ec3f61d100daf4d40471f1852") {
            token1Price
          }
        }` })).data;
        
        return Web3.utils.toBN(Math.trunc(data.data.ethRgtPair.token0Price * data.data.ethUsdtPair.token1Price * 1e18));
    } catch (error) {
        throw "Error retrieving data from The Graph API: " + error;
    }
}

app.get("/governance/rgt/price", asyncHandler(async (req, res, next) => {
    return res.status(200).json((await getRgtPrice()).toString());
}));

app.get("/test", asyncHandler(async (req, res, next) => {
    return res.status(200).json({hello: "world"});
}));

var ethUsdPrice = getEthPrice();

async function getEthPrice() {
    try {
        return Web3.utils.toBN((new Big((await axios.get("https://api.coingecko.com/api/v3/simple/price?vs_currencies=usd&ids=ethereum")).data.ethereum.usd)).mul(1e18).toFixed(0));
    } catch (error) {
        throw "Error retrieving data from Coingecko API: " + error;
    } 
}

app.get("/governance/rgt/apy", asyncHandler(async (req, res, next) => {
    // Get latest fund balances
    try {
        var latest = await db.collection('blocks').find({}, { number: 1, timestamp: 1, stablePoolBalance: 1, yieldPoolBalance: 1, ethereumPoolBalance: 1 }).sort({ timestamp: -1 }).limit(1).toArray();
    } catch (error) {
        console.error("Failed to get latest fund balances:", error);
        return res.status(500).send();
    }

    // Get APY from difference in distribution over last 270 blocks (estimating a 1 hour time difference)
    var rgtDistributedPastHour = getRgtDistributed(latest[0].number).sub(getRgtDistributed(latest[0].number - 270));
    var ethereumPoolBalanceUsdBN = latest[0].ethereumPoolBalance !== undefined ? Web3.utils.toBN(latest[0].ethereumPoolBalance).mul(await getEthPrice()).div(Web3.utils.toBN(1e18)) : Web3.utils.toBN(0);
    var yieldPoolBalanceBN = latest[0].yieldPoolBalance !== undefined ? Web3.utils.toBN(latest[0].yieldPoolBalance) : Web3.utils.toBN(0);
    var fundBalanceSum = Web3.utils.toBN(latest[0].stablePoolBalance).add(yieldPoolBalanceBN).add(ethereumPoolBalanceUsdBN);
    var rgtDistributedPastHourPerUsd = rgtDistributedPastHour.mul(Web3.utils.toBN(1e18)).div(fundBalanceSum);
    var rgtDistributedPastHourPerUsdInUsd = rgtDistributedPastHourPerUsd.mul(await getRgtPrice()).div(Web3.utils.toBN(1e18));
    /// console.log("QQQ", rgtDistributedPastHour.toString() / 1e18, fundBalanceSum.toString(), rgtDistributedPastHourPerUsd.toString(), rgtDistributedPastHourPerUsdInUsd.toString());
    return res.status(200).json(calculateApyBN(latest[0].timestamp - 3600, Web3.utils.toBN(1e18), latest[0].timestamp, Web3.utils.toBN(1e18).add(rgtDistributedPastHourPerUsdInUsd)).toString()); // return res.status(200).json(rgtDistributedPastHourPerUsdInUsd.muln(24 * 365).toString());
}));

app.get("/balances", asyncHandler(async (req, res, next) => {
    // TODO: Add other fund balances (taking into account ETH pricing)
    var timestamp = req.query && req.query.timestamp !== undefined && req.query.timestamp !== 'latest' ? Math.min(req.query.timestamp, Math.trunc((new Date()).getTime() / 1000)) : Math.trunc((new Date()).getTime() / 1000);

    try {
        var closestAbove = await db.collection('blocks').find({ timestamp: { $gte: timestamp } }, { number: 1, timestamp: 1, stablePoolBalance: 1, yieldPoolBalance: 1, ethereumPoolBalance: 1 }).sort({ timestamp: 1 }).limit(1).toArray();
        var closestBelow = await db.collection('blocks').find({ timestamp: { $lte: timestamp } }, { number: 1, timestamp: 1, stablePoolBalance: 1, yieldPoolBalance: 1, ethereumPoolBalance: 1 }).sort({ timestamp: -1 }).limit(1).toArray();
        var closestBlock = closestAbove[0] && (!closestBelow[0] || closestAbove[0].timestamp - timestamp <= timestamp - closestBelow[0].timestamp) ? closestAbove[0] : closestBelow[0];
    } catch (error) {
        console.error("Failed to get fund balances:", error);
        return res.status(500).send();
    }

    return res.status(200).json(closestBlock);
}));

app.get("/tvl", asyncHandler(async (req, res, next) => {
    // TODO: Add other fund balances (taking into account ETH pricing)
    var timestamp = req.query && req.query.timestamp !== undefined && req.query.timestamp !== 'latest' ? Math.min(req.query.timestamp, Math.trunc((new Date()).getTime() / 1000)) : Math.trunc((new Date()).getTime() / 1000);

    try {
        var closestAbove = await db.collection('blocks').find({ timestamp: { $gte: Math.trunc((new Date()).getTime() / 1000) } }, { number: 1, timestamp: 1, stablePoolBalance: 1, yieldPoolBalance: 1, ethereumPoolBalance: 1 }).sort({ timestamp: 1 }).limit(1).toArray();
        var closestBelow = await db.collection('blocks').find({ timestamp: { $lte: Math.trunc((new Date()).getTime() / 1000) } }, { number: 1, timestamp: 1, stablePoolBalance: 1, yieldPoolBalance: 1, ethereumPoolBalance: 1 }).sort({ timestamp: -1 }).limit(1).toArray();
        var closestBlock = closestAbove[0] && (!closestBelow[0] || closestAbove[0].timestamp - timestamp <= timestamp - closestBelow[0].timestamp) ? closestAbove[0] : closestBelow[0];
    } catch (error) {
        console.error("Failed to get fund balances:", error);
        return res.status(500).send();
    }

    var ethereumPoolBalanceUsdBN = closestBlock.ethereumPoolBalance !== undefined ? Web3.utils.toBN(closestBlock.ethereumPoolBalance).mul(await getEthPrice()).div(Web3.utils.toBN(1e18)) : Web3.utils.toBN(0);
    var yieldPoolBalanceBN = closestBlock.yieldPoolBalance !== undefined ? Web3.utils.toBN(closestBlock.yieldPoolBalance) : Web3.utils.toBN(0);
    var daiPoolBalanceBN = closestBlock.daiPoolBalance !== undefined ? Web3.utils.toBN(closestBlock.daiPoolBalance) : Web3.utils.toBN(0);
    var fundBalanceSum = Web3.utils.toBN(closestBlock.stablePoolBalance).add(yieldPoolBalanceBN).add(ethereumPoolBalanceUsdBN).add(daiPoolBalanceBN);
    return res.status(200).json(fundBalanceSum.toString());
}));

/* app.get("/pools/stable/history/apy", asyncHandler(async (req, res, next) => {
    // const values = require("dydx-aprs.json", "compound-aprs.json", "aave-aprs.json", "mstable-aprs.json");
    var ourData = {};

    var dydxAvgs = [];
    var epochs = Object.keys(values[0]).sort();

    for (var i = 0; i < epochs.length; i++) {
      // Calculate average for dYdX graph and max for our graph
      var sum = 0;
      var max = 0;

      for (const currencyCode of Object.keys(values[0][epochs[i]])) {
        sum += values[0][epochs[i]][currencyCode];
        if (values[0][epochs[i]][currencyCode] > max) max = values[0][epochs[i]][currencyCode];
      }

      dydxAvgs.push({ t: new Date(parseInt(epochs[i])), y: sum / Object.keys(values[0][epochs[i]]).length * 100 });

      // Add data for Rari graph
      var flooredEpoch = Math.floor(epochs[i] / 86400 / 1000) * 86400 * 1000;
      ourData[flooredEpoch] = max;
    }

    var compoundAvgs = [];
    var epochs = Object.keys(values[1]).sort();

    for (var i = 0; i < epochs.length; i++) {
      // Calculate average for Compound graph and max with COMP for our graph
      var sum = 0;
      var maxWithComp = 0;

      for (const currencyCode of Object.keys(values[1][epochs[i]])) {
        sum += values[1][epochs[i]][currencyCode][0];
        var apyWithComp = values[1][epochs[i]][currencyCode][0] + values[1][epochs[i]][currencyCode][1];
        if (apyWithComp > maxWithComp) maxWithComp = apyWithComp;
      }

      var avg = sum / Object.keys(values[1][epochs[i]]).length;
      compoundAvgs.push({ t: new Date(parseInt(epochs[i])), y: avg * 100 });

      // Add data for Rari graph
      var flooredEpoch = Math.floor(epochs[i] / 86400 / 1000) * 86400 * 1000;
      if (ourData[flooredEpoch] === undefined || maxWithComp > ourData[flooredEpoch]) ourData[flooredEpoch] = maxWithComp;
    }

    var aaveAvgs = [];
    var epochs = Object.keys(values[2]).sort();

    for (var i = 0; i < epochs.length; i++) {
      // Calculate average for dYdX graph and max for our graph
      var sum = 0;
      var max = 0;

      for (const currencyCode of Object.keys(values[2][epochs[i]])) {
        sum += values[2][epochs[i]][currencyCode];
        if (values[2][epochs[i]][currencyCode] > max) max = values[2][epochs[i]][currencyCode];
      }

      aaveAvgs.push({ t: new Date(parseInt(epochs[i])), y: sum / Object.keys(values[2][epochs[i]]).length * 100 });

      // Add data for Rari graph
      var flooredEpoch = Math.floor(epochs[i] / 86400 / 1000) * 86400 * 1000;
      if (ourData[flooredEpoch] === undefined || max > ourData[flooredEpoch]) ourData[flooredEpoch] = max;
    }

    if (!values[3] || !values[3].data) return console.error("Failed to decode exchange rates from The Graph when calculating mStable 24-hour APY");
    var mStableAvgs = [];
    
    for (var i = 1; i < mStableEpochs.length; i++) {
      // mStable graph
      // 1590759420 == timestamp of launch Twitter annoucement: https://twitter.com/sassal0x/status/1266362912920137734
      var apy = values[3].data["day" + (i - 1)][0] && values[3].data["day" + i][0] && mStableEpochs[365 - i] >= 1590759420 ? App.calculateMStableApyBN(mStableEpochs[365 - i], values[3].data["day" + (i - 1)][0].exchangeRate, mStableEpochs[364 - i], values[3].data["day" + i][0].exchangeRate).toString() / 1e18 : 0;
      mStableAvgs.push({ t: new Date(parseInt(mStableEpochs[364 - i]) * 1000), y: apy * 100 });

      // Add data for Rari graph
      var flooredEpoch = Math.floor(mStableEpochs[364 - i] / 86400) * 86400 * 1000;
      if (ourData[flooredEpoch] === undefined || apy > ourData[flooredEpoch]) ourData[flooredEpoch] = apy;
    }
})); */

app.get("/pools/:pool/apy", asyncHandler(async (req, res, next) => {
    if (!req.params || POOL_KEYS.indexOf(req.params.pool) < 0) return res.status(500).send();
    var poolKey = req.params.pool;
    var poolTokenKey = POOL_TOKEN_KEYS[poolKey];

    var toTimestamp = req.query && req.query.toTimestamp !== undefined ? Math.min(req.query.toTimestamp, Math.trunc((new Date()).getTime() / 1000)) : Math.trunc((new Date()).getTime() / 1000);
    var fromTimestamp = req.query && req.query.fromTimestamp !== undefined ? Math.max(req.query.fromTimestamp, POOL_INCEPTION_TIMESTAMPS.stable) : toTimestamp - 86400;

    var returnFields = { timestamp: 1 };
    returnFields[poolTokenKey + "ExchangeRate"] = 1;
    
    try {
        var closestAbove = await db.collection('blocks').find({ timestamp: { $gte: fromTimestamp } }, returnFields).sort({ timestamp: 1 }).limit(1).toArray();
        var closestBelow = await db.collection('blocks').find({ timestamp: { $lte: fromTimestamp } }, returnFields).sort({ timestamp: -1 }).limit(1).toArray();
        var closestBlock = closestAbove[0] && (!closestBelow[0] || closestAbove[0].timestamp - fromTimestamp <= fromTimestamp - closestBelow[0].timestamp) ? closestAbove[0] : closestBelow[0];
        var fromExchangeRate = Web3.utils.toBN(closestBlock[poolTokenKey + "ExchangeRate"] ? closestBlock[poolTokenKey + "ExchangeRate"] : 1e18);
    } catch (error) {
        console.error("Failed to get RSPT rates history:", error);
        return res.status(500).send();
    }
    
    try {
        var closestAbove = await db.collection('blocks').find({ timestamp: { $gte: toTimestamp } }, returnFields).sort({ timestamp: 1 }).limit(1).toArray();
        var closestBelow = await db.collection('blocks').find({ timestamp: { $lte: toTimestamp } }, returnFields).sort({ timestamp: -1 }).limit(1).toArray();
        var closestBlock = closestAbove[0] && (!closestBelow[0] || closestAbove[0].timestamp - toTimestamp <= toTimestamp - closestBelow[0].timestamp) ? closestAbove[0] : closestBelow[0];
        var toExchangeRate = Web3.utils.toBN(closestBlock[poolTokenKey + "ExchangeRate"] ? closestBlock[poolTokenKey + "ExchangeRate"] : 1e18);
    } catch (error) {
        console.error("Failed to get RSPT rates history:", error);
        return res.status(500).send();
    }

    var apyBN = calculateApyBN(fromTimestamp, fromExchangeRate, toTimestamp, toExchangeRate);
    // console.log("PPP", fromTimestamp, fromExchangeRate.toString()/1e18, toTimestamp, toExchangeRate.toString()/1e18, apyBN.toString());
    return res.status(200).json(apyBN.gt(Web3.utils.toBN(0)) ? apyBN.toString() : "0");
}));

app.get("/pools/:pool/apys", asyncHandler(async (req, res, next) => {
    if (!req.params || POOL_KEYS.indexOf(req.params.pool) < 0) return res.status(500).send();
    var poolKey = req.params.pool;
    var poolTokenKey = POOL_TOKEN_KEYS[poolKey];
    
    var fromTimestamp = req.query && req.query.fromTimestamp !== undefined ? Math.max(req.query.fromTimestamp, POOL_INCEPTION_TIMESTAMPS.stable) : POOL_INCEPTION_TIMESTAMPS.stable;
    var toTimestamp = req.query && req.query.toTimestamp !== undefined ? Math.min(req.query.toTimestamp, Math.trunc((new Date()).getTime() / 1000)) : Math.trunc((new Date()).getTime() / 1000);
    var intervalSeconds = req.query && req.query.intervalSeconds !== undefined ? req.query.intervalSeconds : 86400;
    
    var apys = [];
    lastExchangeRate = null;

    for (var i = fromTimestamp; i <= toTimestamp; i += intervalSeconds) {
        try {
            var returnFields = { block: 1, timestamp: 1 };
            returnFields[poolTokenKey + "ExchangeRate"] = 1;
            var closestAbove = await db.collection('blocks').find({ timestamp: { $gte: i } }, returnFields).sort({ timestamp: 1 }).limit(1).toArray();
            var closestBelow = await db.collection('blocks').find({ timestamp: { $lte: i } }, returnFields).sort({ timestamp: -1 }).limit(1).toArray();
            var closestBlock = closestAbove[0] && (!closestBelow[0] || closestAbove[0].timestamp - i <= i - closestBelow[0].timestamp) ? closestAbove[0] : closestBelow[0];
            if (lastExchangeRate !== null) apys.push({ blockNumber: closestBlock.number, timestamp: closestBlock.timestamp, apy: calculateApyBN(fromTimestamp, lastExchangeRate, toTimestamp, closestBlock[poolTokenKey + "ExchangeRate"]).toString() });
            lastExchangeRate = closestBlock[poolTokenKey + "ExchangeRate"];
        } catch (error) {
            console.error("Failed to get RSPT rates history:", error);
            return res.status(500).send();
        }
    }

    return res.status(200).json(apys);
}));

for (const poolKey of POOL_KEYS) {
    var poolTokenKey = POOL_TOKEN_KEYS[poolKey];
  
    app.get("/pools/" + poolKey + "/" + poolTokenKey + "/rate", asyncHandler(async (req, res, next) => {
        var poolTokenKey = POOL_TOKEN_KEYS[poolKey];
        
        var timestamp = req.query && req.query.timestamp !== undefined && req.query.timestamp !== 'latest' ? Math.min(req.query.timestamp, Math.trunc((new Date()).getTime() / 1000)) : Math.trunc((new Date()).getTime() / 1000);

        try {
            var returnFields = { timestamp: 1 };
            returnFields[poolTokenKey + "ExchangeRate"] = 1;
            var closestAbove = await db.collection('blocks').find({ timestamp: { $gte: timestamp } }, returnFields).sort({ timestamp: 1 }).limit(1).toArray();
            var closestBelow = await db.collection('blocks').find({ timestamp: { $lte: timestamp } }, returnFields).sort({ timestamp: -1 }).limit(1).toArray();
            var closestBlock = closestAbove[0] && (!closestBelow[0] || closestAbove[0].timestamp - timestamp <= timestamp - closestBelow[0].timestamp) ? closestAbove[0] : closestBelow[0];
        } catch (error) {
            console.error("Failed to get RSPT rate:", error);
            return res.status(500).send();
        }

        return res.status(200).json(closestBlock[poolTokenKey + "ExchangeRate"]);
    }));

    app.get(["/pools/" + poolKey + "/" + poolTokenKey + "/rates"], asyncHandler(async (req, res, next) => {
        var poolTokenKey = POOL_TOKEN_KEYS[poolKey];

        var fromTimestamp = req.query && req.query.fromTimestamp !== undefined ? Math.max(req.query.fromTimestamp, POOL_INCEPTION_TIMESTAMPS.stable) : POOL_INCEPTION_TIMESTAMPS.stable;
        var toTimestamp = req.query && req.query.toTimestamp !== undefined && req.query.toTimestamp !== 'latest' ? Math.min(req.query.toTimestamp, Math.trunc((new Date()).getTime() / 1000)) : Math.trunc((new Date()).getTime() / 1000);
        var intervalSeconds = req.query && req.query.intervalSeconds !== undefined ? req.query.intervalSeconds : 86400;
        
        var rates = [];
        var returnFields = { number: 1, timestamp: 1 };
        returnFields[poolTokenKey + "ExchangeRate"] = 1;

        for (var i = fromTimestamp; i <= toTimestamp; i += intervalSeconds) {
            try {
                var closestAbove = await db.collection('blocks').find({ timestamp: { $gte: i } }, returnFields).sort({ timestamp: 1 }).limit(1).toArray();
                var closestBelow = await db.collection('blocks').find({ timestamp: { $lte: i } }, returnFields).sort({ timestamp: -1 }).limit(1).toArray();
                var closestBlock = closestAbove[0] && (!closestBelow[0] || closestAbove[0].timestamp - i <= i - closestBelow[0].timestamp) ? closestAbove[0] : closestBelow[0];
                rates.push(closestBlock);
            } catch (error) {
                console.error("Failed to get RSPT rates history:", error);
                return res.status(500).send();
            }
        }

        // TODO: rates[i].blockNumber not rates[i].number; rate not rsptExchangeRate
        // TODO: Remove other fields
        return res.status(200).json(rates);
    }));
}

app.get("/pools/:pool/balances", asyncHandler(async (req, res, next) => {
    if (!req.params || POOL_KEYS.indexOf(req.params.pool) < 0) return res.status(500).send();
    var poolKey = req.params.pool;
    
    var fromTimestamp = req.query && req.query.fromTimestamp !== undefined ? Math.max(req.query.fromTimestamp, POOL_INCEPTION_TIMESTAMPS.stable) : POOL_INCEPTION_TIMESTAMPS.stable;
    var toTimestamp = req.query && req.query.toTimestamp !== undefined && req.query.toTimestamp !== 'latest' ? Math.min(req.query.toTimestamp, Math.trunc((new Date()).getTime() / 1000)) : Math.trunc((new Date()).getTime() / 1000);
    var intervalSeconds = req.query && req.query.intervalSeconds !== undefined ? req.query.intervalSeconds : 86400;
    
    var balances = [];
    var returnFields = { number: 1, timestamp: 1 };
    returnFields[poolKey + "PoolBalance"] = 1;

    for (var i = fromTimestamp; i <= toTimestamp; i += intervalSeconds) {
        try {
            var closestAbove = await db.collection('blocks').find({ timestamp: { $gte: i } }, returnFields).sort({ timestamp: 1 }).limit(1).toArray();
            var closestBelow = await db.collection('blocks').find({ timestamp: { $lte: i } }, returnFields).sort({ timestamp: -1 }).limit(1).toArray();
            var closestBlock = closestAbove[0] && (!closestBelow[0] || closestAbove[0].timestamp - i <= i - closestBelow[0].timestamp) ? closestAbove[0] : closestBelow[0];
            balances.push(closestBlock);
        } catch (error) {
            console.error("Failed to get fund balance history:", error);
            return res.status(500).send();
        }
    }

    // TODO: rates[i].blockNumber not rates[i].number; balance not fundBalance
    // TODO: Remove other fields
    return res.status(200).json(balances);
}));

app.get("/pools/:pool/balances/:account", asyncHandler(async (req, res, next) => {
    if (!req.params || POOL_KEYS.indexOf(req.params.pool) < 0) return res.status(500).send();
    var poolKey = req.params.pool;
    var poolTokenKey = POOL_TOKEN_KEYS[poolKey];

    if (!req.params || !req.params.account) return res.status(500).send();
    if (req.params.account === "0x0000000000000000000000000000000000000000") return res.status(200).json([]);

    var returnFields = { block: 1, timestamp: 1 };
    returnFields[poolTokenKey + "ExchangeRate"] = 1;

    // Get from block
    var fromBlock = req.query && req.query.fromBlock !== undefined ? parseInt(req.query.fromBlock) : 0;
    if (fromBlock < POOL_INCEPTION_BLOCKS[poolKey]) fromBlock = POOL_INCEPTION_BLOCKS[poolKey];
    var fromBlockData = null;

    if (req.query && req.query.fromTimestamp !== undefined) {
        var fromTimestamp = req.query.fromTimestamp !== 'latest' ? Math.min(req.query.fromTimestamp, Math.trunc((new Date()).getTime() / 1000)) : Math.trunc((new Date()).getTime() / 1000);

        try {
            var closestAbove = await db.collection('blocks').find({ timestamp: { $gte: fromTimestamp } }, returnFields).sort({ timestamp: 1 }).limit(1).toArray();
            var closestBelow = await db.collection('blocks').find({ timestamp: { $lte: fromTimestamp } }, returnFields).sort({ timestamp: -1 }).limit(1).toArray();
            var closestBlock = closestAbove[0] && (!closestBelow[0] || closestAbove[0].timestamp - fromTimestamp <= fromTimestamp - closestBelow[0].timestamp) ? closestAbove[0] : closestBelow[0];
            if (closestBlock && closestBlock.number) {
                fromBlock = closestBlock.number;
                fromBlockData = closestBlock;
            } else {
                console.error("Failed to get starting block");
                return res.status(500).send();
            }
        } catch (error) {
            console.error("Failed to get starting block:", error);
            return res.status(500).send();
        }
    } else try {
        fromBlockData = await db.collection('blocks').findOne({ number: fromBlock }, returnFields);
        if (!fromBlockData) {
            console.error("Failed to get starting block #" + fromBlock + ":", error);
            return res.status(500).send();
        }
    } catch (error) {
        console.error("Failed to get starting block #" + fromBlock);
        return res.status(500).send();
    }

    // Get to block
    var toBlock = req.query && req.query.toBlock !== undefined && req.query.toBlock !== 'latest' ? parseInt(req.query.toBlock) : 'latest';
    var toBlockData = null;

    if (req.query && req.query.toTimestamp !== undefined) {
        var toTimestamp = req.query.toTimestamp !== 'latest' ? Math.min(req.query.toTimestamp, Math.trunc((new Date()).getTime() / 1000)) : Math.trunc((new Date()).getTime() / 1000);

        try {
            var closestAbove = await db.collection('blocks').find({ timestamp: { $gte: toTimestamp } }, returnFields).sort({ timestamp: 1 }).limit(1).toArray();
            var closestBelow = await db.collection('blocks').find({ timestamp: { $lte: toTimestamp } }, returnFields).sort({ timestamp: -1 }).limit(1).toArray();
            var closestBlock = closestAbove[0] && (!closestBelow[0] || closestAbove[0].timestamp - toTimestamp <= toTimestamp - closestBelow[0].timestamp) ? closestAbove[0] : closestBelow[0];
            if (closestBlock && closestBlock.number) {
                toBlock = closestBlock.number;
                toBlockData = closestBlock;
            } else {
                console.error("Failed to get ending block");
                return res.status(500).send();
            }
        } catch (error) {
            console.error("Failed to get ending block:", error);
            return res.status(500).send();
        }
    } else try {
        if (toBlock === 'latest') {
            toBlockData = (await db.collection('blocks').find({}, returnFields).sort({ number: -1 }).limit(1).toArray())[0];
            toBlock = toBlockData.number;
        } else toBlockData = await db.collection('blocks').findOne({ number: toBlock }, returnFields);
        if (!toBlockData) {
            console.error("Failed to get ending block #" + toBlock + ":", error);
            return res.status(500).send();
        }
    } catch (error) {
        console.error("Failed to get ending block #" + toBlock);
        return res.status(500).send();
    }

    // Get all transfer events from or to this account
    var events = [];

    if (poolKey == "stable") {
        events = await legacyContractsWithLogs["v1.0.0"].RariFundToken.getPastEvents("Transfer", { fromBlock: Math.max(fromBlock + 1, POOL_INCEPTION_BLOCKS[poolKey]), toBlock: toBlock === 'latest' ? 10890985 : Math.min(toBlock, 10890985), filter: { from: req.params.account } });
        events = events.concat(await legacyContractsWithLogs["v1.0.0"].RariFundToken.getPastEvents("Transfer", { fromBlock: Math.max(fromBlock + 1, POOL_INCEPTION_BLOCKS[poolKey]), toBlock: toBlock === 'latest' ? 10890985 : Math.min(toBlock, 10890985), filter: { to: req.params.account } }));

        events = events.concat(await contractsWithLogs[poolKey].RariFundToken.getPastEvents("Transfer", { fromBlock: Math.max(fromBlock + 1, 10909597), toBlock, filter: { from: req.params.account } }));
        events = events.concat(await contractsWithLogs[poolKey].RariFundToken.getPastEvents("Transfer", { fromBlock: Math.max(fromBlock + 1, 10909597), toBlock, filter: { to: req.params.account } }));
    } else if (poolKey == "yield") {
        events = await contractsWithLogs[poolKey].RariFundToken.getPastEvents("Transfer", { fromBlock: Math.max(fromBlock + 1, POOL_INCEPTION_BLOCKS[poolKey]), toBlock, filter: { from: req.params.account } });
        events = events.concat(await contractsWithLogs[poolKey].RariFundToken.getPastEvents("Transfer", { fromBlock: Math.max(fromBlock + 1, POOL_INCEPTION_BLOCKS[poolKey]), toBlock, filter: { to: req.params.account } }));
    } else if (poolKey == "ethereum") {
        events = await contractsWithLogs[poolKey].RariFundToken.getPastEvents("Transfer", { fromBlock: Math.max(fromBlock + 1, POOL_INCEPTION_BLOCKS[poolKey]), toBlock, filter: { from: req.params.account } });
        events = events.concat(await contractsWithLogs[poolKey].RariFundToken.getPastEvents("Transfer", { fromBlock: Math.max(fromBlock + 1, POOL_INCEPTION_BLOCKS[poolKey]), toBlock, filter: { to: req.params.account } }));
    } else if (poolKey == "dai") {
        events = await contractsWithLogs[poolKey].RariFundToken.getPastEvents("Transfer", { fromBlock: Math.max(fromBlock + 1, POOL_INCEPTION_BLOCKS[poolKey]), toBlock, filter: { from: req.params.account } });
        events = events.concat(await contractsWithLogs[poolKey].RariFundToken.getPastEvents("Transfer", { fromBlock: Math.max(fromBlock + 1, POOL_INCEPTION_BLOCKS[poolKey]), toBlock, filter: { to: req.params.account } }));
    }

    // Sort events by block number
    events.sort((a, b) => a.blockNumber > b.blockNumber ? 1 : -1);
    nextEventIndex = 0;
    
    // Get starting RSPT balance
    if (poolKey == "stable") var rsptBalanceBN = Web3.utils.toBN(await (fromBlock >= 10909596 ? contractsWithArchive[poolKey].RariFundToken : legacyContractsWithArchive["v1.0.0"].RariFundToken).methods.balanceOf(req.params.account).call(fromBlock));
    else var rsptBalanceBN = Web3.utils.toBN(await contractsWithArchive[poolKey].RariFundToken.methods.balanceOf(req.params.account).call(fromBlock));
    
    // First block
    var balances = [{ number: fromBlockData.number, timestamp: fromBlockData.timestamp, balance: rsptBalanceBN.mul(Web3.utils.toBN(fromBlockData[poolTokenKey + "ExchangeRate"])).div(Web3.utils.toBN(1e18)).toString() }];

    // Get middle blocks
    if (req.query && (req.query.intervalSeconds !== undefined && req.query.fromTimestamp !== undefined && req.query.toTimestamp !== undefined)) {
        var intervalSeconds = req.query.intervalSeconds > 0 ? parseInt(req.query.intervalSeconds) : 86400;
    
        for (var i = fromBlockData.timestamp + intervalSeconds; i < toBlockData.timestamp; i += intervalSeconds) try {
            var closestAbove = await db.collection('blocks').find({ timestamp: { $gte: i } }, returnFields).sort({ timestamp: 1 }).limit(1).toArray();
            var closestBelow = await db.collection('blocks').find({ timestamp: { $lte: i } }, returnFields).sort({ timestamp: -1 }).limit(1).toArray();
            var closestBlock = closestAbove[0] && (!closestBelow[0] || closestAbove[0].timestamp - i <= i - closestBelow[0].timestamp) ? closestAbove[0] : closestBelow[0];
            if (closestBlock && closestBlock.number) {
                while (nextEventIndex < events.length && events[nextEventIndex].blockNumber <= closestBlock.number) {
                    var event = events[nextEventIndex];
                    if (!(event.returnValues.from == req.params.account && event.returnValues.to == req.params.account)) rsptBalanceBN[event.returnValues.to == req.params.account ? "iadd" : "isub"](Web3.utils.toBN(event.returnValues.value));
                    nextEventIndex++;
                }
                balances.push({ number: closestBlock.number, timestamp: closestBlock.timestamp, balance: rsptBalanceBN.mul(Web3.utils.toBN(closestBlock[poolTokenKey + "ExchangeRate"])).div(Web3.utils.toBN(1e18)).toString() });
            } else {
                console.error("Failed to get middle block near timestamp", i);
                return res.status(500).send();
            }
        } catch (error) {
            console.error("Failed to get middle block near timestamp", i, ":", error);
            return res.status(500).send();
        }
    } else {
        var intervalBlocks = req.query && req.query.intervalBlocks !== undefined && req.query.intervalBlocks > 0 ? parseInt(req.query.intervalBlocks) : 6500;
        var blockNumbers = [];
        for (var i = fromBlock + intervalBlocks; i < toBlock; i += intervalBlocks) blockNumbers.push(i);

        try {
            // console.log("VVV", fromBlock, toBlock, intervalBlocks, i);
            var blocks = await db.collection('blocks').find({ number: { $in: blockNumbers } }, returnFields).toArray();
            if (!blocks) {
                console.error("Failed to get middle blocks from", fromBlock, "to", toBlock);
                return res.status(500).send();
            }
        } catch (error) {
            console.error("Failed to get middle blocks from", fromBlock, "to", toBlock, ":", error);
            return res.status(500).send();
        }
        
        for (var i = fromBlock + intervalBlocks; i < toBlock; i += intervalBlocks) {
            var closestBlock = blocks.find(block => block.number == i);
            if (closestBlock && closestBlock.number) {
                while (nextEventIndex < events.length && events[nextEventIndex].blockNumber <= closestBlock.number) {
                    var event = events[nextEventIndex];
                    if (!(event.returnValues.from == req.params.account && event.returnValues.to == req.params.account)) rsptBalanceBN[event.returnValues.to == req.params.account ? "iadd" : "isub"](Web3.utils.toBN(event.returnValues.value));
                    nextEventIndex++;
                }
                balances.push({ number: closestBlock.number, timestamp: closestBlock.timestamp, balance: rsptBalanceBN.mul(Web3.utils.toBN(closestBlock[poolTokenKey + "ExchangeRate"])).div(Web3.utils.toBN(1e18)).toString() });
            } else {
                console.error("Failed to get middle block #" + i);
                return res.status(500).send();
            }
        }
    }
    
    // Add last block
    for (var i = nextEventIndex; i < events.length; i++) {
        var event = events[i];
        if (!(event.returnValues.from == req.params.account && event.returnValues.to == req.params.account)) rsptBalanceBN[event.returnValues.to == req.params.account ? "iadd" : "isub"](Web3.utils.toBN(event.returnValues.value));
    }
    balances.push({ number: toBlockData.number, timestamp: toBlockData.timestamp, balance: rsptBalanceBN.mul(Web3.utils.toBN(toBlockData[poolTokenKey + "ExchangeRate"])).div(Web3.utils.toBN(1e18)).toString() });

    // TODO: balances[i].blockNumber not balances[i].number
    return res.status(200).json(balances);
}));

app.get("/pools/:pool/interest/:account", asyncHandler(async (req, res, next) => {
    if (!req.params || POOL_KEYS.indexOf(req.params.pool) < 0) return res.status(500).send();
    var poolKey = req.params.pool;
    var poolTokenKey = POOL_TOKEN_KEYS[poolKey];
    
    if (!req.params || !req.params.account) return res.status(500).send();
    if (req.params.account === "0x0000000000000000000000000000000000000000") return res.status(200).json("0");
    
    // Get from block
    var fromBlock = req.query && req.query.fromBlock !== undefined ? req.query.fromBlock : 0;

    if (req.query && req.query.fromTimestamp !== undefined) {
        var fromTimestamp = req.query.fromTimestamp !== 'latest' ? Math.min(req.query.fromTimestamp, Math.trunc((new Date()).getTime() / 1000)) : Math.trunc((new Date()).getTime() / 1000);

        try {
            var closestAbove = await db.collection('blocks').find({ timestamp: { $gte: fromTimestamp } }, { number: 1 }).sort({ timestamp: 1 }).limit(1).toArray();
            var closestBelow = await db.collection('blocks').find({ timestamp: { $lte: fromTimestamp } }, { number: 1 }).sort({ timestamp: -1 }).limit(1).toArray();
            var closestBlock = closestAbove[0] && (!closestBelow[0] || closestAbove[0].timestamp - fromTimestamp <= fromTimestamp - closestBelow[0].timestamp) ? closestAbove[0] : closestBelow[0];
            if (closestBlock && closestBlock.number) fromBlock = closestBlock.number;
        } catch (error) {
            console.error("Failed to get starting block:", error);
            return res.status(500).send();
        }
    }

    // Get to block
    var toBlock = req.query && req.query.toBlock !== undefined ? req.query.toBlock : 'latest';
    
    if (req.query && req.query.toTimestamp !== undefined) {
        var toTimestamp = req.query.toTimestamp !== 'latest' ? Math.min(req.query.toTimestamp, Math.trunc((new Date()).getTime() / 1000)) : Math.trunc((new Date()).getTime() / 1000);

        try {
            var closestAbove = await db.collection('blocks').find({ timestamp: { $gte: toTimestamp } }, { number: 1 }).sort({ timestamp: 1 }).limit(1).toArray();
            var closestBelow = await db.collection('blocks').find({ timestamp: { $lte: toTimestamp } }, { number: 1 }).sort({ timestamp: -1 }).limit(1).toArray();
            var closestBlock = closestAbove[0] && (!closestBelow[0] || closestAbove[0].timestamp - toTimestamp <= toTimestamp - closestBelow[0].timestamp) ? closestAbove[0] : closestBelow[0];
            if (closestBlock && closestBlock.number) toBlock = closestBlock.number;
        } catch (error) {
            console.error("Failed to get ending block:", error);
            return res.status(500).send();
        }
    }

    // Get all transfer events from or to this account
    var events = [];

    if (poolKey == "stable") {
        // TODO: No need for Math.max?
        events = await legacyContractsWithLogs["v1.0.0"].RariFundToken.getPastEvents("Transfer", { fromBlock: Math.max(fromBlock + 1, POOL_INCEPTION_BLOCKS[poolKey]), toBlock: toBlock === 'latest' ? 10890985 : Math.min(toBlock, 10890985), filter: { from: req.params.account } });
        events = events.concat(await legacyContractsWithLogs["v1.0.0"].RariFundToken.getPastEvents("Transfer", { fromBlock: Math.max(fromBlock + 1, POOL_INCEPTION_BLOCKS[poolKey]), toBlock: toBlock === 'latest' ? 10890985 : Math.min(toBlock, 10890985), filter: { to: req.params.account } }));

        events = events.concat(await contractsWithLogs[poolKey].RariFundToken.getPastEvents("Transfer", { fromBlock: Math.max(fromBlock + 1, 10909597), toBlock, filter: { from: req.params.account } }));
        events = events.concat(await contractsWithLogs[poolKey].RariFundToken.getPastEvents("Transfer", { fromBlock: Math.max(fromBlock + 1, 10909597), toBlock, filter: { to: req.params.account } }));
    } else if (poolKey == "yield") {
        events = await contractsWithLogs[poolKey].RariFundToken.getPastEvents("Transfer", { fromBlock: Math.max(fromBlock + 1, POOL_INCEPTION_BLOCKS[poolKey]), toBlock, filter: { from: req.params.account } });
        events = events.concat(await contractsWithLogs[poolKey].RariFundToken.getPastEvents("Transfer", { fromBlock: Math.max(fromBlock + 1, POOL_INCEPTION_BLOCKS[poolKey]), toBlock, filter: { to: req.params.account } }));
    } else if (poolKey == "ethereum") {
        events = await contractsWithLogs[poolKey].RariFundToken.getPastEvents("Transfer", { fromBlock: Math.max(fromBlock + 1, POOL_INCEPTION_BLOCKS[poolKey]), toBlock, filter: { from: req.params.account } });
        events = events.concat(await contractsWithLogs[poolKey].RariFundToken.getPastEvents("Transfer", { fromBlock: Math.max(fromBlock + 1, POOL_INCEPTION_BLOCKS[poolKey]), toBlock, filter: { to: req.params.account } }));
    } else if (poolKey == "dai") {
        events = await contractsWithLogs[poolKey].RariFundToken.getPastEvents("Transfer", { fromBlock: Math.max(fromBlock + 1, POOL_INCEPTION_BLOCKS[poolKey]), toBlock, filter: { from: req.params.account } });
        events = events.concat(await contractsWithLogs[poolKey].RariFundToken.getPastEvents("Transfer", { fromBlock: Math.max(fromBlock + 1, POOL_INCEPTION_BLOCKS[poolKey]), toBlock, filter: { to: req.params.account } }));
    }

    // Sort events from lowest to highest block number
    events.sort((a, b) => a.blockNumber > b.blockNumber ? 1 : -1);

    // Loop through events to calculate interest accrued
    var netDepositsUsd = Web3.utils.toBN(0);

    // TODO: Come up with something better than this
    if (poolKey == "stable" && fromBlock >= POOL_INCEPTION_BLOCKS[poolKey]) netDepositsUsd = Web3.utils.toBN(await (fromBlock >= 10909111 ? contractsWithArchive[poolKey].RariFundManager : (fromBlock >= 10458038 ? legacyContractsWithArchive["v1.1.0"].RariFundManager : legacyContractsWithArchive["v1.0.0"].RariFundManager)).methods.balanceOf(req.params.account).call(getBestFundBalanceBlockNumber(poolKey, fromBlock)));
    else if (fromBlock >= POOL_INCEPTION_BLOCKS[poolKey]) netDepositsUsd = Web3.utils.toBN(await contractsWithArchive[poolKey].RariFundManager.methods.balanceOf(req.params.account).call(getBestFundBalanceBlockNumber(poolKey, fromBlock)));

    for (const event of events) {
        var block = await db.collection('blocks').findOne({ number: event.blockNumber });
        var exchangeRate = block ? block[poolTokenKey + "ExchangeRate"] : null;

        if (!exchangeRate) {
            try {
                if (poolKey == "stable") var fundBalanceBN = Web3.utils.toBN(await (event.blockNumber >= 10909111 ? contractsWithArchive[poolKey].RariFundManager : (event.blockNumber >= 10458038 ? legacyContractsWithArchive["v1.1.0"].RariFundManager : legacyContractsWithArchive["v1.0.0"].RariFundManager)).methods.getFundBalance().call(getBestFundBalanceBlockNumber(poolKey, event.blockNumber)));
                else var fundBalanceBN = Web3.utils.toBN(await contractsWithArchive[poolKey].RariFundManager.methods.getFundBalance().call(getBestFundBalanceBlockNumber(poolKey, event.blockNumber)));
            } catch (error) {
                console.error("Failed to get fund balance at block #" + event.blockNumber + ":", error);
                return res.status(500).send();
            }

            try {
                if (poolKey == "stable") var rsptTotalSupplyBN = Web3.utils.toBN(await (event.blockNumber >= 10909596 ? contractsWithArchive[poolKey].RariFundToken : legacyContractsWithArchive["v1.0.0"].RariFundToken).methods.totalSupply().call(event.blockNumber));
                else var rsptTotalSupplyBN = Web3.utils.toBN(await contractsWithArchive[poolKey].RariFundToken.methods.totalSupply().call(event.blockNumber));
            } catch (error) {
                console.error("Failed to get fund balance at block #" + event.blockNumber + ":", error);
                return res.status(500).send();
            }
            
            exchangeRate = fundBalanceBN.mul(Web3.utils.toBN(1e18)).div(rsptTotalSupplyBN);
        }

        if (!(event.returnValues.from.toLowerCase() == req.params.account.toLowerCase() && event.returnValues.to.toLowerCase() == req.params.account.toLowerCase())) netDepositsUsd[event.returnValues.to.toLowerCase() == req.params.account.toLowerCase() ? "iadd" : "isub"](Web3.utils.toBN(event.returnValues.value).mul(Web3.utils.toBN(exchangeRate)).div(Web3.utils.toBN(1e18)));
        // if (req.params.account == "0x7eD52863829AB99354F3a0503A622e82AcD5F7d3") console.log("Z", event.returnValues.to.toLowerCase() == req.params.account.toLowerCase() ? "+++" : "---", event.returnValues.value / 1e18, exchangeRate / 1e18, Web3.utils.toBN(event.returnValues.value).mul(Web3.utils.toBN(exchangeRate)).div(Web3.utils.toBN(1e18)).toString() / 1e18);
    }

    var finalAccountBalanceBN = Web3.utils.toBN(await contracts[poolKey].RariFundManager.methods.balanceOf(req.params.account).call()); // TODO: at toBlock
    var interestAccruedBN = finalAccountBalanceBN.sub(netDepositsUsd);
    // if (req.params.account == "0x7eD52863829AB99354F3a0503A622e82AcD5F7d3") console.log("XXX", interestAccruedBN.toString() / 1e18, finalAccountBalanceBN.toString() / 1e18, netDepositsUsd.toString() / 1e18);

    return res.status(200).json(interestAccruedBN.gt(Web3.utils.toBN(0)) ? interestAccruedBN.toString() : "0");
}));

app.get("/pools/:pool/interest", asyncHandler(async (req, res, next) => {
    if (!req.params || POOL_KEYS.indexOf(req.params.pool) < 0) return res.status(500).send();
    var poolKey = req.params.pool;

    // TODO: Interest history
    if (req.query && req.query.startBlock !== undefined) {
        if (req.query.startBlock === 'latest') return res.status(200).json("0");

        if (req.query.endBlock !== undefined) {
            if (req.query.startBlock == req.query.endBlock) return res.status(200).json("0");
            if (req.query.startBlock > req.query.endBlock) return res.status(400).json();
            if (req.query.endBlock < POOL_INCEPTION_BLOCKS[poolKey]) return res.status(200).json("0");
        }

        if (req.query.startBlock > POOL_INCEPTION_BLOCKS[poolKey]) {
            try {
                if (poolKey == "stable") var startInterestAccrued = await (req.query.startBlock >= 10909111 ? contractsWithArchive[poolKey].RariFundManager : (req.query.startBlock >= 10458038 ? legacyContractsWithArchive["v1.1.0"].RariFundManager : legacyContractsWithArchive["v1.0.0"].RariFundManager)).methods.getInterestAccrued().call(getBestFundBalanceBlockNumber(poolKey, req.query.startBlock));
                else var startInterestAccrued = await contractsWithArchive[poolKey].RariFundManager.methods.getInterestAccrued().call(getBestFundBalanceBlockNumber(poolKey, req.query.startBlock));
            } catch (error) {
                console.error("Failed to get interest accrued at start block:", error);
                return res.status(500).send();
            }
        }
    }

    try {
        if (poolKey == "stable") var endInterestAccrued = await (req.query && req.query.endBlock !== undefined && req.query.endBlock !== 'latest' ? (req.query.endBlock >= 10909111 ? contractsWithArchive[poolKey].RariFundManager : (req.query.endBlock >= 10458038 ? legacyContractsWithArchive["v1.1.0"].RariFundManager : legacyContractsWithArchive["v1.0.0"].RariFundManager)).methods.getInterestAccrued().call(getBestFundBalanceBlockNumber(poolKey, req.query.endBlock)) : contractsWithArchive[poolKey].RariFundManager.methods.getInterestAccrued().call());
        else var endInterestAccrued = await (req.query && req.query.endBlock !== undefined && req.query.endBlock !== 'latest' ? contractsWithArchive[poolKey].RariFundManager.methods.getInterestAccrued().call(getBestFundBalanceBlockNumber(poolKey, req.query.endBlock)) : contractsWithArchive[poolKey].RariFundManager.methods.getInterestAccrued().call());
    } catch (error) {
        console.error("Failed to get interest accrued at end block:", error);
        return res.status(500).send();
    }
    
    var interestAccruedBN = Web3.utils.toBN(endInterestAccrued);
    if (startInterestAccrued !== undefined) interestAccruedBN.isub(Web3.utils.toBN(startInterestAccrued));
    return res.status(200).json(interestAccruedBN.gt(Web3.utils.toBN(0)) ? interestAccruedBN.toString() : "0");
}));

var server = app.listen(port, function () {
    var port = server.address().port;
    console.log("Example app listening at port %s", port);
});

module.exports = server;



var erc20Abi = require(__dirname + "/abi/ERC20.json");

const contractAddresses = {
  "governance": {
    "RariGovernanceToken": "0xD291E7a03283640FDc51b121aC401383A46cC623",
    "RariGovernanceTokenDistributor": "0x9C0CaEb986c003417D21A7Daaf30221d61FC1043"
  },
  "stable": {
    "RariFundController": "0xEe7162bB5191E8EC803F7635dE9A920159F1F40C",
    "RariFundManager": "0xC6BF8C8A55f77686720E0a88e2Fd1fEEF58ddf4a",
    "RariFundToken": "0x016bf078ABcaCB987f0589a6d3BEAdD4316922B0",
    "RariFundPriceConsumer": "0x77a817077cd7Cf0c6e0d4d2c4464648FF6C3fdB8",
    "RariFundProxy": "0xD4be7E211680e12c08bbE9054F0dA0D646c45228"
  },
  "yield": {
    "RariFundController": "0x6afE6C37bF75f80D512b9D89C19EC0B346b09a8d",
    "RariFundManager": "0x59FA438cD0731EBF5F4cDCaf72D4960EFd13FCe6",
    "RariFundToken": "0x3baa6B7Af0D72006d3ea770ca29100Eb848559ae",
    "RariFundPriceConsumer": "0x00815e0e9d118769542ce24be95f8e21c60e5561",
    "RariFundProxy": "0x6dd8e1Df9F366e6494c2601e515813e0f9219A88"
  },
  "ethereum": {
    "RariFundController": "0xD9F223A36C2e398B0886F945a7e556B41EF91A3C",
    "RariFundManager": "0xD6e194aF3d9674b62D1b30Ec676030C23961275e",
    "RariFundToken": "0xCda4770d65B4211364Cb870aD6bE19E7Ef1D65f4",
    "RariFundProxy": "0xa3cc9e4B9784c80a05B3Af215C32ff223C3ebE5c"
  },
  "dai": {
    "RariFundController": "0xD7590e93a2e04110Ad50ec70EADE7490F7B8228a",
    "RariFundManager": "0xB465BAF04C087Ce3ed1C266F96CA43f4847D9635",
    "RariFundToken": "0x0833cfcb11A5ba89FbAF73a407831c98aD2D7648",
    "RariFundProxy": "0x3F579F097F2CE8696Ae8C417582CfAFdE9Ec9966"
  },
};

var abis = {};
for (const domain of Object.keys(contractAddresses)) for (const contractName of Object.keys(contractAddresses[domain])) {
    if (!abis[domain]) abis[domain] = {};
    abis[domain][contractName] = require(__dirname + "/abi/" + domain + "/" + contractName + ".json");
}

const legacyContractAddresses = {
    "v1.0.0": {
        "RariFundManager": "0x686ac9d046418416d3ed9ea9206f3dace4943027",
        "RariFundToken": "0x9366B7C00894c3555c7590b0384e5F6a9D55659f",
        "RariFundProxy": "0x27C4E34163b5FD2122cE43a40e3eaa4d58eEbeaF"
    },
    "v1.1.0": {
        "RariFundManager": "0x6bdaf490c5b6bb58564b3e79c8d18e8dfd270464",
        "RariFundProxy": "0x318cfd99b60a63d265d2291a4ab982073fbf245d"
    },
    "v1.2.0": {
        "RariFundProxy": "0xb6b79D857858004BF475e4A57D4A446DA4884866"
    }
};

var legacyAbis = {};
for (const version of Object.keys(legacyContractAddresses)) for (const contractName of Object.keys(legacyContractAddresses[version])) {
    if (!legacyAbis[version]) legacyAbis[version] = {};
    legacyAbis[version][contractName] = require(__dirname + "/abi/legacy/" + version + "/" + contractName + ".json");
}

var contracts = {};
var contractsWithLogs = {};
var contractsWithArchive = {};

for (const domain of Object.keys(contractAddresses)) for (const contractName of Object.keys(contractAddresses[domain])) {
    if (!contracts[domain]) contracts[domain] = {};
    contracts[domain][contractName] = new web3.eth.Contract(abis[domain][contractName], contractAddresses[domain][contractName]);
    if (!contractsWithLogs[domain]) contractsWithLogs[domain] = {};
    contractsWithLogs[domain][contractName] = new web3WithLogs.eth.Contract(abis[domain][contractName], contractAddresses[domain][contractName]);
    if (!contractsWithArchive[domain]) contractsWithArchive[domain] = {};
    contractsWithArchive[domain][contractName] = new web3WithArchive.eth.Contract(abis[domain][contractName], contractAddresses[domain][contractName]);
}

var legacyContracts = {};
var legacyContractsWithLogs = {};
var legacyContractsWithArchive = {};

for (const version of Object.keys(legacyContractAddresses)) for (const contractName of Object.keys(legacyContractAddresses[version])) {
    if (!legacyContracts[version]) legacyContracts[version] = {};
    legacyContracts[version][contractName] = new web3.eth.Contract(legacyAbis[version][contractName], legacyContractAddresses[version][contractName]);
    if (!legacyContractsWithLogs[version]) legacyContractsWithLogs[version] = {};
    legacyContractsWithLogs[version][contractName] = new web3WithLogs.eth.Contract(legacyAbis[version][contractName], legacyContractAddresses[version][contractName]);
    if (!legacyContractsWithArchive[version]) legacyContractsWithArchive[version] = {};
    legacyContractsWithArchive[version][contractName] = new web3WithArchive.eth.Contract(legacyAbis[version][contractName], legacyContractAddresses[version][contractName]);
}



const MongoClient = require('mongodb').MongoClient;
const assert = require('assert');

// Create a new MongoClient
const client = new MongoClient(process.env.MONGODB_URL, { useUnifiedTopology: true, useNewUrlParser: true });
var db = null;

// Connect to the MongoDB server
client.connect(function(err) {
    assert.equal(null, err);
    console.log("Connected successfully to MongoDB server");
    db = client.db(process.env.MONDODB_DB_NAME);
    resetCheckingForBlocks();
    // checkForMissingBlocks(11363000); // POOL_INCEPTION_BLOCKS["stable"]
});

function resetCheckingForBlocks() {
    db.collection('blocks').find().sort({ number: -1 }).limit(1).toArray(function(err, result) {
        if (err !== null) return console.error("Failed to get blocks from database:", err);
        var startBlockNumber = result && result[0] && result[0].number !== null ? result[0].number + 1 : POOL_INCEPTION_BLOCKS["stable"];
        startCheckingForBlocks(startBlockNumber);
    });
}

async function startCheckingForBlocks(startBlockNumber) {
    try {
        var endBlockNumber = await web3.eth.getBlockNumber();
    } catch (error) {
        console.error("Failed to get current block number before checking for transactions");
        return setTimeout(resetCheckingForBlocks, 30 * 60000);
    }

    if (startBlockNumber < 0) startBlockNumber = endBlockNumber;

    console.log("Searching for transactions from block number", startBlockNumber, "to", endBlockNumber);
    var blocks = [];

    // Loop through blocks searching for ETH transactions
    for (var i = startBlockNumber; i <= endBlockNumber; i++) {
        if (i % 100 == 0) console.log("Searching block", i, "for transactions");

        try {
            var block = await web3.eth.getBlock(i, true);
        } catch (error) {
            console.error("Failed to get ETH block #" + i + ":", error);
            return setTimeout(resetCheckingForBlocks, 15 * 60000);
        }
        
        if (block === null) {
            console.error("Failed to get ETH block #" + i);
            return setTimeout(resetCheckingForBlocks, 15 * 60000);
        }

        try {
            var fundBalance = await (i >= 10909111 ? contractsWithArchive["stable"].RariFundManager : (i >= 10458038 ? legacyContractsWithArchive["v1.1.0"].RariFundManager : legacyContractsWithArchive["v1.0.0"].RariFundManager)).methods.getFundBalance().call(getBestFundBalanceBlockNumber("stable", i));
        } catch (error) {
            console.error("Failed to get fund balance at block #" + i + ":", error);
            return setTimeout(resetCheckingForBlocks, 15 * 60000);
        }

        try {
            var rsptTotalSupply = await (i >= 10909596 ? contractsWithArchive["stable"].RariFundToken : legacyContractsWithArchive["v1.0.0"].RariFundToken).methods.totalSupply().call(i);
        } catch (error) {
            console.error("Failed to get RSPT total supply at block #" + i + ":", error);
            return setTimeout(resetCheckingForBlocks, 15 * 60000);
        }
        
        var rsptExchangeRateBN = Web3.utils.toBN(fundBalance).mul(Web3.utils.toBN(1e18)).div(Web3.utils.toBN(rsptTotalSupply));
        var block = { number: i, timestamp: block.timestamp, rsptExchangeRate: rsptExchangeRateBN.toString(), rsptTotalSupply, stablePoolBalance: fundBalance };
        
        for (const poolKey of ["yield", "ethereum", "dai"]) {
            if (i < POOL_INCEPTION_BLOCKS[poolKey]) continue;
            var poolTokenKey = POOL_TOKEN_KEYS[poolKey];

            try {
                var fundBalance = await contractsWithArchive[poolKey].RariFundManager.methods.getFundBalance().call(getBestFundBalanceBlockNumber(poolKey, i));
            } catch (error) {
                console.error("Failed to get fund balance at block #" + i + ":", error);
                return setTimeout(resetCheckingForBlocks, 15 * 60000);
            }

            try {
                var rsptTotalSupply = await contractsWithArchive[poolKey].RariFundToken.methods.totalSupply().call(i);
            } catch (error) {
                console.error("Failed to get RSPT total supply at block #" + i + ":", error);
                return setTimeout(resetCheckingForBlocks, 15 * 60000);
            }
            
            var rsptExchangeRateBN = Web3.utils.toBN(rsptTotalSupply).gt(Web3.utils.toBN(0)) ? Web3.utils.toBN(fundBalance).mul(Web3.utils.toBN(1e18)).div(Web3.utils.toBN(rsptTotalSupply)) : Web3.utils.toBN(0);
            block[poolTokenKey + "ExchangeRate"] = rsptExchangeRateBN.toString();
            block[poolTokenKey + "TotalSupply"] = rsptTotalSupply;
            block[poolKey + "PoolBalance"] = fundBalance;
        }

        blocks.push(block);

        if (blocks.length > 0 && i % 100 == 0) {
            await db.collection('blocks').insertMany(blocks);
            blocks = [];
        }
    }

    if (blocks.length > 0) await db.collection('blocks').insertMany(blocks);

    setTimeout(function() {
        startCheckingForBlocks(endBlockNumber + 1);
    }, 60000);
}

// TODO: Add DAI pool
async function checkForMissingBlocks(startBlockNumber) {
    try {
        var endBlockNumber = await web3.eth.getBlockNumber();
    } catch (error) {
        return console.error("Failed to get current block number before checking for transactions in missing blocks");
    }

    if (startBlockNumber < 0) startBlockNumber = endBlockNumber;

    console.log("Searching for transactions in missing blocks from block number", startBlockNumber, "to", endBlockNumber);
    var blocks = [];

    // Loop through blocks searching for ETH transactions
    for (var i = startBlockNumber; i <= endBlockNumber; i++) {
        if (i % 1000 == 0) console.log("Searching for missing blocks starting at", i);
        if (await db.collection('blocks').findOne({ number: i })) continue;
        console.log("Searching missing block", i, "for transactions");

        try {
            var block = await web3.eth.getBlock(i, true);
        } catch (error) {
            console.error("Failed to get ETH block #" + i + ":", error);
            return setTimeout(resetCheckingForBlocks, 15 * 60000);
        }

        try {
            var fundBalance = await (i >= 10909111 ? contractsWithArchive["stable"].RariFundManager : (i >= 10458038 ? legacyContractsWithArchive["v1.1.0"].RariFundManager : legacyContractsWithArchive["v1.0.0"].RariFundManager)).methods.getFundBalance().call(getBestFundBalanceBlockNumber(poolKey, i));
        } catch (error) {
            console.error("Failed to get fund balance at block #" + i + ":", error);
            return setTimeout(resetCheckingForBlocks, 15 * 60000);
        }

        try {
            var rsptTotalSupply = await (i >= 10909596 ? contractsWithArchive["stable"].RariFundToken : legacyContractsWithArchive["v1.0.0"].RariFundToken).methods.totalSupply().call(i);
        } catch (error) {
            console.error("Failed to get RSPT total supply at block #" + i + ":", error);
            return setTimeout(resetCheckingForBlocks, 15 * 60000);
        }
        
        var rsptExchangeRateBN = Web3.utils.toBN(fundBalance).mul(Web3.utils.toBN(1e18)).div(Web3.utils.toBN(rsptTotalSupply));
        var block = { number: i, timestamp: block.timestamp, rsptExchangeRate: rsptExchangeRateBN.toString(), rsptTotalSupply, stablePoolBalance: fundBalance };
        
        for (const poolKey of ["yield", "ethereum"]) {
            if (i < POOL_INCEPTION_BLOCKS[poolKey]) continue;
            var poolTokenKey = POOL_TOKEN_KEYS[poolKey];

            try {
                var fundBalance = await contractsWithArchive[poolKey].RariFundManager.methods.getFundBalance().call(getBestFundBalanceBlockNumber(poolKey, i));
            } catch (error) {
                console.error("Failed to get fund balance at block #" + i + ":", error);
                return setTimeout(resetCheckingForBlocks, 15 * 60000);
            }

            try {
                var rsptTotalSupply = await contractsWithArchive[poolKey].RariFundToken.methods.totalSupply().call(i);
            } catch (error) {
                console.error("Failed to get RSPT total supply at block #" + i + ":", error);
                return setTimeout(resetCheckingForBlocks, 15 * 60000);
            }
            
            var rsptExchangeRateBN = Web3.utils.toBN(rsptTotalSupply).gt(Web3.utils.toBN(0)) ? Web3.utils.toBN(fundBalance).mul(Web3.utils.toBN(1e18)).div(Web3.utils.toBN(rsptTotalSupply)) : Web3.utils.toBN(0);
            block[poolTokenKey + "ExchangeRate"] = rsptExchangeRateBN.toString();
            block[poolTokenKey + "TotalSupply"] = rsptTotalSupply;
            block[poolKey + "PoolBalance"] = fundBalance;
        }

        blocks.push(block);

        if (blocks.length >= 100) {
            await db.collection('blocks').insertMany(blocks);
            blocks = [];
        }
    }
    
    if (blocks.length > 0) await db.collection('blocks').insertMany(blocks);
}
