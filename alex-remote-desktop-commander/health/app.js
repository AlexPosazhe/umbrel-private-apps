const el = id => document.getElementById(id);
let pending = false, sequence = 0, latest = null, receivedAt = 0;
const date = value => value ? new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', hour12: false }) + ' МСК' : '—';
function render(data) {
  const status = {
    healthy: ['Работает', 'Remote MCP выполнил тестовое чтение. Журнал доступен.'],
    problem: ['Проблема', 'Проверка не подтвердила работу RPC или доступ к журналу. Повторите проверку.'],
    disconnected: ['Нет соединения', 'Нет связи с панелью или процесс агента остановлен.'],
    unknown: ['Не подтверждено', 'Свежей успешной проверки пока нет. Online и запущенный процесс не подтверждают работу RPC.'],
  }[data.status];
  el('status').textContent = status[0];
  el('explanation').textContent = status[1];
  el('light').className = 'light ' + data.status;
  el('version').textContent = data.version || '—';
  el('rpc').textContent = { ok: 'Тестовый запрос выполнен', error: 'Не подтверждён', unknown: 'Не проверен' }[data.rpc];
  el('journal').textContent = { ok: 'Чтение доступно', error: 'Чтение не подтверждено', unknown: 'Не проверена' }[data.journal];
  el('success').textContent = data.lastSuccessAt ? date(data.lastSuccessAt) : 'Ещё не было';
  el('checked').textContent = date(data.checkedAt);
  const seconds = data.uptimeSeconds;
  el('uptime').textContent = Number.isFinite(seconds) && data.running ?
    `${Math.floor(seconds / 86400)} д ${Math.floor(seconds / 3600) % 24} ч ${Math.floor(seconds / 60) % 60} мин` : '—';
  el('check').disabled = pending || data.checking;
  el('action').textContent = pending || data.checking ? 'Проверяем полный путь запроса…' : '';
}
async function refresh(manual = false) {
  if (pending) return;
  const request = ++sequence;
  if (manual) { pending = true; el('check').disabled = true; el('action').textContent = 'Проверяем полный путь запроса…'; }
  try {
    const response = await fetch(manual ? '/api/check' : '/api/health', {
      method: manual ? 'POST' : 'GET', cache: 'no-store', signal: AbortSignal.timeout(manual ? 25000 : 5000),
      ...(manual ? { headers: { 'Content-Type': 'application/json', 'X-Journal-Health': '1' }, body: '{}' } : {}),
    });
    if (!response.ok) throw new Error('unavailable');
    const data = await response.json();
    if (request !== sequence) return;
    pending = false; latest = data; receivedAt = performance.now(); render(data);
  } catch {
    if (request !== sequence) return;
    pending = false;
    latest = { ...latest, status: 'disconnected', rpc: 'unknown', journal: 'unknown', running: false, checking: false };
    render(latest);
  }
}
el('check').addEventListener('click', () => refresh(true));
setInterval(() => refresh(), 5000);
setInterval(() => { if (!document.hidden) refresh(true); }, 60000);
// Expire locally too, including when a background tab resumes without a reply.
function expire() {
  if (latest?.status === 'healthy' && performance.now() - receivedAt >= latest.freshForMs) {
    latest = { ...latest, status: 'unknown', rpc: 'unknown', journal: 'unknown' }; render(latest);
  }
}
setInterval(expire, 1000);
document.addEventListener('visibilitychange', () => { expire(); if (!document.hidden) refresh(); });
refresh(true);
