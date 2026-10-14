import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { createHealth, remoteProbe } from './probe.mjs';
import { createServer } from './server.mjs';

// npm exec supplies the exact pinned binary. Preserve the existing HOME and
// device session volume; there is still just one Remote MCP agent process.
const entry = await realpath(process.env.JOURNAL_DC_ENTRY);
const pkg = JSON.parse(await readFile(path.resolve(path.dirname(entry), '../package.json'), 'utf8'));
if (pkg.name !== '@wonderwhy-er/desktop-commander' || pkg.version !== '0.2.52') {
  throw new Error('Unexpected Desktop Commander package');
}
let startedAt = 0, running = false, stopping = false;
const health = createHealth({
  runtime: () => ({ running, version: pkg.version, uptimeSeconds: Math.floor((performance.now() - startedAt) / 1000) }),
  remote: signal => remoteProbe({ configPath: path.join(os.homedir(), '.desktop-commander-device/device.json'), signal }),
});
// Load HTTP assets before spawning so spawn errors cannot race an await.
const server = await createServer(health);
startedAt = performance.now();
const agent = spawn(process.execPath, [entry, 'remote'], { stdio: 'inherit', detached: true });
running = true;
server.on('error', () => stop(1));
server.listen(3000, '0.0.0.0');
function stop(code) {
  if (stopping) return;
  stopping = true;
  server.close();
  try { process.kill(-agent.pid, 'SIGTERM'); } catch { /* already exited */ }
  const deadline = setTimeout(() => {
    try { process.kill(-agent.pid, 'SIGKILL'); } catch { /* already exited */ }
    process.exit(code);
  }, 8_000);
  deadline.unref();
  if (!running) process.exit(code);
  agent.once('exit', () => process.exit(code));
}
agent.on('error', () => { running = false; stop(1); });
agent.on('exit', () => { running = false; if (!stopping) stop(1); });
process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));
