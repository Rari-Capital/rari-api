# Rari Capital: HTTP API

This repository contains the JavaScript source code for Rari Capital's JSON-based HTTP API. The API is deployed in production at [`https://api.rari.capital/`](https://api.rari.capital/). The Rari API serves resources for the [Stable Pool](https://github.com/Rari-Capital/rari-stable-pool-contracts/), [Yield Pool](https://github.com/Rari-Capital/rari-yield-pool-contracts/), [Ethereum Pool](https://github.com/Rari-Capital/rari-ethereum-pool-contracts/), and [Governance](https://github.com/Rari-Capital/rari-governance-contracts/). The API is used by the [Rari SDK](https://github.com/Rari-Capital/rari-dApp/tree/master/src/rari-sdk), which is used by the the [Rari dApp](https://github.com/Rari-Capital/rari-dApp).

## Installation

You'll want to run the script on the latest Node.js LTS (tested with v12.16.1) with the latest version of NPM.

Install PM2 (process manager) globally: `npm i -g pm2`

Install `rari-api` dependencies: `npm i` or `npm install`

## Usage

Configure your environment in `ecosystem.config.js`.

Start the rebalancer with PM2: `pm2 start ecosystem.config.js` (for production usage, add `--env production`)

Stop with PM2: `pm2 stop ecosystem.config.js`

Check process status with PM2: `pm2 list`

Find PM2 logs in `~/.pm2/logs`.

## Credits

Rari Capital's HTTP API is developed by [David Lucid](https://github.com/davidlucid) of Rari Capital. Find out more about Rari Capital at [rari.capital](https://rari.capital).
