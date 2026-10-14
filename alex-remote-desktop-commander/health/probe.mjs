import { readFile, open, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const FRESH_MS = 90_000;
const TIMEOUT_MS = 20_000;
const PROBE_PATH = '/journal/weekly-log/README.md';

// One owner (Desktop Commander) refreshes the session. We only read its current
// access token, never refresh it or expose credentials/tool output to the UI.
export async function remoteProbe({ configPath, fetchImpl = fetch, signal }) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (!config.deviceId || !config.session?.access_token) throw new Error('auth');
  const id = randomUUID();
  const response = await fetchImpl('https://mcp.desktopcommander.app/mcp', {
    method: 'POST', signal,
    headers: {
      Authorization: `Bearer ${config.session.access_token}`,
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: {
      name: 'read_file', arguments: { deviceId: config.deviceId, path: PROBE_PATH, offset: 0, length: 1 },
    } }),
  });
  if (!response.ok) throw new Error('remote');
  // Current Remote MCP is stateless and returns JSON; reject unknown protocols
  // or async acknowledgements rather than mistaking them for completed work.
  const envelope = await response.json();
  const result = envelope.result;
  if (envelope.id !== id || envelope.error || !result || result.isError ||
      !Array.isArray(result.content)) throw new Error('remote');
  const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  if (!/^\[Reading 1 lines from start \(total: \d+ lines, \d+ remaining\)\]/.test(text)) {
    throw new Error('remote');
  }
  return true;
}

export async function journalProbe() {
  await readdir('/journal');
  const handle = await open(PROBE_PATH, 'r');
  try {
    if (!(await handle.read(Buffer.alloc(256), 0, 256, 0)).bytesRead) throw new Error('empty');
  } finally { await handle.close(); }
  return true;
}

export function createHealth({ remote, journal = journalProbe, runtime,
  now = () => Date.now(), monotonic = () => performance.now(), timeoutMs = TIMEOUT_MS }) {
  let checkedAt = null, lastSuccessAt = null, completedAt = null;
  let rpc = 'unknown', journalState = 'unknown', inFlight = null;
  const snapshot = () => {
    const processState = runtime();
    const fresh = completedAt !== null && monotonic() - completedAt < FRESH_MS;
    const healthy = fresh && rpc === 'ok' && journalState === 'ok' && processState.running;
    return { status: healthy ? 'healthy' : !processState.running ? 'disconnected' :
      !fresh ? 'unknown' : 'problem', checking: !!inFlight,
      rpc: fresh ? rpc : 'unknown', journal: fresh ? journalState : 'unknown',
      checkedAt, lastSuccessAt, freshForMs: fresh ? Math.max(0, FRESH_MS - (monotonic() - completedAt)) : 0,
      version: processState.version, uptimeSeconds: processState.uptimeSeconds,
      running: processState.running };
  };
  async function run() {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve('error'); }, timeoutMs);
    });
    const check = fn => Promise.race([timeout, Promise.resolve().then(() => fn(controller.signal))
      .then(result => result === true ? 'ok' : 'error', () => 'error')]);
    try {
      [rpc, journalState] = await Promise.all([check(remote), check(journal)]);
      checkedAt = new Date(now()).toISOString();
      completedAt = monotonic();
      if (rpc === 'ok' && journalState === 'ok' && runtime().running) lastSuccessAt = checkedAt;
    } finally { clearTimeout(timer); }
  }
  return { snapshot, check() {
    if (!inFlight) inFlight = run().finally(() => { inFlight = null; });
    return inFlight.then(snapshot);
  } };
}
