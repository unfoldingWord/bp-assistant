const fs = require('fs');
const path = require('path');

const DEFAULT_LIMIT = 200;

function getStatusFile() {
  return process.env.ADMIN_STATUS_FILE
    || path.resolve(__dirname, '../data/admin-status.jsonl');
}

function ensureStatusDir() {
  fs.mkdirSync(path.dirname(getStatusFile()), { recursive: true });
}

function stripMarkup(text) {
  return String(text || '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim();
}

function inferScope(message) {
  const plain = stripMarkup(message);
  const match = plain.match(/\b([1-3]?[A-Z]{2,3})\s+(\d+(?::\d+(?:[-–—]\d+)?)?(?:\s*[-–—]\s*\d+)?)\b/);
  return match ? `${match[1]} ${match[2].replace(/\s+/g, '')}` : null;
}

function inferPhase(message) {
  const plain = stripMarkup(message).toLowerCase();
  if (plain.includes('align-all-parallel') || plain.includes('aligning')) return 'align';
  if (plain.includes('door43-push')) return 'push';
  if (plain.includes('repo verify') || plain.includes('verifying merge') || plain.includes('verifying push') || plain.includes('verifying merges')) return 'verify';
  if (plain.includes('tn-writer')) return 'tn-writer';
  if (plain.includes('quality')) return 'quality';
  if (plain.includes('generate') || plain.includes('generation')) return 'generate';
  return 'status';
}

function inferSeverity(message) {
  const plain = stripMarkup(message).toLowerCase();
  if (/\b(failed|error|aborting|abort)\b/.test(plain)) return 'error';
  if (/\b(done|complete|completed|ok|merged to master|restored)\b/.test(plain)) return 'success';
  if (/\b(paused|waiting|deferred|skipped|missing|blocked|could not|invalid|retry window exhausted)\b/.test(plain)) return 'warn';
  if (/\b(running|starting|processing|resuming|verifying|generating|merging|still aligning|aligning)\b/.test(plain)) return 'active';
  return 'info';
}

function normalizeEvent(event) {
  const message = String(event.message || '').trim();
  return {
    timestamp: event.timestamp || new Date().toISOString(),
    source: event.source || 'app',
    pipelineType: event.pipelineType || 'system',
    scope: event.scope || inferScope(message),
    phase: event.phase || inferPhase(message),
    severity: event.severity || inferSeverity(message),
    message,
  };
}

async function publishAdminStatus(event) {
  if (!event || !event.message) return null;
  const normalized = normalizeEvent(event);
  ensureStatusDir();
  fs.appendFileSync(getStatusFile(), JSON.stringify(normalized) + '\n', 'utf8');
  return normalized;
}

function matchesFilter(event, filters) {
  if (filters.scope) {
    const haystack = `${event.scope || ''} ${event.message || ''}`.toLowerCase();
    if (!haystack.includes(String(filters.scope).toLowerCase())) return false;
  }
  if (filters.pipelineType && event.pipelineType !== filters.pipelineType) return false;
  if (filters.severity && event.severity !== filters.severity) return false;
  return true;
}

function readAdminStatus(filters = {}) {
  const file = getStatusFile();
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch (_) {
      // Ignore malformed lines to keep the page resilient.
    }
  }
  return events
    .filter((event) => matchesFilter(event, filters))
    .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')))
    .slice(0, Math.max(1, Number(filters.limit) || DEFAULT_LIMIT));
}

module.exports = {
  getStatusFile,
  inferPhase,
  inferScope,
  inferSeverity,
  normalizeEvent,
  publishAdminStatus,
  readAdminStatus,
};
