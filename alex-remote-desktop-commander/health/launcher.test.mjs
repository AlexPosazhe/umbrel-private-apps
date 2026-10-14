import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

test('launcher serves the UI, reports version and uptime, and shuts its child down', { timeout: 10000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'journal-launcher-'));
  await mkdir(path.join(dir, 'dist'));
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: '@wonderwhy-er/desktop-commander', version: '0.2.52', type: 'module' }));
  const entry = path.join(dir, 'dist/index.js');
  await writeFile(entry, "console.log('FIXTURE_AGENT_PID='+process.pid); setInterval(()=>{},1000); process.on('SIGTERM',()=>process.exit(0));");
  const child = spawn(process.execPath, [fileURLToPath(new URL('launcher.mjs', import.meta.url))], { env: { ...process.env, JOURNAL_DC_ENTRY: entry }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
  const done = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await done; await rm(dir, { recursive: true, force: true }); });
  let status;
  for (let i=0; i<50; i++) {
    try { status = await (await fetch('http://127.0.0.1:3000/api/health')).json(); break; } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  assert.ok(status, output);
  assert.equal(status.version, '0.2.52');
  assert.equal(status.status, 'unknown');
  assert.equal(status.running, true);
  assert.ok(status.uptimeSeconds >= 0);
  for (let i=0; i<30 && !output.includes('FIXTURE_AGENT_PID='); i++) await new Promise(r => setTimeout(r, 20));
  const pid = Number(output.match(/FIXTURE_AGENT_PID=(\d+)/)?.[1]);
  assert.ok(pid, output);
  child.kill('SIGTERM');
  assert.equal((await done)[0], 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
