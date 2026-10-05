// 대화 장부(D1)의 표 모양과 공용 쿼리.
// 표는 서버가 처음 켜질 때 스스로 만든다. 손으로 SQL을 넣을 필요가 없다.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS knocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    letter TEXT NOT NULL,
    letter_tr TEXT,
    lang TEXT NOT NULL DEFAULT '',
    tr_status TEXT NOT NULL DEFAULT 'pending',
    tr_tries INTEGER NOT NULL DEFAULT 0,
    tr_started INTEGER,
    notify_pending INTEGER NOT NULL DEFAULT 1,
    conversation_id INTEGER,
    dismissed_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    lang TEXT NOT NULL DEFAULT '',
    passcode_hash TEXT,
    passcode_salt TEXT,
    pass_fails INTEGER NOT NULL DEFAULT 0,
    pass_lock_until INTEGER NOT NULL DEFAULT 0,
    knock_id INTEGER,
    edit_day TEXT,
    edit_count INTEGER NOT NULL DEFAULT 0,
    owner_seen_at INTEGER NOT NULL DEFAULT 0,
    last_activity_at INTEGER NOT NULL,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    sender TEXT NOT NULL,
    body TEXT NOT NULL,
    body_tr TEXT,
    tr_lang TEXT,
    src_lang TEXT,
    tr_status TEXT NOT NULL DEFAULT 'pending',
    tr_tries INTEGER NOT NULL DEFAULT 0,
    tr_started INTEGER,
    version INTEGER NOT NULL DEFAULT 1,
    notify TEXT,
    created_at INTEGER NOT NULL,
    edited_at INTEGER,
    deleted_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages (conversation_id, id)`,
  `CREATE INDEX IF NOT EXISTS messages_by_status ON messages (tr_status)`,
  `CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    conversation_id INTEGER,
    knock_id INTEGER,
    tries INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tg_map (
    tg_message_id INTEGER PRIMARY KEY,
    conversation_id INTEGER,
    knock_id INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tg_fake_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  )`,
];

let schemaReady = null;

export function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql))).catch((e) => {
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

export function first(env, sql, ...args) {
  return env.DB.prepare(sql).bind(...args).first();
}

export async function all(env, sql, ...args) {
  const r = await env.DB.prepare(sql).bind(...args).all();
  return r.results || [];
}

export async function run(env, sql, ...args) {
  const r = await env.DB.prepare(sql).bind(...args).run();
  return r.meta || {};
}

export async function getSetting(env, key) {
  const row = await first(env, 'SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : null;
}

export function setSetting(env, key, value) {
  if (value === null || value === undefined) return run(env, 'DELETE FROM settings WHERE key = ?', key);
  return run(env, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
}

// 내 마지막 답장 이후 방문자가 보낸 메시지 수 (지운 것도 센다)
export const VISITOR_SINCE_REPLY_SQL = `SELECT COUNT(*) FROM messages
  WHERE conversation_id = ?1 AND sender = 'visitor'
    AND id > COALESCE((SELECT MAX(id) FROM messages WHERE conversation_id = ?1 AND sender = 'owner'), 0)`;

export async function remainingTurns(env, conversationId, perReply) {
  const row = await first(env, `SELECT (${VISITOR_SINCE_REPLY_SQL}) AS n`, conversationId);
  return Math.max(0, perReply - (row ? row.n : 0));
}

// 대화방 하나를 장부에서 완전히 지운다
export async function deleteConversation(env, conv) {
  const stmts = [
    env.DB.prepare('DELETE FROM messages WHERE conversation_id = ?').bind(conv.id),
    env.DB.prepare('DELETE FROM tg_map WHERE conversation_id = ?').bind(conv.id),
    env.DB.prepare('DELETE FROM outbox WHERE conversation_id = ?').bind(conv.id),
    env.DB.prepare('DELETE FROM conversations WHERE id = ?').bind(conv.id),
  ];
  if (conv.knock_id) {
    stmts.push(env.DB.prepare('DELETE FROM tg_map WHERE knock_id = ?').bind(conv.knock_id));
    stmts.push(env.DB.prepare('DELETE FROM outbox WHERE knock_id = ?').bind(conv.knock_id));
    stmts.push(env.DB.prepare('DELETE FROM knocks WHERE id = ?').bind(conv.knock_id));
  }
  await env.DB.batch(stmts);
}
