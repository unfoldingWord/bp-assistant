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

async function withServer(makeCheckpoints, handler) {
  const checkpointsPath = require.resolve('../src/pipeline-checkpoints');
  const mcpPath = require.resolve('../src/mcp-server');
  let checkpoints = [];
  installStub(checkpointsPath, { listCheckpoints: () => checkpoints });
  delete require.cache[mcpPath];
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

test('/health/pipelines excludes stale running checkpoints from a previous process', async () => {
  // Predates process start by definition (1970).
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

test('/health/pipelines excludes pipelines that have not updated within the freshness window', async () => {
  // Updated 2 hours ago — past the 60-minute freshness window even if it
  // somehow predates process start in absolute terms.
  const stale = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  await withServer([
    { key: 'a', pipelineType: 'generate', state: 'running', updatedAt: stale, scope: { book: 'TIT' } },
  ], async (server) => {
    const res = await request(server, '/health/pipelines');
    const payload = JSON.parse(res.body);
    assert.equal(payload.active, 0);
  });
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
