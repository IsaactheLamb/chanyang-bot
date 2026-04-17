require('dotenv').config();

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('ERROR: BOT_TOKEN environment variable is not set.');
  process.exit(1);
}

module.exports = { BOT_TOKEN };
