// 내부 시험: 가짜 번역, 가짜 텔레그램, 가짜 Turnstile로 서버를 내 컴퓨터에서 켜고 흐름 전체를 확인한다.
// 실행: cd worker && npm test
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import assert from 'node:assert/strict';

const PORT = 8787;
const BASE = `http://localhost:${PORT}`;
const ORIGIN = 'http://localhost:8000';

if (!existsSync('.dev.vars')) copyFileSync('.dev.vars.example', '.dev.vars');
rmSync('.wrangler/state', { recursive: true, force: true });

const server = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--test-scheduled'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
  env: { ...process.env, NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1' },
});
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch (e) { /* 아직 켜지는 중 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not start\n' + log);
}

async function call(method, path, { body, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data, headers: res.headers };
}

const settle = async () => {
  await new Promise((r) => setTimeout(r, 300));
  await call('POST', '/api/dev/process');
};
const tgLog = async () => (await call('GET', '/api/dev/telegram-log')).data;

let passed = 0;
async function step(name, fn) {
  await fn();
  passed++;
  console.log('  ok  ' + name);
}

try {
  await waitForServer();
  console.log('server up, running checks');

  let admin;
  let knockToken;
  let conv;
  let roomKey;
  const room = (extra = {}) => ({ 'X-Room-Key': roomKey, ...extra });

  await step('CORS allows the local site and blocks others', async () => {
    const ok = await fetch(`${BASE}/api/health`, { headers: { Origin: ORIGIN } });
    assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
    const bad = await fetch(`${BASE}/api/health`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
  });

  await step('admin login: wrong password counts down, right password works', async () => {
    const wrong = await call('POST', '/api/admin/login', { body: { password: 'nope' } });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.data.attemptsLeft, 4);
    const right = await call('POST', '/api/admin/login', { body: { password: 'test-password' } });
    assert.equal(right.status, 200);
    admin = { Authorization: 'Bearer ' + right.data.token };
    assert.equal((await call('GET', '/api/admin/overview')).status, 401);
  });

  await step('telegram connect with a code registers the owner', async () => {
    const c = await call('POST', '/api/admin/telegram/connect', { headers: admin });
    assert.equal(c.status, 200);
    const secretless = await call('POST', '/telegram/webhook', { body: {} });
    assert.equal(secretless.status, 403);
    const { webhookSecret } = await import('../src/telegram.js');
    const secret = await webhookSecret('fake-token');
    const send = (message) => fetch(`${BASE}/telegram/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
      body: JSON.stringify({ update_id: Date.now(), message }),
    });
    globalThis.tgSend = send;
    // 남이 먼저 틀린 코드로 와도 등록되지 않는다
    await send({ message_id: 1, chat: { id: 666 }, text: '/start WRONGCODE' });
    await send({ message_id: 2, chat: { id: 4242 }, text: '/start ' + c.data.code });
    await new Promise((r) => setTimeout(r, 400));
    const t = await call('GET', '/api/admin/telegram', { headers: admin });
    assert.equal(t.data.connected, true);
    const logs = await tgLog();
    assert.ok(logs.some((l) => l.chat_id === '4242' && l.text.includes('연결되었어요')));
    assert.ok(!logs.some((l) => l.chat_id === '666'));
  });

  await step('knock: validation, then a knock goes through', async () => {
    const empty = await call('POST', '/api/knock', { body: { name: '', letter: 'hi' } });
    assert.equal(empty.data.error, 'name_required');
    const long = await call('POST', '/api/knock', { body: { name: 'A', letter: 'x'.repeat(1001) } });
    assert.equal(long.data.error, 'letter_too_long');
    const ok = await call('POST', '/api/knock', { body: { name: 'Maria', letter: 'Hola K, ¿cómo estás? (I read your essay on failing at 108 prostrations haha)', lang: 'en-US' } });
    assert.equal(ok.status, 200);
    knockToken = ok.data.token;
    const status = await call('POST', '/api/knock/status', { body: { token: knockToken } });
    assert.equal(status.data.status, 'waiting');
  });

  await step('knock is translated, telegram gets translation and original, admin sees it', async () => {
    await settle();
    const logs = await tgLog();
    const note = logs.find((l) => l.text.includes('새 노크'));
    assert.ok(note, 'knock notification');
    assert.ok(note.text.includes('[ko] Hola K'));
    assert.ok(note.text.includes('원문 (es)'));
    const o = await call('GET', '/api/admin/overview', { headers: admin });
    assert.equal(o.data.knocks.length, 1);
    assert.equal(o.data.knocks[0].lang, 'es');
    assert.ok(o.data.knocks[0].translation.startsWith('[ko]'));
  });

  await step('invite the knock with a first reply; the knocker sees the invitation', async () => {
    const o = await call('GET', '/api/admin/overview', { headers: admin });
    const inv = await call('POST', `/api/admin/knocks/${o.data.knocks[0].id}/invite`, { headers: admin, body: { reply: '반가워요 Maria ㅎㅎ' } });
    assert.equal(inv.status, 200);
    conv = inv.data;
    assert.ok(conv.link.startsWith('http://localhost:8000/chat/#k='));
    const status = await call('POST', '/api/knock/status', { body: { token: knockToken } });
    assert.equal(status.data.status, 'invited');
    roomKey = status.data.roomKey;
    assert.ok(conv.link.endsWith(roomKey));
  });

  await step('visitor room: knock letter first, my reply translated into Spanish, 3 turns open', async () => {
    await settle();
    const r = await call('GET', '/api/room?lang=en-US', { headers: room() });
    assert.equal(r.status, 200);
    assert.equal(r.data.messages.length, 2);
    assert.equal(r.data.messages[0].from, 'you');
    assert.equal(r.data.messages[1].from, 'k');
    assert.equal(r.data.messages[1].text, '[es] 반가워요 Maria ㅎㅎ');
    assert.equal(r.data.messages[1].original, '반가워요 Maria ㅎㅎ');
    assert.equal(r.data.remaining, 3);
  });

  let firstId;
  await step('3-turn rule: three messages, the fourth is refused', async () => {
    for (let i = 1; i <= 3; i++) {
      const s = await call('POST', '/api/room/messages', { headers: room(), body: { text: `Mensaje ${i} ¡gracias!` } });
      assert.equal(s.status, 200);
      assert.equal(s.data.remaining, 3 - i);
      if (i === 1) firstId = s.data.messages.at(-1).id;
    }
    const fourth = await call('POST', '/api/room/messages', { headers: room(), body: { text: 'one more' } });
    assert.equal(fourth.status, 429);
    assert.equal(fourth.data.error, 'turn_limit');
  });

  await step('editing does not use a turn and marks the message edited; telegram gets the new version', async () => {
    await settle();
    const before = (await tgLog()).length;
    const e = await call('PATCH', `/api/room/messages/${firstId}`, { headers: room(), body: { text: 'Mensaje 1 editado ¡ja!' } });
    assert.equal(e.status, 200);
    const msg = e.data.messages.find((m) => m.id === firstId);
    assert.equal(msg.edited, true);
    assert.equal(e.data.remaining, 0);
    await settle();
    const logs = await tgLog();
    assert.ok(logs.slice(before).some((l) => l.text.includes('수정된 메시지') && l.text.includes('Mensaje 1 editado')));
  });

  await step('deleting a message keeps the turn count (no send-delete-send trick)', async () => {
    const d = await call('DELETE', `/api/room/messages/${firstId}`, { headers: room() });
    assert.equal(d.status, 200);
    assert.equal(d.data.messages.find((m) => m.id === firstId).deleted, true);
    assert.equal(d.data.remaining, 0);
    await settle();
    assert.ok((await tgLog()).some((l) => l.text.includes('메시지 하나를 지웠어요')));
  });

  await step('the owner sees Korean translations, and replying reopens 3 turns', async () => {
    const c = await call('GET', `/api/admin/conversations/${conv.id}`, { headers: admin });
    const visitorMsgs = c.data.messages.filter((m) => m.from === 'visitor' && !m.deleted);
    assert.ok(visitorMsgs.every((m) => m.translation && m.translation.startsWith('[ko]')));
    const r = await call('POST', `/api/admin/conversations/${conv.id}/messages`, { headers: admin, body: { text: '고마워요!' } });
    assert.equal(r.status, 200);
    const v = await call('GET', '/api/room', { headers: room() });
    assert.equal(v.data.remaining, 3);
  });

  await step('owner edits and deletes own message', async () => {
    const c = await call('GET', `/api/admin/conversations/${conv.id}`, { headers: admin });
    const mine = c.data.messages.filter((m) => m.from === 'owner').at(-1);
    const e = await call('PATCH', `/api/admin/messages/${mine.id}`, { headers: admin, body: { text: '정말 고마워요!' } });
    assert.equal(e.data.messages.find((m) => m.id === mine.id).edited, true);
    await settle();
    const v = await call('GET', '/api/room', { headers: room() });
    assert.equal(v.data.messages.find((m) => m.id === mine.id).text, '[es] 정말 고마워요!');
    await call('DELETE', `/api/admin/messages/${mine.id}`, { headers: admin });
    const v2 = await call('GET', '/api/room', { headers: room() });
    assert.equal(v2.data.messages.find((m) => m.id === mine.id).deleted, true);
    // 지운 답장도 답장으로 센다
    assert.equal(v2.data.remaining, 3);
  });

  await step('telegram quick reply lands in the same ledger', async () => {
    await settle();
    const logs = await tgLog();
    const note = [...logs].reverse().find((l) => l.text.includes('#' + conv.id) && l.text.includes('메시지'));
    const tgMessageId = 100000 + note.id;
    await globalThis.tgSend({ message_id: 50, chat: { id: 4242 }, text: '텔레그램에서 답장해요', reply_to_message: { message_id: tgMessageId } });
    await new Promise((r) => setTimeout(r, 500));
    await settle();
    const v = await call('GET', '/api/room', { headers: room() });
    assert.equal(v.data.messages.at(-1).text, '[es] 텔레그램에서 답장해요');
    assert.ok((await tgLog()).some((l) => l.text.includes('보냈어요') && l.text.includes('[es] 텔레그램에서 답장해요')));
    // 주인이 아닌 사람의 텔레그램 메시지는 무시된다
    await globalThis.tgSend({ message_id: 51, chat: { id: 666 }, text: 'hack', reply_to_message: { message_id: tgMessageId } });
    await new Promise((r) => setTimeout(r, 400));
    const v2 = await call('GET', '/api/room', { headers: room() });
    assert.notEqual(v2.data.messages.at(-1).text, '[es] hack');
  });

  await step('direct invite with passcode: locked until the passcode is right, then 5 fails lock it', async () => {
    const c = await call('POST', '/api/admin/conversations', { headers: admin, body: { name: 'Tom from the meetup', passcode: 'lotus' } });
    assert.equal(c.status, 200);
    const key = c.data.link.split('#k=')[1];
    const noPass = await call('GET', '/api/room', { headers: { 'X-Room-Key': key } });
    assert.equal(noPass.data.error, 'passcode_required');
    const wrong = await call('POST', '/api/room/unlock', { headers: { 'X-Room-Key': key }, body: { passcode: 'nope' } });
    assert.equal(wrong.data.error, 'wrong_passcode');
    const right = await call('POST', '/api/room/unlock', { headers: { 'X-Room-Key': key }, body: { passcode: 'lotus' } });
    const ok = await call('GET', '/api/room?lang=en-GB', { headers: { 'X-Room-Key': key, 'X-Room-Unlock': right.data.unlock } });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.remaining, 3);
    for (let i = 0; i < 5; i++) await call('POST', '/api/room/unlock', { headers: { 'X-Room-Key': key }, body: { passcode: 'bad' } });
    const locked = await call('POST', '/api/room/unlock', { headers: { 'X-Room-Key': key }, body: { passcode: 'lotus' } });
    assert.equal(locked.data.error, 'locked');
  });

  await step('direct invite without language: my message waits, then is translated once the visitor arrives', async () => {
    const c = await call('POST', '/api/admin/conversations', { headers: admin, body: { name: 'Lee' } });
    await call('POST', `/api/admin/conversations/${c.data.id}/messages`, { headers: admin, body: { text: '어서 오세요' } });
    await settle();
    const key = c.data.link.split('#k=')[1];
    const first = await call('GET', '/api/room?lang=fr-FR', { headers: { 'X-Room-Key': key } });
    assert.equal(first.data.messages[0].translating, true);
    await settle();
    const later = await call('GET', '/api/room', { headers: { 'X-Room-Key': key } });
    assert.equal(later.data.messages[0].text, '[fr-FR] 어서 오세요');
  });

  await step('revoke closes the link', async () => {
    const c = await call('POST', '/api/admin/conversations', { headers: admin, body: { name: 'Temp' } });
    const key = c.data.link.split('#k=')[1];
    await call('POST', `/api/admin/conversations/${c.data.id}/revoke`, { headers: admin });
    const r = await call('GET', '/api/room', { headers: { 'X-Room-Key': key } });
    assert.equal(r.status, 410);
  });

  await step('the visitor deletes the whole conversation', async () => {
    const d = await call('DELETE', '/api/room', { headers: room() });
    assert.equal(d.data.deleted, true);
    assert.equal((await call('GET', '/api/room', { headers: room() })).status, 404);
    assert.equal((await call('POST', '/api/knock/status', { body: { token: knockToken } })).data.status, 'gone');
    await settle();
    assert.ok((await tgLog()).some((l) => l.text.includes('대화 전체를 지웠어요')));
  });

  await step('the scheduled job runs', async () => {
    const r = await fetch(`${BASE}/__scheduled?cron=*/2+*+*+*+*`);
    assert.equal(r.status, 200);
  });

  await step('admin lockout after 5 wrong passwords', async () => {
    for (let i = 0; i < 5; i++) await call('POST', '/api/admin/login', { body: { password: 'bad' } });
    const locked = await call('POST', '/api/admin/login', { body: { password: 'test-password' } });
    assert.equal(locked.data.error, 'locked');
  });

  console.log(`\nall ${passed} checks passed`);
} catch (e) {
  console.error('\nFAILED:', e);
  console.error('\n--- server log (tail) ---\n' + log.slice(-4000));
  process.exitCode = 1;
} finally {
  // 서버와 그 자식 프로세스를 함께 끈다
  try { process.kill(-server.pid, 'SIGTERM'); } catch (e) { server.kill('SIGTERM'); }
  setTimeout(() => process.exit(), 500);
}
