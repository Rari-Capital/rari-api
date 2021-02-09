module.exports = {
  apps : [{
    name: 'rari-api',
    script: 'index.js',

    // Options reference: https://pm2.keymetrics.io/docs/usage/application-declaration/
    // args: 'one two',
    // instances: 1,
    // autorestart: true,
    // watch: false,
    // max_memory_restart: '1G',
    env: {
      NODE_ENV: 'development',
      HTTP_PORT: 3000,
      ACCESS_CONTROL_ALLOW_ORIGIN: "*",
      MONGODB_URL: 'mongodb://localhost:27017',
      MONDODB_DB_NAME: 'rari',
      WEB3_HTTP_PROVIDER_URL: "http://localhost:8545",
      WEB3_HTTP_PROVIDER_LOGS_URL: "http://localhost:8545",
      WEB3_HTTP_PROVIDER_ARCHIVE_URL: "http://localhost:8545",
      RGT_DISTRIBUTION_START_BLOCK: 11094200
    },
    env_production: {
      NODE_ENV: 'production',
      HTTP_PORT: 3000,
      ACCESS_CONTROL_ALLOW_ORIGIN: "https://app.rari.capital",
      MONGODB_URL: 'mongodb://localhost:27017',
      MONDODB_DB_NAME: 'rari',
      WEB3_HTTP_PROVIDER_URL: "http://localhost:8545",
      WEB3_HTTP_PROVIDER_LOGS_URL: "http://localhost:8545",
      WEB3_HTTP_PROVIDER_ARCHIVE_URL: "http://localhost:8545",
      RGT_DISTRIBUTION_START_BLOCK: 11094200
    }
  }]
};
