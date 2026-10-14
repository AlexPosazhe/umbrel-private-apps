import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHealth, remoteProbe, FRESH_MS } from './probe.mjs';
import { createServer } from './server.mjs';
const runtime = () => ({ running: true, version: '0.2.52', uptimeSeconds: 10 });
const ok = async () => true;
const fail = async () => { throw Error('private diagnostic'); };

test('Online and process existence alone never become healthy', () => {
  assert.equal(createHealth({ remote: ok, journal: ok, runtime }).snapshot().status, 'unknown');
});
test('success expires and a failure retains the last successful time', async () => {
  let time = 1000, works = true;
  const h = createHealth({ remote: () => works ? ok() : fail(), journal: ok, runtime, now: () => time, monotonic: () => time });
  assert.equal((await h.check()).status, 'healthy');
  const success = h.snapshot().lastSuccessAt;
  time += FRESH_MS;
  assert.equal(h.snapshot().status, 'unknown');
  works = false;
  assert.equal((await h.check()).status, 'problem');
  assert.equal(h.snapshot().lastSuccessAt, success);
  assert.equal(h.snapshot().rpc, 'error');
});
test('journal read errors prevent green even with working RPC', async () => {
  const h = createHealth({ remote: ok, journal: fail, runtime });
  assert.equal((await h.check()).status, 'problem');
  assert.equal(h.snapshot().lastSuccessAt, null);
});
test('a stopped agent invalidates a fresh success immediately', async () => {
  let running = true;
  const h = createHealth({ remote: ok, journal: ok, runtime: () => ({ ...runtime(), running }) });
  await h.check(); running = false;
  assert.equal(h.snapshot().status, 'disconnected');
});
test('concurrent callers share the same remote operation', async () => {
  let calls = 0;
  const h = createHealth({ remote: async () => { calls++; await new Promise(r => setTimeout(r, 10)); return true; }, journal: ok, runtime });
  await Promise.all([h.check(), h.check(), h.check()]);
  assert.equal(calls, 1);
});
test('timeout aborts, clears green, and late success cannot change it', async () => {
  let finish, signal;
  const h = createHealth({ remote: s => { signal = s; return new Promise(r => { finish = r; }); }, journal: ok, runtime, timeoutMs: 10 });
  assert.equal((await h.check()).status, 'problem');
  assert.equal(signal.aborted, true);
  assert.equal(h.snapshot().journal, 'ok');
  finish(true); await new Promise(r => setImmediate(r));
  assert.equal(h.snapshot().status, 'problem');
});
test('probe targets its own device; rejects errors, acknowledgements and mismatched responses', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'journal-health-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'device.json');
  await writeFile(configPath, JSON.stringify({ deviceId: 'own-device', session: { access_token: 'secret-test-token' } }));
  const content = [{ type: 'text', text: '[Reading 1 lines from start (total: 78 lines, 77 remaining)]\n\n# Canon' }];
  let mode = 'ok';
  const fetchImpl = async (url, init) => {
    assert.equal(url, 'https://mcp.desktopcommander.app/mcp');
    const body = JSON.parse(init.body);
    assert.equal(body.params.arguments.deviceId, 'own-device');
    assert.equal(body.params.arguments.path, '/journal/weekly-log/README.md');
    assert.equal(body.params.name, 'read_file');
    return { ok: mode !== 'http', json: async () => ({ id: mode === 'id' ? 'wrong' : body.id,
      ...(mode === 'rpc' ? { error: { message: 'no live connection' } } : { result: {
        content: mode === 'pending' ? [{ type: 'text', text: 'Script running with call_id 123' }] : content,
        isError: mode === 'tool',
      } }),
    }) };
  };
  assert.equal(await remoteProbe({ configPath, fetchImpl }), true);
  for (mode of ['http', 'id', 'rpc', 'tool', 'pending']) await assert.rejects(remoteProbe({ configPath, fetchImpl }));
  await writeFile(configPath, '{}');
  await assert.rejects(remoteProbe({ configPath, fetchImpl }));
});
test('HTTP serves a closed set of assets and does not expose credentials or raw errors', async t => {
  const health = createHealth({ remote: fail, journal: ok, runtime });
  const server = await createServer(health);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/device.json')).status, 404);
  assert.equal((await fetch(base + '/api/check', { method: 'POST' })).status, 403);
  const response = await fetch(base + '/api/check', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Journal-Health': '1' } });
  const body = await response.text();
  assert.equal(JSON.parse(body).status, 'problem');
  assert.ok(!body.includes('private diagnostic'));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(base + '/api/check', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Journal-Health': '1', 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
});
