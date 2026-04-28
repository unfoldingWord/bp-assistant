const fs = require('fs');
const path = require('path');
const { ANTHROPIC_API_KEY_ALIAS } = require('./anthropic-env');

function readSecretFile(filePath) {
  if (!filePath) return null;
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
}

function readSecret(name, envFallback) {
  if (envFallback) {
    const envFilePath = process.env[`${envFallback}_FILE`];
    const fromEnvFile = readSecretFile(envFilePath);
    if (fromEnvFile) return fromEnvFile;
  }

  const fromDockerSecret = name ? readSecretFile(path.join('/run/secrets', name)) : null;
  if (fromDockerSecret) return fromDockerSecret;

  const hostDir = process.env.BOT_SECRETS_DIR;
  const fromHost = (name && hostDir) ? readSecretFile(path.join(hostDir, name)) : null;
  if (fromHost) return fromHost;

  if (envFallback && process.env[envFallback]) {
    return process.env[envFallback];
  }

  if (envFallback === 'ANTHROPIC_API_KEY' && process.env[ANTHROPIC_API_KEY_ALIAS]) {
    return process.env[ANTHROPIC_API_KEY_ALIAS];
  }

  return null;
}

module.exports = { readSecret };
