// 대화의 핵심 동작: 메시지 만들기, 초대, 번역 처리, 알림.
import { all, first, run, remainingTurns, VISITOR_SINCE_REPLY_SQL } from './db.js';
import { LIMITS, TRANSLATION } from './config.js';
import { translate } from './translate.js';
import { enqueue, flushOutbox, knockText, messageText, sentConfirmText } from './telegram.js';
import { HttpError, charCount, cleanText, isKorean, randomToken } from './util.js';

export function inviteLink(env, roomKey) {
  return `${env.SITE_URL.replace(/\/$/, '')}/chat/#k=${roomKey}`;
}

export function adminUrl(env) {
  return `${env.SITE_URL.replace(/\/$/, '')}/chat/admin/`;
}

export function checkMessageText(raw) {
  const text = cleanText(raw);
  if (!text) throw new HttpError(400, 'empty_message');
  if (charCount(text) > LIMITS.messageChars) throw new HttpError(400, 'message_too_long', { max: LIMITS.messageChars });
  return text;
}

// 주인 메시지의 번역 상태: 번역이 꺼져 있거나 한국어면 번역하지 않고, 상대 언어를 모르면 기다린다
function ownerTrStatus(flags, conv) {
  if (!flags.translate) return 'none';
  if (!conv.lang) return 'waitlang';
  if (isKorean(conv.lang)) return 'none';
  return 'pending';
}

// 번역이 꺼져 있으면 번역을 기다리지 않고 원문으로 바로 알린다 (텔레그램도 꺼져 있으면 아무 일도 없다)
function notifyUntranslated(env, conv, kind, text) {
  return enqueue(env, messageText({ kind, name: conv.name, conversationId: conv.id, text, off: true }), { conversationId: conv.id });
}

export async function addVisitorMessage(env, flags, conv, text) {
  const now = Date.now();
  // 3턴 규칙을 한 문장 안에서 확인하고 넣는다 (동시에 두 번 보내도 넘치지 않게)
  const meta = await run(env,
    `INSERT INTO messages (conversation_id, sender, body, tr_status, notify, created_at)
     SELECT ?1, 'visitor', ?2, ?5, ?6, ?3
     WHERE (${VISITOR_SINCE_REPLY_SQL}) < ?4`,
    conv.id, text, now, LIMITS.turnsPerReply, flags.translate ? 'pending' : 'none', flags.translate ? 'new' : null);
  if (!meta.changes) throw new HttpError(429, 'turn_limit', { max: LIMITS.turnsPerReply });
  await run(env, 'UPDATE conversations SET last_activity_at = ? WHERE id = ?', now, conv.id);
  if (!flags.translate) await notifyUntranslated(env, conv, 'new', text);
  return meta.last_row_id;
}

export async function addOwnerMessage(env, flags, conv, text, { fromTelegram = false, createdAt = Date.now() } = {}) {
  const status = ownerTrStatus(flags, conv);
  const notify = fromTelegram ? 'tgconfirm' : null;
  const meta = await run(env,
    'INSERT INTO messages (conversation_id, sender, body, tr_status, notify, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    conv.id, 'owner', text, status, notify, createdAt);
  await run(env, 'UPDATE conversations SET last_activity_at = ?, owner_seen_at = ? WHERE id = ?', createdAt, createdAt, conv.id);
  return { id: meta.last_row_id, status };
}

export async function editMessage(env, flags, conv, msg, text) {
  const visitor = msg.sender === 'visitor';
  const status = visitor ? (flags.translate ? 'pending' : 'none') : ownerTrStatus(flags, conv);
  // 아직 텔레그램에 안 간 새 메시지는 그대로 "새 메시지"로, 이미 간 것은 "수정본"으로 알린다
  const notifySql = visitor && flags.translate ? "CASE WHEN notify = 'new' THEN 'new' ELSE 'edit' END" : 'notify';
  await run(env,
    `UPDATE messages SET body = ?, body_tr = NULL, tr_lang = NULL, tr_status = ?, tr_tries = 0, tr_started = NULL,
       version = version + 1, edited_at = ?, notify = ${notifySql}
     WHERE id = ? AND deleted_at IS NULL`,
    text, status, Date.now(), msg.id);
  if (visitor && !flags.translate) await notifyUntranslated(env, conv, 'edit', text);
}

export async function softDeleteMessage(env, msg) {
  await run(env,
    `UPDATE messages SET body = '', body_tr = NULL, tr_status = 'none', version = version + 1, deleted_at = ?, notify = NULL
     WHERE id = ? AND deleted_at IS NULL`,
    Date.now(), msg.id);
}

export async function createConversation(env, { name, lang = '', passcodeHash = null, passcodeSalt = null, knockId = null }) {
  const now = Date.now();
  const roomKey = randomToken(24);
  const meta = await run(env,
    `INSERT INTO conversations (room_key, name, lang, passcode_hash, passcode_salt, knock_id, last_activity_at, owner_seen_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    roomKey, name, lang, passcodeHash, passcodeSalt, knockId, now, now, now);
  return first(env, 'SELECT * FROM conversations WHERE id = ?', meta.last_row_id);
}

// 노크에 초대: 노크 편지가 첫 메시지가 되고, 첫 답장이 있으면 그 뒤에 붙는다
export async function inviteKnock(env, flags, knock, replyText, { fromTelegram = false } = {}) {
  if (knock.conversation_id) {
    const existing = await first(env, 'SELECT * FROM conversations WHERE id = ?', knock.conversation_id);
    if (existing) throw new HttpError(409, 'already_invited', { conversationId: existing.id });
  }
  const conv = await createConversation(env, { name: knock.name, lang: knock.lang, knockId: knock.id });
  const translated = knock.tr_status === 'done';
  await run(env,
    `INSERT INTO messages (conversation_id, sender, body, body_tr, tr_lang, src_lang, tr_status, created_at)
     VALUES (?, 'visitor', ?, ?, ?, ?, ?, ?)`,
    conv.id, knock.letter, translated ? knock.letter_tr : null, translated ? 'ko' : null,
    knock.lang || null, translated ? 'done' : (flags.translate ? 'pending' : 'none'), knock.created_at);
  await run(env, 'UPDATE knocks SET conversation_id = ? WHERE id = ?', conv.id, knock.id);
  let reply = null;
  if (replyText) reply = await addOwnerMessage(env, flags, conv, replyText, { fromTelegram });
  return { conv, reply };
}

// 상대 언어가 정해지면, 언어를 몰라서 기다리던 내 메시지들을 번역 줄에 세운다
export async function setConversationLang(env, flags, conv, lang) {
  if (!lang || lang === conv.lang) return;
  await run(env, 'UPDATE conversations SET lang = ? WHERE id = ?', lang, conv.id);
  const next = isKorean(lang) || !flags.translate ? 'none' : 'pending';
  await run(env,
    `UPDATE messages SET tr_status = ?, tr_tries = 0 WHERE conversation_id = ? AND sender = 'owner' AND tr_status = 'waitlang' AND deleted_at IS NULL`,
    next, conv.id);
  conv.lang = lang;
}

async function recentContext(env, conv, beforeId) {
  const rows = await all(env,
    `SELECT sender, body FROM messages WHERE conversation_id = ? AND id < ? AND deleted_at IS NULL ORDER BY id DESC LIMIT ?`,
    conv.id, beforeId, TRANSLATION.contextMessages);
  return rows.reverse().map((m) => ({ label: m.sender === 'owner' ? 'K' : `Visitor (${conv.name})`, text: m.body }));
}

async function processKnock(env, flags, knockId) {
  const now = Date.now();
  const claim = await run(env,
    `UPDATE knocks SET tr_status = 'working', tr_started = ?, tr_tries = tr_tries + 1
     WHERE id = ? AND (tr_status = 'pending' OR (tr_status = 'working' AND tr_started < ?))`,
    now, knockId, now - TRANSLATION.staleMs);
  if (!claim.changes) return;
  const knock = await first(env, 'SELECT * FROM knocks WHERE id = ?', knockId);
  if (!knock) return;
  let result = null;
  try {
    result = await translate(env, flags, {
      text: knock.letter,
      targetCode: 'ko',
      context: [],
      speakerLabel: `a visitor named ${knock.name} (this is their first letter, knocking on K's door)`,
    });
  } catch (e) {
    console.error('knock translation failed', e.message);
  }
  if (result) {
    await run(env, `UPDATE knocks SET letter_tr = ?, lang = COALESCE(NULLIF(?, ''), lang), tr_status = 'done' WHERE id = ?`,
      result.translation, result.lang, knock.id);
  } else if (knock.tr_tries >= TRANSLATION.maxTries) {
    await run(env, "UPDATE knocks SET tr_status = 'failed' WHERE id = ?", knock.id);
  } else {
    await run(env, "UPDATE knocks SET tr_status = 'pending' WHERE id = ?", knock.id);
    return;
  }
  if (knock.notify_pending) {
    await enqueue(env, knockText({
      name: knock.name,
      letter: knock.letter,
      letterTr: result ? result.translation : null,
      lang: result ? result.lang : knock.lang,
      adminUrl: adminUrl(env),
    }), { knockId: knock.id });
    await run(env, 'UPDATE knocks SET notify_pending = 0 WHERE id = ?', knock.id);
  }
}

async function processMessage(env, flags, messageId) {
  const now = Date.now();
  const claim = await run(env,
    `UPDATE messages SET tr_status = 'working', tr_started = ?, tr_tries = tr_tries + 1
     WHERE id = ? AND deleted_at IS NULL AND (tr_status = 'pending' OR (tr_status = 'working' AND tr_started < ?))`,
    now, messageId, now - TRANSLATION.staleMs);
  if (!claim.changes) return;
  const msg = await first(env, 'SELECT * FROM messages WHERE id = ?', messageId);
  const conv = msg && await first(env, 'SELECT * FROM conversations WHERE id = ?', msg.conversation_id);
  if (!msg || !conv) return;

  const fromVisitor = msg.sender === 'visitor';
  const targetCode = fromVisitor ? 'ko' : conv.lang;
  if (!fromVisitor && (!targetCode || isKorean(targetCode))) {
    await run(env, 'UPDATE messages SET tr_status = ? WHERE id = ? AND version = ?', targetCode ? 'none' : 'waitlang', msg.id, msg.version);
    return;
  }

  let result = null;
  try {
    result = await translate(env, flags, {
      text: msg.body,
      targetCode,
      context: await recentContext(env, conv, msg.id),
      speakerLabel: fromVisitor ? `the visitor, ${conv.name}` : 'K',
    });
  } catch (e) {
    console.error('message translation failed', e.message);
  }

  let failed = false;
  if (result) {
    const saved = await run(env,
      `UPDATE messages SET body_tr = ?, tr_lang = ?, src_lang = ?, tr_status = 'done'
       WHERE id = ? AND version = ? AND deleted_at IS NULL`,
      result.translation, targetCode, result.lang || null, msg.id, msg.version);
    if (!saved.changes) return; // 그사이 고쳐지거나 지워졌다. 새 번역이 다시 돈다.
    if (fromVisitor && result.lang) await setConversationLang(env, flags, conv, result.lang);
  } else if (msg.tr_tries >= TRANSLATION.maxTries) {
    const saved = await run(env, "UPDATE messages SET tr_status = 'failed' WHERE id = ? AND version = ?", msg.id, msg.version);
    if (!saved.changes) return;
    failed = true;
  } else {
    await run(env, "UPDATE messages SET tr_status = 'pending' WHERE id = ? AND version = ?", msg.id, msg.version);
    return;
  }

  if (!msg.notify) return;
  const took = await run(env, 'UPDATE messages SET notify = NULL WHERE id = ? AND version = ?', msg.id, msg.version);
  if (!took.changes) return;
  if (msg.notify === 'tgconfirm') {
    await enqueue(env, sentConfirmText({ name: conv.name, translated: result && result.translation, failed }));
  } else {
    await enqueue(env, messageText({
      kind: msg.notify,
      name: conv.name,
      conversationId: conv.id,
      text: msg.body,
      translated: result ? result.translation : null,
      lang: result ? result.lang : '',
    }), { conversationId: conv.id });
  }
}

// 밀린 번역과 알림을 처리한다. 메시지를 저장한 직후와 2분마다 불린다.
export async function processPending(env, flags) {
  // 번역도 텔레그램도 꺼져 있으면 할 일이 없다
  if (!flags.translate && !flags.telegram) return;
  if (!flags.translate) {
    // 번역 키를 뺀 뒤 남은 번역 대기는 원문 그대로 둔다
    await run(env, "UPDATE knocks SET tr_status = 'none' WHERE tr_status IN ('pending', 'working')");
    await run(env, "UPDATE messages SET tr_status = 'none', notify = NULL WHERE tr_status IN ('pending', 'working', 'waitlang')");
  }
  try {
    const stale = Date.now() - TRANSLATION.staleMs;
    const knocks = await all(env,
      `SELECT id FROM knocks WHERE tr_status = 'pending' OR (tr_status = 'working' AND tr_started < ?) ORDER BY id LIMIT 4`, stale);
    for (const k of knocks) await processKnock(env, flags, k.id);
    const msgs = await all(env,
      `SELECT id FROM messages WHERE deleted_at IS NULL AND (tr_status = 'pending' OR (tr_status = 'working' AND tr_started < ?)) ORDER BY id LIMIT 8`, stale);
    for (const m of msgs) await processMessage(env, flags, m.id);
  } catch (e) {
    console.error('processPending failed', e.message);
  }
  try {
    await flushOutbox(env, flags);
  } catch (e) {
    console.error('flushOutbox failed', e.message);
  }
}

// 번역이 꺼져 있을 때 새 노크를 원문으로 바로 알린다
export async function notifyKnockNow(env, flags, knockId, ctx) {
  if (!flags.telegram) return;
  const knock = await first(env, 'SELECT * FROM knocks WHERE id = ?', knockId);
  await enqueue(env, knockText({ name: knock.name, letter: knock.letter, lang: knock.lang, off: true, adminUrl: adminUrl(env) }), { knockId });
  ctx.waitUntil(processPending(env, flags));
}

// 방문자에게 보여줄 대화방 모습
export async function visitorRoomView(env, conv) {
  const rows = await all(env, 'SELECT * FROM messages WHERE conversation_id = ? ORDER BY id', conv.id);
  return {
    name: conv.name,
    remaining: await remainingTurns(env, conv.id, LIMITS.turnsPerReply),
    maxTurns: LIMITS.turnsPerReply,
    maxChars: LIMITS.messageChars,
    messages: rows.map((m) => {
      const base = { id: m.id, from: m.sender === 'owner' ? 'k' : 'you', at: m.created_at, edited: !!m.edited_at };
      if (m.deleted_at) return { ...base, deleted: true };
      if (m.sender === 'visitor') return { ...base, text: m.body };
      // 내 메시지: 번역이 있으면 번역을, 없으면 상태를 알려준다
      if (m.tr_status === 'none') return { ...base, text: m.body };
      if (m.tr_status === 'done') return { ...base, text: m.body_tr, original: m.body };
      if (m.tr_status === 'failed') return { ...base, text: m.body, untranslated: true };
      return { ...base, text: null, translating: true, original: m.body };
    }),
  };
}

// 주인에게 보여줄 대화방 모습
export async function ownerRoomView(env, conv) {
  const rows = await all(env, 'SELECT * FROM messages WHERE conversation_id = ? ORDER BY id', conv.id);
  return {
    conversation: await conversationSummary(env, conv),
    messages: rows.map((m) => ({
      id: m.id,
      from: m.sender,
      at: m.created_at,
      edited: !!m.edited_at,
      deleted: !!m.deleted_at,
      body: m.deleted_at ? null : m.body,
      translation: m.deleted_at ? null : m.body_tr,
      srcLang: m.src_lang,
      trLang: m.tr_lang,
      trStatus: m.tr_status,
    })),
  };
}

export async function conversationSummary(env, conv) {
  const unread = await first(env,
    `SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND sender = 'visitor' AND deleted_at IS NULL AND created_at > ?`,
    conv.id, conv.owner_seen_at);
  const last = await first(env,
    `SELECT sender, body, body_tr FROM messages WHERE conversation_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`, conv.id);
  let snippet = '';
  if (last) snippet = (last.sender === 'visitor' ? (last.body_tr || last.body) : last.body).slice(0, 80);
  return {
    id: conv.id,
    name: conv.name,
    lang: conv.lang,
    link: inviteLink(env, conv.room_key),
    hasPasscode: !!conv.passcode_hash,
    fromKnock: !!conv.knock_id,
    revoked: !!conv.revoked_at,
    createdAt: conv.created_at,
    lastActivityAt: conv.last_activity_at,
    unread: unread ? unread.n : 0,
    remaining: await remainingTurns(env, conv.id, LIMITS.turnsPerReply),
    lastFrom: last ? last.sender : null,
    snippet,
  };
}
