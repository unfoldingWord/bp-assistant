const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

function installStub(modulePath, exportsValue) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: exportsValue,
  };
}

function request(server, reqPath) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const req = http.request({
      host: '127.0.0.1',
      port: address.port,
      path: reqPath,
      method: 'GET',
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer(makeCheckpoints, handler, options = {}) {
  const checkpointsPath = require.resolve('../src/pipeline-checkpoints');
  const mcpPath = require.resolve('../src/mcp-server');
  let checkpoints = [];
  installStub(checkpointsPath, { listCheckpoints: () => checkpoints });
  delete require.cache[mcpPath];
  const originalStartedAt = process.env.PROCESS_STARTED_AT_MS;
  if (options.processStartedAtMs != null) {
    process.env.PROCESS_STARTED_AT_MS = String(options.processStartedAtMs);
  } else {
    delete process.env.PROCESS_STARTED_AT_MS;
  }
  const { createHttpServer } = require('../src/mcp-server');
  // Module is loaded; PROCESS_STARTED_AT_MS is now fixed. Generate
  // checkpoints against the post-load clock so "fresh" timestamps land after
  // the module's start time.
  checkpoints = typeof makeCheckpoints === 'function'
    ? makeCheckpoints(Date.now())
    : makeCheckpoints;
  const server = createHttpServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await handler(server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    delete require.cache[mcpPath];
    delete require.cache[checkpointsPath];
    if (originalStartedAt == null) {
      delete process.env.PROCESS_STARTED_AT_MS;
    } else {
      process.env.PROCESS_STARTED_AT_MS = originalStartedAt;
    }
  }
}

test('/health/pipelines reports running checkpoints updated since process start', async () => {
  await withServer((now) => {
    const fresh = new Date(now + 1000).toISOString();
    return [
      { key: 'a', pipelineType: 'generate', state: 'running', updatedAt: fresh, scope: { book: 'TIT', startChapter: 1, endChapter: 1 } },
      { key: 'b', pipelineType: 'notes',    state: 'failed',  updatedAt: fresh, scope: { book: 'TIT', startChapter: 2, endChapter: 2 } },
    ];
  }, async (server) => {
    const res = await request(server, '/health/pipelines');
    assert.equal(res.status, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.active, 1);
    assert.equal(payload.pipelines.length, 1);
    assert.equal(payload.pipelines[0].pipelineType, 'generate');
    assert.equal(payload.pipelines[0].scope.book, 'TIT');
  });
});

test('/health/pipelines excludes old running checkpoints from a previous process', async () => {
  // Predates process start by definition (1970) and is far outside the
  // freshness window.
  const ancient = new Date(0).toISOString();
  await withServer([
    { key: 'a', pipelineType: 'generate', state: 'running', updatedAt: ancient, scope: { book: 'TIT' } },
  ], async (server) => {
    const res = await request(server, '/health/pipelines');
    const payload = JSON.parse(res.body);
    assert.equal(payload.active, 0);
    assert.equal(payload.pipelines.length, 0);
  });
});

test('/health/pipelines reports recent running checkpoints from a previous process', async () => {
  const startedAt = Date.now();
  await withServer((now) => {
    const interrupted = new Date(now - 10 * 60 * 1000).toISOString();
    return [
      { key: 'a', pipelineType: 'generate', state: 'running', updatedAt: interrupted, scope: { book: 'HOS', startChapter: 12, endChapter: 12 } },
    ];
  }, async (server) => {
    const res = await request(server, '/health/pipelines');
    const payload = JSON.parse(res.body);
    assert.equal(payload.active, 1);
    assert.equal(payload.pipelines[0].scope.book, 'HOS');
    assert.equal(payload.pipelines[0].interrupted, true);
  }, { processStartedAtMs: startedAt });
});

test('/health/pipelines excludes pipelines that have not updated within the freshness window', async () => {
  // Updated 13 hours ago — past the default 12-hour freshness window even if it
  // belongs to this process.
  const now = Date.now();
  const stale = new Date(now - 13 * 60 * 60 * 1000).toISOString();
  await withServer([
    { key: 'a', pipelineType: 'generate', state: 'running', updatedAt: stale, scope: { book: 'TIT' } },
  ], async (server) => {
    const res = await request(server, '/health/pipelines');
    const payload = JSON.parse(res.body);
    assert.equal(payload.active, 0);
  }, { processStartedAtMs: now - 14 * 60 * 60 * 1000 });
});

test('/health/pipelines keeps long-running current-process checkpoints active', async () => {
  const startedAt = Date.now() - 3 * 60 * 60 * 1000;
  await withServer((now) => {
    const longRunning = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    return [
      { key: 'a', pipelineType: 'generate', state: 'running', updatedAt: longRunning, scope: { book: 'ISA', startChapter: 63, endChapter: 63 } },
    ];
  }, async (server) => {
    const res = await request(server, '/health/pipelines');
    const payload = JSON.parse(res.body);
    assert.equal(payload.active, 1);
    assert.equal(payload.pipelines[0].scope.book, 'ISA');
  }, { processStartedAtMs: startedAt });
});

test('/health/pipelines returns active=0 when there are no running checkpoints', async () => {
  await withServer([], async (server) => {
    const res = await request(server, '/health/pipelines');
    assert.equal(res.status, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.active, 0);
    assert.deepEqual(payload.pipelines, []);
    assert.match(payload.processStartedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});
