const fs = require('fs');
const path = require('path');

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

  if (envFallback && process.env[envFallback]) {
    return process.env[envFallback];
  }

  return null;
}

module.exports = { readSecret };
