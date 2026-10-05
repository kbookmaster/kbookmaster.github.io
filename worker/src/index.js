// 채팅 코너 서버의 입구. 주소별로 할 일을 나눈다.
import { ensureSchema, first, all, run, getSetting, setSetting, deleteConversation } from './db.js';
import { LIMITS, SECURITY } from './config.js';
import {
  HttpError, json, readJson, randomToken, randomCode, sha256hex, safeEqual,
  charCount, cleanName, cleanLang, cleanText, today,
} from './util.js';
import {
  addVisitorMessage, addOwnerMessage, editMessage, softDeleteMessage, createConversation, inviteKnock,
  setConversationLang, processPending, visitorRoomView, ownerRoomView, conversationSummary,
  checkMessageText, inviteLink,
} from './logic.js';
import {
  enqueue, callTelegram, webhookSecret, sendText, findReplyTarget, deletedMessageText, deletedConversationText,
  sentConfirmText,
} from './telegram.js';

// ---------- 가짜 모드와 출입 허가 ----------

function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

// 가짜 스위치는 사이트 주소와 요청 주소가 모두 내 컴퓨터일 때만 듣는다
function getFlags(env, request) {
  let local = false;
  try { local = isLocalHost(new URL(env.SITE_URL).hostname); } catch (e) { local = false; }
  if (request) local = local && isLocalHost(new URL(request.url).hostname);
  return {
    local,
    fakeTranslate: local && env.FAKE_TRANSLATE === '1',
    fakeTelegram: local && env.FAKE_TELEGRAM === '1',
    fakeTurnstile: local && env.FAKE_TURNSTILE === '1',
  };
}

function corsHeaders(env, request, flags) {
  const origin = request.headers.get('Origin');
  if (!origin) return {};
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  let ok = allowed.includes(origin);
  if (!ok && flags.local) {
    try { ok = isLocalHost(new URL(origin).hostname); } catch (e) { ok = false; }
  }
  if (!ok) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Room-Key, X-Room-Unlock',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

async function verifyTurnstile(env, flags, token) {
  if (flags.fakeTurnstile) return;
  if (!env.TURNSTILE_SECRET_KEY) throw new HttpError(503, 'turnstile_not_configured');
  if (!token || typeof token !== 'string') throw new HttpError(400, 'turnstile_missing');
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET_KEY);
  form.append('response', token);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!data.success) throw new HttpError(403, 'turnstile_failed');
}

// ---------- 노크 ----------

async function postKnock(env, flags, request, ctx) {
  const body = await readJson(request);
  const name = cleanName(body.name);
  const letter = cleanText(body.letter);
  if (!name) throw new HttpError(400, 'name_required');
  if (charCount(name) > LIMITS.nameChars) throw new HttpError(400, 'name_too_long', { max: LIMITS.nameChars });
  if (!letter) throw new HttpError(400, 'letter_required');
  if (charCount(letter) > LIMITS.messageChars) throw new HttpError(400, 'letter_too_long', { max: LIMITS.messageChars });
  await verifyTurnstile(env, flags, body.turnstileToken);
  const recent = await first(env, 'SELECT COUNT(*) AS n FROM knocks WHERE created_at > ?', Date.now() - 86400000);
  if (recent.n >= LIMITS.knocksPerDay) throw new HttpError(429, 'busy');
  const token = randomToken(24);
  await run(env, 'INSERT INTO knocks (token, name, letter, lang, created_at) VALUES (?, ?, ?, ?, ?)',
    token, name, letter, cleanLang(body.lang), Date.now());
  ctx.waitUntil(processPending(env, flags));
  return json({ token });
}

async function postKnockStatus(env, request) {
  const body = await readJson(request);
  const token = typeof body.token === 'string' ? body.token : '';
  const knock = token && await first(env, 'SELECT * FROM knocks WHERE token = ?', token);
  if (!knock) return json({ status: 'gone' });
  if (knock.conversation_id) {
    const conv = await first(env, 'SELECT * FROM conversations WHERE id = ?', knock.conversation_id);
    if (conv && !conv.revoked_at) return json({ status: 'invited', roomKey: conv.room_key });
    if (conv) return json({ status: 'closed' });
  }
  return json({ status: 'waiting' });
}

// ---------- 방문자 대화방 ----------

async function loadRoom(env, request) {
  const key = request.headers.get('X-Room-Key') || '';
  if (!key || key.length > 100) throw new HttpError(404, 'not_found');
  const conv = await first(env, 'SELECT * FROM conversations WHERE room_key = ?', key);
  if (!conv) throw new HttpError(404, 'not_found');
  if (conv.revoked_at) throw new HttpError(410, 'revoked');
  return conv;
}

async function unlockValue(conv) {
  return sha256hex(conv.room_key + ':' + conv.passcode_hash);
}

async function requireRoom(env, request) {
  const conv = await loadRoom(env, request);
  if (conv.passcode_hash) {
    const given = request.headers.get('X-Room-Unlock') || '';
    if (!safeEqual(given, await unlockValue(conv))) throw new HttpError(401, 'passcode_required');
  }
  return conv;
}

async function postUnlock(env, request) {
  const conv = await loadRoom(env, request);
  if (!conv.passcode_hash) return json({ unlock: '' });
  const now = Date.now();
  if (conv.pass_lock_until > now) throw new HttpError(429, 'locked', { until: conv.pass_lock_until });
  const body = await readJson(request);
  const passcode = String(body.passcode ?? '').trim();
  const hash = await sha256hex(conv.passcode_salt + ':' + passcode);
  if (!safeEqual(hash, conv.passcode_hash)) {
    const fails = conv.pass_fails + 1;
    if (fails >= SECURITY.passcodeMaxFails) {
      await run(env, 'UPDATE conversations SET pass_fails = 0, pass_lock_until = ? WHERE id = ?', now + SECURITY.passcodeLockMs, conv.id);
      throw new HttpError(429, 'locked', { until: now + SECURITY.passcodeLockMs });
    }
    await run(env, 'UPDATE conversations SET pass_fails = ? WHERE id = ?', fails, conv.id);
    throw new HttpError(401, 'wrong_passcode', { attemptsLeft: SECURITY.passcodeMaxFails - fails });
  }
  await run(env, 'UPDATE conversations SET pass_fails = 0 WHERE id = ?', conv.id);
  return json({ unlock: await unlockValue(conv) });
}

async function getRoom(env, request, url) {
  const conv = await requireRoom(env, request);
  // 상대 언어를 아직 모르면 브라우저 언어로 먼저 정한다
  if (!conv.lang) {
    const lang = cleanLang(url.searchParams.get('lang'));
    if (lang) await setConversationLang(env, conv, lang);
  }
  return json(await visitorRoomView(env, conv));
}

async function visitorMessage(env, request, id) {
  const conv = await requireRoom(env, request);
  const msg = await first(env, "SELECT * FROM messages WHERE id = ? AND conversation_id = ? AND sender = 'visitor'", id, conv.id);
  if (!msg || msg.deleted_at) throw new HttpError(404, 'message_not_found');
  return { conv, msg };
}

async function postRoomMessage(env, flags, request, ctx) {
  const conv = await requireRoom(env, request);
  const body = await readJson(request);
  const text = checkMessageText(body.text);
  await addVisitorMessage(env, conv, text);
  ctx.waitUntil(processPending(env, flags));
  return json(await visitorRoomView(env, conv));
}

async function patchRoomMessage(env, flags, request, ctx, id) {
  const { conv, msg } = await visitorMessage(env, request, id);
  const body = await readJson(request);
  const text = checkMessageText(body.text);
  if (text !== msg.body) {
    const day = today();
    const count = conv.edit_day === day ? conv.edit_count : 0;
    if (count >= LIMITS.visitorEditsPerDay) throw new HttpError(429, 'edit_limit', { max: LIMITS.visitorEditsPerDay });
    await run(env, 'UPDATE conversations SET edit_day = ?, edit_count = ? WHERE id = ?', day, count + 1, conv.id);
    await editMessage(env, conv, msg, text);
    ctx.waitUntil(processPending(env, flags));
  }
  return json(await visitorRoomView(env, conv));
}

async function deleteRoomMessage(env, flags, request, ctx, id) {
  const { conv, msg } = await visitorMessage(env, request, id);
  await softDeleteMessage(env, msg);
  // 텔레그램에 아직 안 간 메시지라면 삭제 알림도 보내지 않는다
  if (msg.notify !== 'new') {
    await enqueue(env, deletedMessageText({ name: conv.name, conversationId: conv.id }), { conversationId: conv.id });
    ctx.waitUntil(processPending(env, flags));
  }
  return json(await visitorRoomView(env, conv));
}

async function deleteRoom(env, flags, request, ctx) {
  const conv = await requireRoom(env, request);
  await deleteConversation(env, conv);
  await enqueue(env, deletedConversationText({ name: conv.name, conversationId: conv.id }));
  ctx.waitUntil(processPending(env, flags));
  return json({ deleted: true });
}

// ---------- 관리자 ----------

async function requireAdmin(env, request) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) throw new HttpError(401, 'login_required');
  const row = await first(env, 'SELECT * FROM admin_sessions WHERE token_hash = ?', await sha256hex(token));
  if (!row || row.expires_at < Date.now()) throw new HttpError(401, 'login_required');
  return { tokenHash: row.token_hash };
}

async function postLogin(env, flags, request) {
  if (!env.ADMIN_PASSWORD) throw new HttpError(503, 'admin_password_not_set');
  const now = Date.now();
  const lockUntil = Number(await getSetting(env, 'admin_lock_until') || 0);
  if (lockUntil > now) throw new HttpError(429, 'locked', { until: lockUntil });
  const body = await readJson(request);
  await verifyTurnstile(env, flags, body.turnstileToken);
  const given = await sha256hex('pw:' + String(body.password ?? ''));
  const expected = await sha256hex('pw:' + env.ADMIN_PASSWORD);
  if (!safeEqual(given, expected)) {
    const fails = Number(await getSetting(env, 'admin_fails') || 0) + 1;
    if (fails >= SECURITY.adminMaxFails) {
      await setSetting(env, 'admin_fails', 0);
      await setSetting(env, 'admin_lock_until', now + SECURITY.adminLockMs);
      throw new HttpError(429, 'locked', { until: now + SECURITY.adminLockMs });
    }
    await setSetting(env, 'admin_fails', fails);
    throw new HttpError(401, 'wrong_password', { attemptsLeft: SECURITY.adminMaxFails - fails });
  }
  await setSetting(env, 'admin_fails', 0);
  const token = randomToken(32);
  await run(env, 'INSERT INTO admin_sessions (token_hash, expires_at) VALUES (?, ?)', await sha256hex(token), now + SECURITY.adminSessionMs);
  await run(env, 'DELETE FROM admin_sessions WHERE expires_at < ?', now);
  return json({ token });
}

async function postLogout(env, request) {
  const { tokenHash } = await requireAdmin(env, request);
  await run(env, 'DELETE FROM admin_sessions WHERE token_hash = ?', tokenHash);
  return json({ ok: true });
}

async function getOverview(env) {
  const knocks = await all(env,
    `SELECT id, name, letter, letter_tr, lang, tr_status, created_at FROM knocks
     WHERE conversation_id IS NULL AND dismissed_at IS NULL ORDER BY id DESC`);
  const convs = await all(env, 'SELECT * FROM conversations ORDER BY last_activity_at DESC');
  const conversations = [];
  for (const c of convs) conversations.push(await conversationSummary(env, c));
  return json({
    knocks: knocks.map((k) => ({
      id: k.id, name: k.name, letter: k.letter, translation: k.letter_tr, lang: k.lang, trStatus: k.tr_status, at: k.created_at,
    })),
    conversations,
    telegramConnected: !!(await getSetting(env, 'tg_owner_chat')),
    model: env.TRANSLATE_MODEL,
  });
}

async function loadKnock(env, id) {
  const knock = await first(env, 'SELECT * FROM knocks WHERE id = ?', id);
  if (!knock || knock.dismissed_at) throw new HttpError(404, 'knock_not_found');
  return knock;
}

async function postInviteKnock(env, flags, request, ctx, id) {
  const knock = await loadKnock(env, id);
  const body = await readJson(request);
  const reply = cleanText(body.reply);
  if (reply) checkMessageText(reply);
  const { conv } = await inviteKnock(env, knock, reply || null);
  ctx.waitUntil(processPending(env, flags));
  return json(await conversationSummary(env, conv));
}

async function deleteKnock(env, id) {
  const knock = await loadKnock(env, id);
  if (knock.conversation_id) throw new HttpError(409, 'already_invited');
  // 내용은 지우고, 노크한 브라우저에는 계속 "기다리는 중"으로 보이게 표식만 남긴다
  await run(env, "UPDATE knocks SET dismissed_at = ?, letter = '', letter_tr = NULL, name = '', tr_status = 'none' WHERE id = ?", Date.now(), id);
  await run(env, 'DELETE FROM tg_map WHERE knock_id = ?', id);
  return json({ ok: true });
}

async function postConversation(env, request) {
  const body = await readJson(request);
  const name = cleanName(body.name);
  if (!name) throw new HttpError(400, 'name_required');
  if (charCount(name) > LIMITS.nameChars) throw new HttpError(400, 'name_too_long', { max: LIMITS.nameChars });
  const lang = cleanLang(body.lang);
  const passcode = String(body.passcode ?? '').trim();
  let passcodeHash = null;
  let passcodeSalt = null;
  if (passcode) {
    if (passcode.length < LIMITS.passcodeMin || passcode.length > LIMITS.passcodeMax) {
      throw new HttpError(400, 'passcode_length', { min: LIMITS.passcodeMin, max: LIMITS.passcodeMax });
    }
    passcodeSalt = randomToken(12);
    passcodeHash = await sha256hex(passcodeSalt + ':' + passcode);
  }
  const conv = await createConversation(env, { name, lang, passcodeHash, passcodeSalt });
  return json(await conversationSummary(env, conv));
}

async function loadConversation(env, id) {
  const conv = await first(env, 'SELECT * FROM conversations WHERE id = ?', id);
  if (!conv) throw new HttpError(404, 'conversation_not_found');
  return conv;
}

async function getConversation(env, id) {
  const conv = await loadConversation(env, id);
  const now = Date.now();
  await run(env, 'UPDATE conversations SET owner_seen_at = ? WHERE id = ?', now, conv.id);
  conv.owner_seen_at = now;
  return json(await ownerRoomView(env, conv));
}

async function postOwnerMessage(env, flags, request, ctx, id) {
  const conv = await loadConversation(env, id);
  if (conv.revoked_at) throw new HttpError(410, 'revoked');
  const body = await readJson(request);
  const text = checkMessageText(body.text);
  await addOwnerMessage(env, conv, text);
  ctx.waitUntil(processPending(env, flags));
  return json(await ownerRoomView(env, conv));
}

async function ownerMessage(env, id) {
  const msg = await first(env, "SELECT * FROM messages WHERE id = ? AND sender = 'owner'", id);
  if (!msg || msg.deleted_at) throw new HttpError(404, 'message_not_found');
  const conv = await loadConversation(env, msg.conversation_id);
  return { conv, msg };
}

async function patchOwnerMessage(env, flags, request, ctx, id) {
  const { conv, msg } = await ownerMessage(env, id);
  const body = await readJson(request);
  const text = checkMessageText(body.text);
  if (text !== msg.body) {
    await editMessage(env, conv, msg, text);
    ctx.waitUntil(processPending(env, flags));
  }
  return json(await ownerRoomView(env, conv));
}

async function deleteOwnerMessage(env, id) {
  const { conv, msg } = await ownerMessage(env, id);
  await softDeleteMessage(env, msg);
  return json(await ownerRoomView(env, conv));
}

async function postRevoke(env, id) {
  const conv = await loadConversation(env, id);
  if (!conv.revoked_at) await run(env, 'UPDATE conversations SET revoked_at = ? WHERE id = ?', Date.now(), conv.id);
  return json({ ok: true });
}

async function deleteConversationAdmin(env, id) {
  const conv = await loadConversation(env, id);
  await deleteConversation(env, conv);
  return json({ ok: true });
}

// ---------- 텔레그램 연결 ----------

async function getTelegram(env) {
  return json({
    botConfigured: !!env.TELEGRAM_BOT_TOKEN,
    connected: !!(await getSetting(env, 'tg_owner_chat')),
  });
}

async function postTelegramConnect(env, flags, request) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new HttpError(503, 'telegram_token_not_set');
  let bot = 'fake_bot';
  if (!flags.fakeTelegram) {
    const me = await callTelegram(env, 'getMe', {});
    bot = me.username;
    await callTelegram(env, 'setWebhook', {
      url: new URL('/telegram/webhook', request.url).toString(),
      secret_token: await webhookSecret(env.TELEGRAM_BOT_TOKEN),
      allowed_updates: ['message'],
      drop_pending_updates: true,
    });
  }
  const code = randomCode(8);
  await setSetting(env, 'tg_link_code', code);
  await setSetting(env, 'tg_link_expires', Date.now() + SECURITY.telegramCodeMs);
  return json({ bot, code, link: `https://t.me/${bot}?start=${code}`, expiresInMinutes: SECURITY.telegramCodeMs / 60000 });
}

async function postTelegramDisconnect(env, flags) {
  await setSetting(env, 'tg_owner_chat', null);
  await setSetting(env, 'tg_link_code', null);
  if (env.TELEGRAM_BOT_TOKEN && !flags.fakeTelegram) {
    await callTelegram(env, 'deleteWebhook', {}).catch(() => {});
  }
  return json({ ok: true });
}

const TELEGRAM_HELP = [
  '사용법',
  '• 노크와 메시지 알림이 이곳으로 와요.',
  '• 알림에 답장(reply)으로 글을 쓰면 그 대화방에 내 답장으로 들어가요.',
  '• 노크 알림에 답장하면 초대와 함께 첫 답장이 돼요.',
  '• 고치기, 지우기, 링크 폐기는 관리 페이지에서 해요.',
].join('\n');

async function handleTelegramUpdate(env, flags, update) {
  const message = update.message;
  if (!message || !message.chat) return;
  const chatId = String(message.chat.id);
  const text = typeof message.text === 'string' ? message.text : '';
  const owner = await getSetting(env, 'tg_owner_chat');

  const start = /^\/start(?:@\w+)?\s+(\S+)/.exec(text);
  if (start) {
    const code = await getSetting(env, 'tg_link_code');
    const expires = Number(await getSetting(env, 'tg_link_expires') || 0);
    if (code && expires > Date.now() && safeEqual(start[1], code)) {
      await setSetting(env, 'tg_owner_chat', chatId);
      await setSetting(env, 'tg_link_code', null);
      await sendText(env, flags, chatId, '연결되었어요. 이제 이 대화에서 알림을 받고 답장할 수 있어요.\n\n' + TELEGRAM_HELP);
    }
    return;
  }
  // 주인이 아니면 아무 대답도 하지 않는다
  if (!owner || owner !== chatId) return;

  if (/^\/(help|start)\b/.test(text)) {
    await sendText(env, flags, chatId, TELEGRAM_HELP);
    return;
  }
  if (!text) {
    await sendText(env, flags, chatId, '글자 메시지만 보낼 수 있어요.');
    return;
  }
  const replyTo = message.reply_to_message && message.reply_to_message.message_id;
  const target = replyTo && await findReplyTarget(env, replyTo);
  if (!target) {
    await sendText(env, flags, chatId, '어느 대화에 보낼지 모르겠어요. 알림 메시지를 길게 눌러 답장(reply)으로 보내주세요.');
    return;
  }
  const clean = cleanText(text);
  if (charCount(clean) > LIMITS.messageChars) {
    await sendText(env, flags, chatId, `너무 길어요. ${LIMITS.messageChars}자까지 보낼 수 있어요.`);
    return;
  }

  let conv;
  let reply;
  if (target.conversation_id) {
    conv = await first(env, 'SELECT * FROM conversations WHERE id = ?', target.conversation_id);
    if (!conv) { await sendText(env, flags, chatId, '이 대화는 이미 지워졌어요.'); return; }
    if (conv.revoked_at) { await sendText(env, flags, chatId, '이 대화의 링크는 폐기되어서 보낼 수 없어요.'); return; }
    reply = await addOwnerMessage(env, conv, clean, { fromTelegram: true });
  } else {
    const knock = await first(env, 'SELECT * FROM knocks WHERE id = ?', target.knock_id);
    if (!knock || knock.dismissed_at) { await sendText(env, flags, chatId, '이 노크는 이미 정리되었어요.'); return; }
    if (knock.conversation_id) {
      conv = await first(env, 'SELECT * FROM conversations WHERE id = ?', knock.conversation_id);
      if (!conv || conv.revoked_at) { await sendText(env, flags, chatId, '이 노크의 대화방은 닫혔어요.'); return; }
      reply = await addOwnerMessage(env, conv, clean, { fromTelegram: true });
    } else {
      const invited = await inviteKnock(env, knock, clean, { fromTelegram: true });
      conv = invited.conv;
      reply = invited.reply;
      await sendText(env, flags, chatId,
        `🔑 ${conv.name} 님을 초대했어요. 노크한 브라우저에서 대화방이 열려요.\n링크: ${inviteLink(env, conv.room_key)}`);
    }
  }
  // 번역이 필요 없으면 바로 확인을 보낸다. 번역이 필요하면 번역이 끝난 뒤 보낸다.
  if (reply.status !== 'pending') {
    await run(env, 'UPDATE messages SET notify = NULL WHERE id = ?', reply.id);
    const note = reply.status === 'waitlang' ? '\n(상대 언어를 아직 몰라서, 상대가 처음 들어오면 번역돼요.)' : '';
    await sendText(env, flags, chatId, sentConfirmText({ name: conv.name, translated: null }) + note);
  }
}

async function postTelegramWebhook(env, flags, request, ctx) {
  if (!env.TELEGRAM_BOT_TOKEN) return new Response('not configured', { status: 404 });
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!safeEqual(secret, await webhookSecret(env.TELEGRAM_BOT_TOKEN))) return new Response('forbidden', { status: 403 });
  const update = await request.json().catch(() => null);
  if (update) {
    ctx.waitUntil((async () => {
      try {
        await handleTelegramUpdate(env, flags, update);
      } catch (e) {
        console.error('telegram update failed', e.message);
      }
      await processPending(env, flags);
    })());
  }
  // 텔레그램에는 바로 "받았다"고 답한다 (늦으면 텔레그램이 같은 것을 다시 보낸다)
  return new Response('ok');
}

// ---------- 길 안내 ----------

async function route(env, flags, request, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;
  let m;

  if (path === '/' || path === '/api/health') return json({ ok: true, service: 'kbook-chat' });
  if (path === '/telegram/webhook' && method === 'POST') return postTelegramWebhook(env, flags, request, ctx);

  if (path === '/api/knock' && method === 'POST') return postKnock(env, flags, request, ctx);
  if (path === '/api/knock/status' && method === 'POST') return postKnockStatus(env, request);

  if (path === '/api/room' && method === 'GET') return getRoom(env, request, url);
  if (path === '/api/room' && method === 'DELETE') return deleteRoom(env, flags, request, ctx);
  if (path === '/api/room/unlock' && method === 'POST') return postUnlock(env, request);
  if (path === '/api/room/messages' && method === 'POST') return postRoomMessage(env, flags, request, ctx);
  if ((m = /^\/api\/room\/messages\/(\d+)$/.exec(path))) {
    if (method === 'PATCH') return patchRoomMessage(env, flags, request, ctx, Number(m[1]));
    if (method === 'DELETE') return deleteRoomMessage(env, flags, request, ctx, Number(m[1]));
  }

  if (path === '/api/admin/login' && method === 'POST') return postLogin(env, flags, request);
  if (path.startsWith('/api/admin/')) {
    await requireAdmin(env, request);
    if (path === '/api/admin/logout' && method === 'POST') return postLogout(env, request);
    if (path === '/api/admin/overview' && method === 'GET') return getOverview(env);
    if ((m = /^\/api\/admin\/knocks\/(\d+)\/invite$/.exec(path)) && method === 'POST') return postInviteKnock(env, flags, request, ctx, Number(m[1]));
    if ((m = /^\/api\/admin\/knocks\/(\d+)$/.exec(path)) && method === 'DELETE') return deleteKnock(env, Number(m[1]));
    if (path === '/api/admin/conversations' && method === 'POST') return postConversation(env, request);
    if ((m = /^\/api\/admin\/conversations\/(\d+)$/.exec(path))) {
      if (method === 'GET') return getConversation(env, Number(m[1]));
      if (method === 'DELETE') return deleteConversationAdmin(env, Number(m[1]));
    }
    if ((m = /^\/api\/admin\/conversations\/(\d+)\/messages$/.exec(path)) && method === 'POST') return postOwnerMessage(env, flags, request, ctx, Number(m[1]));
    if ((m = /^\/api\/admin\/conversations\/(\d+)\/revoke$/.exec(path)) && method === 'POST') return postRevoke(env, Number(m[1]));
    if ((m = /^\/api\/admin\/messages\/(\d+)$/.exec(path))) {
      if (method === 'PATCH') return patchOwnerMessage(env, flags, request, ctx, Number(m[1]));
      if (method === 'DELETE') return deleteOwnerMessage(env, Number(m[1]));
    }
    if (path === '/api/admin/telegram' && method === 'GET') return getTelegram(env);
    if (path === '/api/admin/telegram/connect' && method === 'POST') return postTelegramConnect(env, flags, request);
    if (path === '/api/admin/telegram/disconnect' && method === 'POST') return postTelegramDisconnect(env, flags);
  }

  // 시험용 주소: 가짜 텔레그램일 때만 열린다
  if (flags.fakeTelegram) {
    if (path === '/api/dev/telegram-log' && method === 'GET') {
      return json(await all(env, 'SELECT id, chat_id, text FROM tg_fake_log ORDER BY id'));
    }
    if (path === '/api/dev/process' && method === 'POST') {
      await processPending(env, flags);
      return json({ ok: true });
    }
  }

  throw new HttpError(404, 'not_found');
}

export default {
  async fetch(request, env, ctx) {
    const flags = getFlags(env, request);
    const cors = corsHeaders(env, request, flags);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let response;
    try {
      await ensureSchema(env);
      response = await route(env, flags, request, ctx);
    } catch (e) {
      if (e instanceof HttpError) {
        response = json({ error: e.code, ...e.extra }, e.status);
      } else {
        console.error('unexpected error', e && e.stack);
        response = json({ error: 'server_error' }, 500);
      }
    }
    for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
    return response;
  },

  async scheduled(event, env, ctx) {
    await ensureSchema(env);
    ctx.waitUntil((async () => {
      await processPending(env, getFlags(env, null));
      await run(env, 'DELETE FROM admin_sessions WHERE expires_at < ?', Date.now());
    })());
  },
};
