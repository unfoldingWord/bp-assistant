const fs = require('fs');
const path = require('path');

const baseConfig = require('../config.json');
const localPath = path.join(__dirname, '../config.local.json');
const localConfig = fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, 'utf8')) : {};
const config = { ...baseConfig, ...localConfig };

module.exports = config;
