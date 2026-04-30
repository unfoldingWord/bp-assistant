// mcp-server.js — MCP server exposing Bible translation data for TN writing
// Runs in-process with the zulip-bot, serving Door43 and local CSV data.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { readSecret } = require('./secrets');
const { readAdminStatus } = require('./admin-status');
const { listCheckpoints } = require('./pipeline-checkpoints');

const ADMIN_PORT = Number(process.env.PORT || 8080);
const MCP_PORT = Number(process.env.MCP_PORT || 3001);
const MCP_BIND_HOST = process.env.MCP_BIND_HOST || '127.0.0.1';
const DOOR43_BASE = 'https://git.door43.org/unfoldingWord';

const PROCESS_STARTED_AT_MS = Date.now();

// Checkpoints not touched within this window are treated as crashed/stale even
// if the bot didn't restart — prevents a hung pipeline from blocking deploys
// forever.
const CHECKPOINT_FRESHNESS_MS = 60 * 60 * 1000;

function getActivePipelines() {
  const now = Date.now();
  const rows = [];
  for (const cp of listCheckpoints()) {
    if (cp?.state !== 'running') continue;
    const updatedMs = Date.parse(cp.updatedAt || '');
    if (!Number.isFinite(updatedMs)) continue;
    // Stale: checkpoint predates this process (left over from a kill).
    if (updatedMs < PROCESS_STARTED_AT_MS) continue;
    const ageMs = now - updatedMs;
    if (ageMs > CHECKPOINT_FRESHNESS_MS) continue;
    rows.push({
      key: cp.key,
      pipelineType: cp.pipelineType,
      scope: cp.scope,
      updatedAt: cp.updatedAt,
      ageSeconds: Math.round(ageMs / 1000),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Book number map
// ---------------------------------------------------------------------------

const BOOK_NUMBERS = {
  GEN: '01', EXO: '02', LEV: '03', NUM: '04', DEU: '05',
  JOS: '06', JDG: '07', RUT: '08', '1SA': '09', '2SA': '10',
  '1KI': '11', '2KI': '12', '1CH': '13', '2CH': '14', EZR: '15',
  NEH: '16', EST: '17', JOB: '18', PSA: '19', PRO: '20',
  ECC: '21', SNG: '22', ISA: '23', JER: '24', LAM: '25',
  EZK: '26', DAN: '27', HOS: '28', JOL: '29', AMO: '30',
  OBA: '31', JON: '32', MIC: '33', NAM: '34', HAB: '35',
  ZEP: '36', HAG: '37', ZEC: '38', MAL: '39',
  MAT: '41', MRK: '42', LUK: '43', JHN: '44', ACT: '45',
  ROM: '46', '1CO': '47', '2CO': '48', GAL: '49', EPH: '50',
  PHP: '51', COL: '52', '1TH': '53', '2TH': '54', '1TI': '55',
  '2TI': '56', TIT: '57', PHM: '58', HEB: '59', JAS: '60',
  '1PE': '61', '2PE': '62', '1JN': '63', '2JN': '64', '3JN': '65',
  JUD: '66', REV: '67',
};

// ---------------------------------------------------------------------------
// In-memory cache (loaded once per process lifetime)
// ---------------------------------------------------------------------------

const cache = {
  validIssues: null,   // Set<string>
  templates: null,     // Map<string, Array<{type, template}>>
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const makeRequest = (targetUrl, redirectCount) => {
      if (redirectCount > 5) return reject(new Error('Too many redirects'));
      const mod = targetUrl.startsWith('https') ? https : http;
      mod.get(targetUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          makeRequest(res.headers.location, redirectCount + 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${targetUrl}`));
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve(data));
        res.on('error', reject);
      }).on('error', reject);
    };
    makeRequest(url, 0);
  });
}

function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim() && !l.startsWith('#'));
  return lines.map(line => {
    const row = [];
    let field = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuote = !inQuote;
        }
      } else if (ch === ',' && !inQuote) {
        row.push(field);
        field = '';
      } else {
        field += ch;
      }
    }
    row.push(field);
    return row;
  });
}

function extractChapterVerse(usfm, chapter, verse) {
  // Match \c N followed by non-digit (avoid matching \c 1 when looking for \c 12)
  const chapterRe = new RegExp(`\\\\c ${chapter}(?:\\D|$)`);
  const chapterMatch = chapterRe.exec(usfm);
  if (!chapterMatch) return null;
  const chapterStart = chapterMatch.index;

  // Find next chapter or end of file
  const nextChapterRe = new RegExp(`\\\\c ${chapter + 1}(?:\\D|$)`);
  const nextChapterMatch = nextChapterRe.exec(usfm.slice(chapterStart + 1));
  const chapterContent = nextChapterMatch
    ? usfm.slice(chapterStart, chapterStart + 1 + nextChapterMatch.index)
    : usfm.slice(chapterStart);

  // Find verse marker \v N followed by non-digit
  const verseRe = new RegExp(`\\\\v ${verse}(?:\\D|$)`);
  const verseMatch = verseRe.exec(chapterContent);
  if (!verseMatch) return null;
  const contentStart = verseMatch.index + verseMatch[0].length;

  // Find next verse
  const nextVerseIdx = chapterContent.slice(contentStart).search(/\\v \d/);
  const verseContent = nextVerseIdx !== -1
    ? chapterContent.slice(contentStart, contentStart + nextVerseIdx)
    : chapterContent.slice(contentStart);

  return verseContent.trim();
}

function parseAlignment(verseUsfm) {
  const alignments = [];
  let pos = 0;
  const text = verseUsfm;

  while (pos < text.length) {
    const zalnStart = text.indexOf('\\zaln-s', pos);
    if (zalnStart === -1) break;

    // Find closing \* of the opening milestone tag
    const tagClose = text.indexOf('\\*', zalnStart);
    if (tagClose === -1) break;

    // Extract x-content from the tag attributes
    const tagText = text.slice(zalnStart, tagClose);
    const contentMatch = tagText.match(/x-content="([^"]+)"/);
    const hebrew = contentMatch ? contentMatch[1] : null;

    // Find closing \zaln-e\*
    const zalnEnd = text.indexOf('\\zaln-e\\*', tagClose);
    if (zalnEnd === -1) break;

    // Extract English words from \w WORD|attrs\w* within the block
    const block = text.slice(tagClose + 2, zalnEnd);
    const wordPattern = /\\w ([^|\\]+?)(?:\|[^\\]*)?\\w\*/g;
    const words = [];
    let wMatch;
    while ((wMatch = wordPattern.exec(block)) !== null) {
      words.push(wMatch[1].trim());
    }

    if (hebrew && words.length > 0) {
      alignments.push({ english: words.join(' '), hebrew });
    }

    pos = zalnEnd + 9; // length of \zaln-e\*
  }

  return alignments;
}

function stripMarkup(verseUsfm) {
  // Extract English words from \w tags
  const wordPattern = /\\w ([^|\\]+?)(?:\|[^\\]*)?\\w\*/g;
  const words = [];
  let match;
  while ((match = wordPattern.exec(verseUsfm)) !== null) {
    words.push(match[1].trim());
  }
  if (words.length > 0) return words.join(' ');

  // Fallback for unaligned USFM: strip tags
  return verseUsfm
    .replace(/\\[a-z-]+\*?\s*/g, '')
    .replace(/\|[^\s\\]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// CSV cache loader
// ---------------------------------------------------------------------------

function loadCache() {
  if (cache.validIssues && cache.templates) return;

  const workspaceDir = process.env.CSKILLBP_DIR || '';
  const dataDirCandidates = [
    workspaceDir ? path.join(workspaceDir, 'data') : null,
    '/data/workspace/data',
    '/srv/bot/workspace/data',
    '/workspace/data',
    '/srv/bot/app/data',
  ].filter(Boolean);

  let issuesPath = null;
  let templatesPath = null;
  for (const dataDir of dataDirCandidates) {
    const issuesCandidate = path.join(dataDir, 'translation-issues.csv');
    const templatesCandidate = path.join(dataDir, 'templates.csv');
    if (fs.existsSync(issuesCandidate) && fs.existsSync(templatesCandidate)) {
      issuesPath = issuesCandidate;
      templatesPath = templatesCandidate;
      break;
    }
  }

  if (!issuesPath || !templatesPath) {
    console.warn(`[mcp] Cache preload skipped: translation CSVs not found in any candidate data dir: ${dataDirCandidates.join(', ')}`);
    return;
  }

  const issuesText = fs.readFileSync(issuesPath, 'utf8');
  const issueRows = parseCSV(issuesText);
  // Skip header row (first: "issue,last_updated")
  cache.validIssues = new Set(
    issueRows.slice(1).map(r => r[0]).filter(Boolean)
  );

  const templatesText = fs.readFileSync(templatesPath, 'utf8');
  const templateRows = parseCSV(templatesText);
  // Header: support reference, type, note template — skip it
  cache.templates = new Map();
  for (const row of templateRows.slice(1)) {
    if (!row[0] || !row[2]) continue;
    const issueType = row[0].trim();
    const type = row[1] ? row[1].trim() : 'generic';
    const template = row[2].trim();
    if (!cache.templates.has(issueType)) {
      cache.templates.set(issueType, []);
    }
    cache.templates.get(issueType).push({ type, template });
  }
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function getVerseData({ book, chapter, verse }) {
  const bookUpper = book.toUpperCase();
  const num = BOOK_NUMBERS[bookUpper];
  if (!num) throw new Error(`Unknown book: ${book}`);

  const filename = `${num}-${bookUpper}.usfm`;
  const [ultUsfm, ustUsfm] = await Promise.all([
    fetchText(`${DOOR43_BASE}/en_ult/raw/branch/master/${filename}`),
    fetchText(`${DOOR43_BASE}/en_ust/raw/branch/master/${filename}`),
  ]);

  const ultVerse = extractChapterVerse(ultUsfm, chapter, verse);
  if (!ultVerse) throw new Error(`Verse ${book} ${chapter}:${verse} not found in ULT`);

  const ustVerse = extractChapterVerse(ustUsfm, chapter, verse);

  return {
    ult: stripMarkup(ultVerse),
    ust: ustVerse ? stripMarkup(ustVerse) : '',
    alignment: parseAlignment(ultVerse),
  };
}

async function getExistingNotes({ book, chapter }) {
  const bookUpper = book.toUpperCase();
  const tsv = await fetchText(`${DOOR43_BASE}/en_tn/raw/branch/master/tn_${bookUpper}.tsv`);

  const prefix = `${chapter}:`;
  const notes = [];

  for (const line of tsv.split('\n')) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    if (cols.length < 7) continue;
    const ref = cols[0];
    if (!ref.startsWith(prefix)) continue;
    notes.push({
      reference: ref,
      id: cols[1] || '',
      support_reference: cols[3] || '',
      quote: cols[4] || '',
      note: cols[cols.length - 1] || '',  // Note is last column (7-col or 9-col format)
    });
  }

  return notes;
}

function getTemplate({ issue_type }) {
  loadCache();
  if (!cache.validIssues || !cache.templates) {
    throw new Error('Template cache unavailable: translation CSV files were not found in known data directories.');
  }

  const issueKey = issue_type.trim().toLowerCase();

  let matchedKey = null;
  for (const key of cache.validIssues) {
    if (key.toLowerCase() === issueKey) {
      matchedKey = key;
      break;
    }
  }

  if (!matchedKey) {
    return {
      error: `Unknown issue type '${issue_type}'. Valid types are fetched from the issues sheet.`,
      issues_sheet: 'https://docs.google.com/spreadsheets/d/1fyD4dCcrJB3UWXk-VPeoiFTh4wPc_BEuOy6PxylYv5Y/',
    };
  }

  const templates = cache.templates.get(matchedKey) || [];
  return {
    issue_type: matchedKey,
    templates,
  };
}

// ---------------------------------------------------------------------------
// MCP server factory
// ---------------------------------------------------------------------------

function createMcpServer() {
  const server = new McpServer({
    name: 'bt-pipeline-mcp',
    version: '1.0.0',
  });

  server.tool(
    'get_verse_data',
    'Fetch ULT and UST text for a verse, plus Hebrew alignment map from Door43.',
    {
      book: z.string().describe('3-letter book code, e.g. "HAB"'),
      chapter: z.number().int().positive().describe('Chapter number'),
      verse: z.number().int().positive().describe('Verse number'),
    },
    async ({ book, chapter, verse }) => {
      try {
        const result = await getVerseData({ book, chapter, verse });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'get_existing_notes',
    'Fetch published translation notes for a chapter from Door43.',
    {
      book: z.string().describe('3-letter book code, e.g. "HAB"'),
      chapter: z.number().int().positive().describe('Chapter number'),
    },
    async ({ book, chapter }) => {
      try {
        const notes = await getExistingNotes({ book, chapter });
        return { content: [{ type: 'text', text: JSON.stringify(notes, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'get_template',
    'Validate an issue type and return its note template(s). Returns error for unknown types.',
    {
      issue_type: z.string().describe('Issue type, e.g. "figs-metaphor"'),
    },
    ({ issue_type }) => {
      try {
        const result = getTemplate({ issue_type });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
          isError: true,
        };
      }
    }
  );

  // ── Curation tool ──────────────────────────────────────────────────────

  const { curatePublishedData } = require('./curate-data');

  server.tool(
    'curate_published_data',
    'Fetch/update published Bible translation data from Door43 and Google, extract unaligned English, resolve GL quotes, and rebuild search indexes. Use step="setup" for initial population on a new host, step="check" for dry-run, or omit step for a normal update.',
    {
      step: z.enum(['check', 'setup', 'fetch-door43', 'fetch-google', 'extract-english', 'resolve-quotes', 'build-indexes']).optional().describe('Run a specific step, or omit for full run. "setup" = force-fetch everything (initial population). "check" = dry-run report.'),
      force: z.boolean().optional().describe('Ignore cache and refetch everything (default: false)'),
    },
    async ({ step, force }) => {
      try {
        const result = await curatePublishedData({ step, force });
        return { content: [{ type: 'text', text: result.messages.join('\n') }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
          isError: true,
        };
      }
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function safeCompare(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleString('en-US', {
      timeZone: 'America/Chicago',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch (_) {
    return String(ts || '');
  }
}

function renderAdminPage(events, filters) {
  const initialEvents = JSON.stringify(events);
  const listMarkup = events.length
    ? events.map((event) => {
      const parts = [
        `<time title="${escapeHtml(event.timestamp)}">${escapeHtml(fmtTime(event.timestamp))}</time>`,
        event.pipelineType ? `<span class="pipe">${escapeHtml(event.pipelineType)}</span>` : '',
        event.scope ? `<span class="scope">${escapeHtml(event.scope)}</span>` : '',
        event.phase ? `<span class="phase">${escapeHtml(event.phase)}</span>` : '',
        `<span class="sev">${escapeHtml(event.severity)}</span>`,
      ].filter(Boolean).join('');
      return `<li class="event severity-${escapeHtml(event.severity)}"><div class="meta">${parts}</div><div class="message">${escapeHtml(event.message)}</div></li>`;
    }).join('')
    : '<li class="empty">No status events yet.</li>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Admin Status Board</title>
  <style>
    :root { color-scheme: light; --bg:#f6f1e5; --panel:#fffdf8; --ink:#1c1d19; --muted:#6f7268; --line:#d8d1bf; --active:#0f766e; --success:#3f6212; --warn:#b45309; --error:#b91c1c; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: linear-gradient(180deg, #ece4d2 0%, #f7f3e9 100%); color: var(--ink); }
    main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 40px; }
    h1 { margin: 0 0 8px; font-size: 28px; }
    p { margin: 0 0 20px; color: var(--muted); }
    form { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; background: var(--panel); border: 1px solid var(--line); padding: 14px; border-radius: 14px; position: sticky; top: 12px; }
    label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.08em; }
    input, select, button { width: 100%; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; font: inherit; background: #fff; color: var(--ink); }
    button { background: #1c1d19; color: #fff; cursor: pointer; }
    ul { list-style: none; padding: 0; margin: 18px 0 0; display: grid; gap: 12px; }
    .event, .empty { background: var(--panel); border: 1px solid var(--line); border-left: 6px solid var(--line); border-radius: 12px; padding: 14px; }
    .severity-active { border-left-color: var(--active); }
    .severity-success { border-left-color: var(--success); }
    .severity-warn { border-left-color: var(--warn); }
    .severity-error { border-left-color: var(--error); }
    .meta { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; color: var(--muted); font-size: 12px; }
    .meta span, .meta time { background: #f4efe2; padding: 2px 6px; border-radius: 999px; }
    .message { white-space: pre-wrap; line-height: 1.45; }
    .empty { color: var(--muted); }
    @media (max-width: 800px) { form { grid-template-columns: 1fr 1fr; } }
    @media (max-width: 560px) { form { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <h1>Admin Status Board</h1>
    <p>Curated operator status only. Use Fly for full logs.</p>
    <form id="filters">
      <div>
        <label for="scope">Scope</label>
        <input id="scope" name="scope" value="${escapeHtml(filters.scope || '')}" placeholder="NUM 17">
      </div>
      <div>
        <label for="pipelineType">Pipeline</label>
        <select id="pipelineType" name="pipelineType">
          <option value="">All</option>
          <option value="generate"${filters.pipelineType === 'generate' ? ' selected' : ''}>generate</option>
          <option value="notes"${filters.pipelineType === 'notes' ? ' selected' : ''}>notes</option>
          <option value="tqs"${filters.pipelineType === 'tqs' ? ' selected' : ''}>tqs</option>
          <option value="resume"${filters.pipelineType === 'resume' ? ' selected' : ''}>resume</option>
          <option value="system"${filters.pipelineType === 'system' ? ' selected' : ''}>system</option>
        </select>
      </div>
      <div>
        <label for="severity">Severity</label>
        <select id="severity" name="severity">
          <option value="">All</option>
          <option value="active"${filters.severity === 'active' ? ' selected' : ''}>active</option>
          <option value="success"${filters.severity === 'success' ? ' selected' : ''}>success</option>
          <option value="warn"${filters.severity === 'warn' ? ' selected' : ''}>warn</option>
          <option value="error"${filters.severity === 'error' ? ' selected' : ''}>error</option>
          <option value="info"${filters.severity === 'info' ? ' selected' : ''}>info</option>
        </select>
      </div>
      <div>
        <label>&nbsp;</label>
        <button type="submit">Refresh</button>
      </div>
    </form>
    <ul id="events">${listMarkup}</ul>
  </main>
  <script>
    const initialEvents = ${initialEvents};
    const list = document.getElementById('events');
    const form = document.getElementById('filters');

    function esc(text) {
      return String(text || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    }

    function fmtTime(ts) {
      try {
        return new Date(ts).toLocaleString('en-US', {
          timeZone: 'America/Chicago',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        });
      } catch (_) {
        return String(ts || '');
      }
    }

    function render(events) {
      if (!events.length) {
        list.innerHTML = '<li class="empty">No status events yet.</li>';
        return;
      }
      list.innerHTML = events.map((event) => {
        const parts = [
          '<time title="' + esc(event.timestamp) + '">' + esc(fmtTime(event.timestamp)) + '</time>',
          event.pipelineType ? '<span class="pipe">' + esc(event.pipelineType) + '</span>' : '',
          event.scope ? '<span class="scope">' + esc(event.scope) + '</span>' : '',
          event.phase ? '<span class="phase">' + esc(event.phase) + '</span>' : '',
          '<span class="sev">' + esc(event.severity) + '</span>',
        ].filter(Boolean).join('');
        return '<li class="event severity-' + esc(event.severity) + '"><div class="meta">' + parts + '</div><div class="message">' + esc(event.message) + '</div></li>';
      }).join('');
    }

    async function refresh() {
      const params = new URLSearchParams();
      for (const key of ['scope', 'pipelineType', 'severity']) {
        const value = form.elements[key].value.trim();
        if (value) params.set(key, value);
      }
      const res = await fetch('/admin/status?' + params.toString(), { headers: { 'Accept': 'application/json' } });
      if (!res.ok) return;
      const payload = await res.json();
      render(payload.events || []);
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      refresh().catch(() => {});
    });

    render(initialEvents);
    setInterval(() => { refresh().catch(() => {}); }, 5000);
  </script>
</body>
</html>`;
}

function requireAdminAuth(req, res, password) {
  if (!password) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ADMIN_PAGE_PASSWORD is not configured.');
    return false;
  }

  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Basic ')) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="BP Admin"' });
    res.end('Authentication required.');
    return false;
  }

  let decoded = '';
  try {
    decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
  } catch (_) {
    decoded = '';
  }
  const sep = decoded.indexOf(':');
  const username = sep === -1 ? '' : decoded.slice(0, sep);
  const suppliedPassword = sep === -1 ? '' : decoded.slice(sep + 1);

  if (!safeCompare(username, 'admin') || !safeCompare(suppliedPassword, password)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="BP Admin"' });
    res.end('Authentication required.');
    return false;
  }

  return true;
}

function createHttpServer() {
  const adminPassword = readSecret('admin_page_password', 'ADMIN_PAGE_PASSWORD');
  return http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const reqUrl = new URL(req.url, 'http://localhost');
    const urlPath = reqUrl.pathname;

    if (req.method === 'GET' && urlPath === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'bt-pipeline-mcp' }));
      return;
    }

    if (req.method === 'GET' && urlPath === '/health/pipelines') {
      const pipelines = getActivePipelines();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        active: pipelines.length,
        processStartedAt: new Date(PROCESS_STARTED_AT_MS).toISOString(),
        pipelines,
      }));
      return;
    }

    if (urlPath === '/admin' || urlPath === '/admin/status') {
      if (!requireAdminAuth(req, res, adminPassword)) return;
      const filters = {
        scope: reqUrl.searchParams.get('scope') || '',
        pipelineType: reqUrl.searchParams.get('pipelineType') || '',
        severity: reqUrl.searchParams.get('severity') || '',
        limit: Number(reqUrl.searchParams.get('limit') || 200),
      };
      const events = readAdminStatus(filters);
      if (urlPath === '/admin/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ events }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderAdminPage(events, filters));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
}

function createMcpHttpServer(token) {
  return http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const reqUrl = new URL(req.url, 'http://localhost');
    const urlPath = reqUrl.pathname;

    if (req.method === 'GET' && urlPath === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'bt-pipeline-mcp' }));
      return;
    }

    if (urlPath === '/mcp') {
      const auth = req.headers.authorization || '';
      const urlToken = reqUrl.searchParams.get('token') || '';
      const authed = auth === `Bearer ${token}` || urlToken === token;
      if (!authed) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      res.on('close', () => {
        transport.close();
        mcpServer.close();
      });

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
}

function startAdminServer() {
  const httpServer = createHttpServer();
  httpServer.listen(ADMIN_PORT, '0.0.0.0', () => {
    console.log(`[admin] Admin server listening on port ${ADMIN_PORT}`);
  });
}

function startMcpServer() {
  const token = readSecret('bt_mcp_api_token', 'BT_MCP_API_TOKEN');
  if (!token) {
    console.warn('[mcp] bt_mcp_api_token is missing. MCP server disabled.');
    return;
  }

  try {
    loadCache();
    if (cache.validIssues && cache.templates) {
      console.log(`[mcp] Loaded ${cache.validIssues.size} issue types, ${cache.templates.size} template entries`);
    } else {
      console.warn('[mcp] Cache not loaded at startup; will retry on first template request.');
    }
  } catch (err) {
    console.warn(`[mcp] Cache preload failed (will retry on first request): ${err.message}`);
    cache.validIssues = null;
    cache.templates = null;
  }

  const httpServer = createMcpHttpServer(token);

  httpServer.listen(MCP_PORT, MCP_BIND_HOST, () => {
    console.log(`[mcp] MCP server listening on ${MCP_BIND_HOST}:${MCP_PORT}`);
  });
}

module.exports = { startAdminServer, startMcpServer, createHttpServer, createMcpHttpServer };
