const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

function request(server, reqPath, options = {}) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const req = http.request({
      host: '127.0.0.1',
      port: address.port,
      path: reqPath,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end(options.body || '');
  });
}

test('admin routes require auth and render status events while health stays public', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-admin-'));
  const oldPassword = process.env.ADMIN_PAGE_PASSWORD;
  const oldStatusFile = process.env.ADMIN_STATUS_FILE;
  process.env.ADMIN_PAGE_PASSWORD = 'secret-pass';
  process.env.ADMIN_STATUS_FILE = path.join(tempDir, 'admin-status.jsonl');
  fs.writeFileSync(process.env.ADMIN_STATUS_FILE, [
    JSON.stringify({
      timestamp: '2026-04-24T18:00:00.000Z',
      source: 'generate-pipeline',
      pipelineType: 'generate',
      scope: 'NUM 17',
      phase: 'align',
      severity: 'active',
      message: 'Still aligning NUM 17 — 10min, 94 tool calls',
    }),
  ].join('\n') + '\n');

  delete require.cache[require.resolve('../src/mcp-server')];
  const { createHttpServer } = require('../src/mcp-server');
  const server = createHttpServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const health = await request(server, '/health');
    assert.equal(health.status, 200);
    assert.match(health.body, /"ok":true/);

    const unauth = await request(server, '/admin');
    assert.equal(unauth.status, 401);
    assert.equal(unauth.headers['www-authenticate'], 'Basic realm="BP Admin"');

    const authHeader = `Basic ${Buffer.from('admin:secret-pass').toString('base64')}`;
    const page = await request(server, '/admin', { headers: { Authorization: authHeader } });
    assert.equal(page.status, 200);
    assert.match(page.body, /Admin Status Board/);
    assert.match(page.body, /Still aligning NUM 17/);

    const status = await request(server, '/admin/status?scope=NUM%2017', { headers: { Authorization: authHeader } });
    assert.equal(status.status, 200);
    const payload = JSON.parse(status.body);
    assert.equal(payload.events.length, 1);
    assert.equal(payload.events[0].scope, 'NUM 17');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (oldPassword == null) delete process.env.ADMIN_PAGE_PASSWORD;
    else process.env.ADMIN_PAGE_PASSWORD = oldPassword;
    if (oldStatusFile == null) delete process.env.ADMIN_STATUS_FILE;
    else process.env.ADMIN_STATUS_FILE = oldStatusFile;
    delete require.cache[require.resolve('../src/mcp-server')];
  }
});
