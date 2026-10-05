// 텔레그램으로 보내기. 알림은 먼저 outbox 표에 쌓고, 보내기에 성공하면 지운다.
// 실패하면 정리 작업(cron)이 다시 보낸다.
import { all, first, run, getSetting } from './db.js';
import { TELEGRAM } from './config.js';
import { escapeHtml, sha256hex } from './util.js';

const MAX_TEXT = 4000;

export function webhookSecret(token) {
  return sha256hex('kbook-chat-webhook:' + token).then((h) => h.slice(0, 48));
}

export async function callTelegram(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`telegram ${method} failed: ${data.description || res.status}`);
  return data.result;
}

// 텔레그램 메시지 하나를 보낸다. 성공하면 텔레그램 메시지 번호를 돌려준다.
export async function sendText(env, flags, chatId, text) {
  const body = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '…' : text;
  if (flags.fakeTelegram) {
    const meta = await run(env, 'INSERT INTO tg_fake_log (chat_id, text, created_at) VALUES (?, ?, ?)', String(chatId), body, Date.now());
    return 100000 + meta.last_row_id;
  }
  const result = await callTelegram(env, 'sendMessage', {
    chat_id: chatId,
    text: body,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });
  return result.message_id;
}

// 주인에게 보낼 알림을 줄 세운다. 답장 연결용으로 대화방이나 노크 번호를 함께 적는다.
export function enqueue(env, text, { conversationId = null, knockId = null } = {}) {
  const now = Date.now();
  return run(env, 'INSERT INTO outbox (text, conversation_id, knock_id, next_at, created_at) VALUES (?, ?, ?, ?, ?)',
    text, conversationId, knockId, now, now);
}

export async function flushOutbox(env, flags) {
  const chatId = await getSetting(env, 'tg_owner_chat');
  const now = Date.now();
  const rows = await all(env, 'SELECT * FROM outbox WHERE next_at <= ? ORDER BY id LIMIT 20', now);
  for (const row of rows) {
    // 연결된 텔레그램이 없으면 쌓아두지 않고 버린다 (나중에 한꺼번에 쏟아지지 않도록)
    if (!chatId || !env.TELEGRAM_BOT_TOKEN) {
      await run(env, 'DELETE FROM outbox WHERE id = ?', row.id);
      continue;
    }
    // 다른 작업이 같은 알림을 동시에 보내지 않도록 먼저 찜한다
    const claim = await run(env, 'UPDATE outbox SET next_at = ? WHERE id = ? AND next_at <= ?', now + 60000, row.id, now);
    if (!claim.changes) continue;
    try {
      const messageId = await sendText(env, flags, chatId, row.text);
      if (row.conversation_id || row.knock_id) {
        await run(env, 'INSERT OR REPLACE INTO tg_map (tg_message_id, conversation_id, knock_id, created_at) VALUES (?, ?, ?, ?)',
          messageId, row.conversation_id, row.knock_id, Date.now());
      }
      await run(env, 'DELETE FROM outbox WHERE id = ?', row.id);
    } catch (e) {
      console.error('telegram send failed', e.message);
      const tries = row.tries + 1;
      if (tries >= TELEGRAM.maxTries) await run(env, 'DELETE FROM outbox WHERE id = ?', row.id);
      else await run(env, 'UPDATE outbox SET tries = ?, next_at = ? WHERE id = ?', tries, Date.now() + 60000 * 2 ** tries, row.id);
    }
  }
}

export async function findReplyTarget(env, tgMessageId) {
  return first(env, 'SELECT * FROM tg_map WHERE tg_message_id = ?', tgMessageId);
}

// 아래는 알림 문구. 주인이 읽으므로 한국어.

function quote(text) {
  return `<blockquote>${escapeHtml(text)}</blockquote>`;
}

function original(text, lang) {
  return `<i>원문${lang ? ` (${escapeHtml(lang)})` : ''}</i>\n<blockquote expandable>${escapeHtml(text)}</blockquote>`;
}

function body(translated, text, lang) {
  // 번역이 원문과 같으면 (한국어로 쓴 경우) 한 번만 보여준다
  if (!translated) return `<i>번역 실패, 원문만 보냅니다</i>\n${quote(text)}`;
  if (translated === text) return quote(text);
  return `${quote(translated)}\n${original(text, lang)}`;
}

export function knockText({ name, letter, letterTr, lang, adminUrl }) {
  return `🚪 <b>새 노크</b>: ${escapeHtml(name)}\n\n${body(letterTr, letter, lang)}\n\n↩️ 이 알림에 답장(reply)하면 초대와 함께 첫 답장으로 보내져요.\n관리 페이지: ${escapeHtml(adminUrl)}`;
}

export function messageText({ kind, name, conversationId, text, translated, lang }) {
  const head = kind === 'edit' ? '✏️ <b>수정된 메시지</b>' : '💬 <b>새 메시지</b>';
  return `${head}: ${escapeHtml(name)} <i>#${conversationId}</i>\n\n${body(translated, text, lang)}\n\n↩️ 답장(reply)하면 바로 보내져요.`;
}

export function deletedMessageText({ name, conversationId }) {
  return `🗑 ${escapeHtml(name)} <i>#${conversationId}</i> 님이 메시지 하나를 지웠어요.`;
}

export function deletedConversationText({ name, conversationId }) {
  return `🗑 ${escapeHtml(name)} <i>#${conversationId}</i> 님이 대화 전체를 지웠어요. 장부에서도 모두 지워졌습니다.`;
}

export function sentConfirmText({ name, translated, failed }) {
  if (failed) return `⚠️ ${escapeHtml(name)} 님에게 보냈지만 번역이 실패해서 원문 그대로 보입니다.`;
  if (!translated) return `✅ ${escapeHtml(name)} 님에게 보냈어요.`;
  return `✅ ${escapeHtml(name)} 님에게 보냈어요. 상대가 읽는 번역:\n${quote(translated)}`;
}
