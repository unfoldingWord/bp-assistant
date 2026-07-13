// pipeline-output.js — deterministic Door43 output ref derivation for the
// public pipeline API. Source of truth for "where does <pipelineType> for
// <book> <chapter> land on Door43?".
//
// Keep in sync with:
//   - REPO_MAP in src/door43-push.js (resource → repo name)
//   - getRepoFilename in src/door43-push.js (resource → in-repo file path)
//   - branch naming in pipeline-utils.js (`AI-{BOOK}-{CHAPTER}`)

const https = require('https');
const { buildBranchName } = require('../pipeline-utils');

const ORG = 'unfoldingWord';
const GITEA_HOST = 'git.door43.org';
const GITEA_API_PREFIX = '/api/v1';

const REPO_MAP = { tn: 'en_tn', tq: 'en_tq', ult: 'en_ult', ust: 'en_ust' };

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

const PIPELINE_OUTPUT_TYPES = {
  generate: ['ult', 'ust'],
  notes: ['tn'],
  tqs: ['tq'],
  // translate outputs land in {targetOrg}/{targetLang}_tn, which is not
  // derivable from (pipelineType, book) alone. Status for translate runs is
  // served by the persistent 'done' checkpoint (translate-pipeline.js) —
  // the Door43 probe has nothing to probe, so expected outputs are empty.
  translate: [],
};

function rawUrl(repo, file) {
  return `https://${GITEA_HOST}/${ORG}/${repo}/raw/branch/master/${file}`;
}

function fileFor(type, book) {
  const upper = book.toUpperCase();
  if (type === 'tn') return `tn_${upper}.tsv`;
  if (type === 'tq') return `tq_${upper}.tsv`;
  if (type === 'ult' || type === 'ust') {
    const num = BOOK_NUMBERS[upper];
    if (!num) throw new Error(`Unknown book code: ${book}`);
    return `${num}-${upper}.usfm`;
  }
  throw new Error(`Unknown resource type: ${type}`);
}

function getExpectedOutputs(pipelineType, book) {
  const types = PIPELINE_OUTPUT_TYPES[pipelineType];
  if (!types) throw new Error(`Unknown pipelineType: ${pipelineType}`);
  return types.map((type) => {
    const repo = REPO_MAP[type];
    const file = fileFor(type, book);
    return {
      type,
      repo: `${ORG}/${repo}`,
      branch: 'master',
      path: file,
      rawUrl: rawUrl(repo, file),
    };
  });
}

function buildStagingBranch(book, startChapter, endChapter) {
  return buildBranchName(book, startChapter, endChapter);
}

function giteaGet(pathSuffix, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: GITEA_HOST,
      path: `${GITEA_API_PREFIX}${pathSuffix}`,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        ...(token ? { Authorization: `token ${token}` } : {}),
        'User-Agent': 'bp-assistant',
      },
      timeout: 10_000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let data = body;
        try { data = JSON.parse(body); } catch { /* leave as string */ }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('gitea request timed out')); });
    req.end();
  });
}

async function findMergedPr({ repo, branch, token }) {
  const res = await giteaGet(
    `/repos/${ORG}/${repo}/pulls?state=closed&head=${encodeURIComponent(`${ORG}:${branch}`)}&limit=5`,
    token,
  );
  if (res.status !== 200 || !Array.isArray(res.data)) return null;
  for (const pr of res.data) {
    if (pr.merged === true && pr.merged_at && pr.merge_commit_sha) {
      return {
        prNumber: pr.number,
        mergedAt: pr.merged_at,
        commitSha: pr.merge_commit_sha,
      };
    }
  }
  return null;
}

async function detectLandedOutputs({ pipelineType, book, startChapter, endChapter, token }) {
  const branch = buildStagingBranch(book, startChapter, endChapter);
  const expected = getExpectedOutputs(pipelineType, book);
  const results = await Promise.all(expected.map(async (e) => {
    const repoShortName = e.repo.split('/').pop();
    const pr = await findMergedPr({ repo: repoShortName, branch, token });
    if (!pr) return null;
    return { ...e, prNumber: pr.prNumber, mergedAt: pr.mergedAt, commitSha: pr.commitSha };
  }));
  const landed = results.filter(Boolean);
  if (landed.length === 0) return null;
  return landed;
}

module.exports = {
  REPO_MAP,
  PIPELINE_OUTPUT_TYPES,
  getExpectedOutputs,
  buildStagingBranch,
  detectLandedOutputs,
  fileFor,
};
