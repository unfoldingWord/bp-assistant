const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '../data');
const CHECKPOINT_DIR = path.join(DATA_DIR, 'pipeline-checkpoints');

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CHECKPOINT_DIR)) fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
}

function safe(value) {
  return String(value == null ? '' : value).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function buildScopeId({ book, startChapter, endChapter, verseStart, verseEnd }) {
  const b = safe((book || '').toUpperCase());
  const s = Number(startChapter || 0);
  const e = Number(endChapter || 0);
  const vs = verseStart == null ? 'na' : Number(verseStart);
  const ve = verseEnd == null ? 'na' : Number(verseEnd);
  return `${b}_${s}_${e}_${vs}_${ve}`;
}

function buildCheckpointKey({ sessionKey, pipelineType, scope }) {
  return `${safe(sessionKey)}__${safe(pipelineType)}__${buildScopeId(scope)}`;
}

function getFileByKey(key) {
  return path.join(CHECKPOINT_DIR, `${safe(key)}.json`);
}

function getCheckpointByKey(key) {
  const file = getFileByKey(key);
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (err) {
    console.warn(`[pipeline-checkpoints] Failed to read ${key}: ${err.message}`);
  }
  return null;
}

function getCheckpoint({ sessionKey, pipelineType, scope }) {
  const key = buildCheckpointKey({ sessionKey, pipelineType, scope });
  return getCheckpointByKey(key);
}

function setCheckpoint({ sessionKey, pipelineType, scope }, patch) {
  try {
    ensureDirs();
    const key = buildCheckpointKey({ sessionKey, pipelineType, scope });
    const existing = getCheckpointByKey(key) || {};
    const next = {
      ...existing,
      ...patch,
      key,
      sessionKey,
      pipelineType,
      scope: { ...scope },
      updatedAt: new Date().toISOString(),
      createdAt: existing.createdAt || new Date().toISOString(),
    };
    fs.writeFileSync(getFileByKey(key), JSON.stringify(next, null, 2), 'utf8');
    return next;
  } catch (err) {
    console.warn(`[pipeline-checkpoints] Failed to write checkpoint: ${err.message}`);
    return null;
  }
}

function clearCheckpoint({ sessionKey, pipelineType, scope }) {
  try {
    const key = buildCheckpointKey({ sessionKey, pipelineType, scope });
    const file = getFileByKey(key);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (err) {
    console.warn(`[pipeline-checkpoints] Failed to clear checkpoint: ${err.message}`);
  }
}

function listCheckpoints() {
  try {
    ensureDirs();
    const files = fs.readdirSync(CHECKPOINT_DIR).filter((f) => f.endsWith('.json'));
    const rows = [];
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(CHECKPOINT_DIR, f), 'utf8'));
        if (data) rows.push(data);
      } catch (err) {
        console.warn(`[pipeline-checkpoints] Failed to parse ${f}: ${err.message}`);
      }
    }
    return rows;
  } catch (err) {
    console.warn(`[pipeline-checkpoints] Failed to list checkpoints: ${err.message}`);
    return [];
  }
}

module.exports = {
  buildScopeId,
  buildCheckpointKey,
  getCheckpoint,
  setCheckpoint,
  clearCheckpoint,
  listCheckpoints,
};
