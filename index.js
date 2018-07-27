'use strict';

const fs = require('fs');

const INTERPOLATION_SCALE = 12;

class Portfolio {
    constructor(name, balances) {
        this.name = name;
        this.balances = balances;
    }

    wealth(tokenPrices) {
        let sum = 0;
        for (let token of Object.keys(this.balances)) {
            sum += this.balances[token] * tokenPrices[token];
        }
        return sum;
    }

    static tokenAmountsToBuy(usdAmount, sumWeight, weights, quotes, priceIndex) {
        const amounts = {};
        for (let token of Object.keys(weights)) {
            const weight = weights[token];
            const price = quotes[token].prices[priceIndex];
            amounts[token] = usdAmount * weight / sumWeight / price;
        }
        return amounts;
    }
}

class RebalancePortfolio extends Portfolio {
    constructor(name, balances, weights, fee) {
        super(name, balances);
        this.weights = weights;
        this.fee = fee;
    }

    getReturn(fromSymbol, toSymbol, amount) {
        const fromBalance = this.balances[fromSymbol];
        const fromWeight = this.weights[fromSymbol];
        const toBalance = this.balances[toSymbol];
        const toWeight = this.weights[toSymbol];

        return toBalance * amount * fromWeight / ((fromBalance + amount) * toWeight) * (1 - this.fee/100);
    }

    change(fromSymbol, toSymbol, amount) {
        console.assert(amount > 0);
        const result = this.getReturn(fromSymbol, toSymbol, amount);
        this.balances[fromSymbol] += amount;
        this.balances[toSymbol] -= result;
    }

    bestArbitrage(
        cheapName,
        cheapPrice,
        expensiveName,
        expensivePrice)
    {
        // x = sqrt(p_2 * s_1 * b_1 * b_2 / p_1 / s_2) - b_1
        const exchangeAmount = Math.sqrt(
                expensivePrice *
                this.weights[cheapName] *
                this.balances[cheapName] *
                this.balances[expensiveName] /
                (cheapPrice * this.weights[expensiveName]) * (1 - this.fee/100)
            ) - this.balances[cheapName];

        if (exchangeAmount < 0) {
            return { 'profit' : 0 };
        }

        const returnAmount = this.getReturn(cheapName, expensiveName, exchangeAmount);
        const profit = returnAmount * expensivePrice - exchangeAmount * cheapPrice;

        return {
            'amount' : exchangeAmount,
            'profit' : profit,
            'from' : cheapName,
            'to' : expensiveName,
        }
    }
}

class Quotes {
    constructor(filename) {
        this.times = [];
        this.prices = [];

        if (filename) {
            const datesAndPrices = JSON.parse(fs.readFileSync(filename, 'utf8'));
            for (let i = 0; i < datesAndPrices.length; i += 2) {
                const time = parseInt(datesAndPrices[i]);
                this.times.push(Math.trunc(time/60000)*60000);
                this.prices.push(parseFloat(datesAndPrices[i + 1]));
            }
        }
    }

    static pricesForTokens(tokenQuotes, priceIndex) {
        const prices = {};
        for (let token of Object.keys(tokenQuotes)) {
            prices[token] = tokenQuotes[token].prices[priceIndex];
        }
        return prices;
    }

    subquotes(start, stop) {
        const indexOfStart = this.times.indexOf(start);
        const indexOfStop = this.times.lastIndexOf(stop);
        console.assert(indexOfStart != -1);
        console.assert(indexOfStop != -1);

        const quotes = new Quotes();
        quotes.times = this.times.slice(indexOfStart, indexOfStop + 1);
        quotes.prices = this.prices.slice(indexOfStart, indexOfStop + 1);
        return quotes;
    }

    interpolatedWithScale(scale) {
        function lin(x1, y1, x2, y2, targetX) {
            return y1 + (targetX - x1) * (y2 - y1) / (x2 - x1);
        }

        const quotes = new Quotes();
        for (let i = 0; i < this.times.length - 1; i++) {
            for (let j = 0; j < scale; j++) {
                const time = this.times[i] + (this.times[i + 1] - this.times[i])*j/scale;
                quotes.times.push(time);
                quotes.prices.push(lin(this.times[i], this.prices[i], this.times[i + 1], this.prices[i + 1], time));
            }
        }
        return quotes;
    }
}

////////////////////////////////////////////////////////////////

const initialAmountUSD = process.argv[2];
console.log('Initial USD amount: $' + initialAmountUSD);

const dailyExchangeAmountUSD = process.argv[3];
console.log('Daily exchange USD amount: $' + dailyExchangeAmountUSD);

const numberOfTokens = (process.argv.length - 5) / 3;
console.log('Number of tokens: ', numberOfTokens);
console.assert(numberOfTokens > 0 && numberOfTokens == Math.trunc(numberOfTokens));

let btcusd = new Quotes(process.argv[4]);
console.log('BTC loaded period: ' + new Date(btcusd.times[0]).toISOString() +
            ' - ' + new Date(btcusd.times[btcusd.times.length - 1]).toISOString());

// Load all token prices
const tokenQuotes = {};
const tokenWeights = {};
let totalWeigth = 0;
let maxStart = btcusd.times[0];
let minStop = btcusd.times[btcusd.times.length - 1];
for (let i = 0; i < numberOfTokens*3; i += 3) {
    const token = process.argv[5 + i];
    const filename = process.argv[5 + i + 1];
    const weight = parseInt(process.argv[5 + i + 2]);

    const quotes = new Quotes(filename);
    tokenQuotes[token] = quotes;
    tokenWeights[token] = weight;
    totalWeigth += weight;
    maxStart = Math.max(maxStart, quotes.times[0]);
    minStop = Math.min(minStop, quotes.times[quotes.times.length - 1]);

    console.log(token + ' loaded period: ' + new Date(quotes.times[0]).toISOString() +
                ' - ' + new Date(quotes.times[quotes.times.length - 1]).toISOString());
}

// Truncate range
btcusd = btcusd.subquotes(maxStart, minStop);
for (let token of Object.keys(tokenQuotes)) {
    tokenQuotes[token] = tokenQuotes[token].subquotes(maxStart, minStop);

    // Fix bad data
    while (tokenQuotes[token].times.length < btcusd.times.length) {
        tokenQuotes[token].times.push(tokenQuotes[token].times[tokenQuotes[token].times.length - 1] + 60000);
        tokenQuotes[token].prices.push(tokenQuotes[token].prices[tokenQuotes[token].prices.length - 1]);
    }
}
var timeDiff = Math.abs(new Date(minStop).getTime() - new Date(maxStart).getTime());
var diffDays = Math.ceil(timeDiff / (1000 * 3600 * 24));
console.log('Truncated range to: ' + new Date(maxStart).toISOString() +
            ' - ' + new Date(minStop).toISOString() + ' (' + diffDays +  ' days)');

// // Update all prices from BTC to USD
// for (let token of Object.keys(tokenQuotes)) {
//     for (let i = 0; i < btcusd.prices.length; i++) {
//         tokenQuotes[token].prices[i] *= btcusd.prices[i];
//     }
// }
// console.log('All prices updated from BTC to USD');

// Interpolation
btcusd = btcusd.interpolatedWithScale(INTERPOLATION_SCALE);
for (let token of Object.keys(tokenQuotes)) {
    tokenQuotes[token] = tokenQuotes[token].interpolatedWithScale(INTERPOLATION_SCALE);
}

// Randomize exchanges

const randomChanges = {};
for (let offset = 0; offset < btcusd.times.length; offset += 60 * 24 * INTERPOLATION_SCALE) {
    let dailySpentAmount = 0;
    while (dailySpentAmount < dailyExchangeAmountUSD) {
        const index = Math.trunc(Math.random() * 60 * 24 * INTERPOLATION_SCALE) % (btcusd.times.length - offset);
        const time = btcusd.times[offset + index];
        if (randomChanges[time]) {
            continue;
        }

        let amount = 1 + Math.random() * (initialAmountUSD/100); // from $1 to 1% of amount
        if (dailySpentAmount + amount > dailyExchangeAmountUSD) {
            amount = dailyExchangeAmountUSD - dailySpentAmount;
        }
        dailySpentAmount += amount;
        randomChanges[time] = amount;
    }
}

//

const p1 = new Portfolio('BtcHolder', { 'BTC' : initialAmountUSD / btcusd.prices[0] });
const p2 = new Portfolio('TokenHolder', Portfolio.tokenAmountsToBuy(initialAmountUSD, totalWeigth, tokenWeights, tokenQuotes, 0));
const p3 = new RebalancePortfolio('Rebalancer', Portfolio.tokenAmountsToBuy(initialAmountUSD, totalWeigth, tokenWeights, tokenQuotes, 0), tokenWeights, 0.2);
console.log('\n======== BEGIN ========\n');
console.log('Prices: ' + JSON.stringify(Quotes.pricesForTokens(tokenQuotes, 0)));
console.log(p1, '$' + p1.wealth({ 'BTC' : btcusd.prices[0] }));
console.log(p2, '$' + p2.wealth(Quotes.pricesForTokens(tokenQuotes, 0)));
console.log(p3, '$' + p3.wealth(Quotes.pricesForTokens(tokenQuotes, 0)));

let numberOfArbitrages = 0;
let totalArbiterProfit = 0;
let totalTransactionFees = 0;
const tokens = Object.keys(tokenQuotes);
for (let i = 0; i < btcusd.prices.length; i++) {
    const randomChangeUSD = randomChanges[btcusd.times[i]];
    if (randomChangeUSD) {
        let tokenX = tokens[Math.trunc(tokens.length * Math.random())];
        let tokenY = tokenX;
        while (tokenY == tokenX) {
            tokenY = tokens[Math.trunc(tokens.length * Math.random())];
        }
        p3.change(tokenX, tokenY, randomChangeUSD/tokenQuotes[tokenX].prices[i]);
    }

    let bestArbitrage = { 'profit' : 0 };
    for (let tokenA of tokens) {
        for (let tokenB of tokens) {
            if (tokenA == tokenB) {
                continue;
            }

            const arbitrage = p3.bestArbitrage(tokenA, tokenQuotes[tokenA].prices[i], tokenB, tokenQuotes[tokenB].prices[i]);
            if (arbitrage.profit > bestArbitrage.profit) {
                bestArbitrage = arbitrage;
            }
        }
    }

    const txPrice = Math.sin(i / 1000) * 0.5 + 1;
    if (bestArbitrage.profit > txPrice) {
        p3.change(bestArbitrage.from, bestArbitrage.to, bestArbitrage.amount);
        totalArbiterProfit += bestArbitrage.profit - txPrice;
        totalTransactionFees += txPrice;
        numberOfArbitrages++;
    }
}

console.log('\n======== END ========\n');
console.log('Prices: ' + JSON.stringify(Quotes.pricesForTokens(tokenQuotes, btcusd.prices.length - 1)));
console.log(p1, '$' + p1.wealth({ 'BTC' : btcusd.prices[btcusd.prices.length - 1] }));
console.log(p2, '$' + p2.wealth(Quotes.pricesForTokens(tokenQuotes, btcusd.prices.length - 1)));
console.log(p3, '$' + p3.wealth(Quotes.pricesForTokens(tokenQuotes, btcusd.prices.length - 1)));
console.log('Total arbitragers profit: $' + totalArbiterProfit);
console.log('Total transaction fees: $' + totalTransactionFees);
console.log('Number of arbitrages: ' + numberOfArbitrages);
