// 여러 곳에서 쓰는 작은 도구들

export class HttpError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

export function randomToken(bytes = 24) {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let s = btoa(String.fromCharCode(...buf));
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomCode(length = 8) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(buf, (b) => alphabet[b % alphabet.length]).join('');
}

export async function sha256hex(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

// 길이가 같은 두 문자열을 시간 차이 없이 비교한다
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// 글자 수 (이모지 하나를 한 글자로 센다)
export function charCount(s) {
  return [...s].length;
}

// 줄바꿈과 탭을 뺀 제어 문자를 지운다
export function cleanText(s) {
  return String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
}

export function cleanName(s) {
  return cleanText(s).replace(/\s+/g, ' ');
}

export function cleanLang(s) {
  const v = String(s ?? '').trim();
  return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/.test(v) ? v : '';
}

export function isKorean(lang) {
  return /^ko(-|$)/i.test(lang || '');
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function readJson(request) {
  try {
    const data = await request.json();
    if (data && typeof data === 'object') return data;
  } catch (e) { /* 아래에서 처리 */ }
  throw new HttpError(400, 'bad_json');
}
