const fs = require('fs');
const path = require('path');

function readSecret(name, envFallback) {
  try {
    return fs.readFileSync(path.join('/run/secrets', name), 'utf8').trim();
  } catch {
    return envFallback ? process.env[envFallback] : null;
  }
}

module.exports = { readSecret };
