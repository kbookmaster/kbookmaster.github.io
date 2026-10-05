// 채팅 화면들이 함께 쓰는 도구. 노크 창, 대화방, 관리 페이지가 모두 이 파일을 쓴다.
(function () {
  var config = window.CHAT_CONFIG || {};

  // 방문자에게 보이는 개인정보 안내 (초안). 고치면 docs/chat-spec.md 7.3도 같이 고친다.
  var PRIVACY_NOTE = 'Your name and messages are stored so this conversation can continue. ' +
    'To bridge our languages, messages are translated by an AI service (Anthropic\'s Claude). ' +
    'I don\'t sell or share your messages with anyone else, and I don\'t track you or keep your IP address. ' +
    'You can delete this whole conversation at any time with the button below.';
  var PRIVACY_NOTE_KNOCK = 'Your name and messages are stored so this conversation can continue. ' +
    'To bridge our languages, messages are translated by an AI service (Anthropic\'s Claude). ' +
    'I don\'t sell or share your messages with anyone else, and I don\'t track you or keep your IP address. ' +
    'Once you\'re invited, you can delete the whole conversation at any time from your conversation page.';

  function isLocal() {
    return location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  }

  // 서버 주소. 시험할 때만 ?api= 로 바꿀 수 있다 (내 컴퓨터에서 열었을 때만).
  function apiBase() {
    if (isLocal()) {
      var override = new URLSearchParams(location.search).get('api');
      if (override) return override.replace(/\/$/, '');
    }
    return String(config.apiBase || '').replace(/\/$/, '');
  }

  function enabled() {
    return !!apiBase();
  }

  function api(method, path, opts) {
    opts = opts || {};
    var headers = Object.assign({}, opts.headers || {});
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(apiBase() + path, {
      method: method,
      headers: headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      cache: 'no-store'
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || ('http_' + res.status));
          err.status = res.status;
          err.code = data.error || '';
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  // 브라우저 저장소. 막혀 있는 브라우저에서도 화면이 깨지지 않게 감싼다.
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 저장 못 해도 계속 */ } },
    remove: function (k) { try { localStorage.removeItem(k); } catch (e) { /* 무시 */ } }
  };

  var KEYS = {
    knockToken: 'kchat.knockToken',
    roomKey: 'kchat.roomKey',
    unlockPrefix: 'kchat.unlock.',
    adminToken: 'kchat.adminToken'
  };

  // Turnstile 사람 확인 상자. 사이트 키가 없고 내 컴퓨터에서 시험 중이면 건너뛴다.
  var turnstileLoading = null;
  function loadTurnstileScript() {
    if (window.turnstile) return Promise.resolve();
    if (!turnstileLoading) {
      turnstileLoading = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        s.async = true;
        s.onload = function () { resolve(); };
        s.onerror = function () { turnstileLoading = null; reject(new Error('turnstile_load_failed')); };
        document.head.appendChild(s);
      });
    }
    return turnstileLoading;
  }

  function mountTurnstile(container) {
    var state = { token: '', widgetId: null, skipped: false };
    if (!config.turnstileSiteKey) {
      state.skipped = true;
      return Promise.resolve({
        getToken: function () { return ''; },
        reset: function () {}
      });
    }
    return loadTurnstileScript().then(function () {
      state.widgetId = window.turnstile.render(container, {
        sitekey: config.turnstileSiteKey,
        callback: function (t) { state.token = t; },
        'expired-callback': function () { state.token = ''; },
        'error-callback': function () { state.token = ''; }
      });
      return {
        getToken: function () { return state.token; },
        reset: function () { state.token = ''; try { window.turnstile.reset(state.widgetId); } catch (e) { /* 무시 */ } }
      };
    });
  }

  function charCount(s) {
    return Array.from(s || '').length;
  }

  function formatTime(ms, locale) {
    try {
      return new Date(ms).toLocaleString(locale || undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return new Date(ms).toISOString();
    }
  }

  // 작은 DOM 만들기 도구: el('p', {class: 'x'}, ['text', child])
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    });
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function browserLang() {
    return (navigator.languages && navigator.languages[0]) || navigator.language || '';
  }

  window.KChat = {
    PRIVACY_NOTE: PRIVACY_NOTE,
    PRIVACY_NOTE_KNOCK: PRIVACY_NOTE_KNOCK,
    KEYS: KEYS,
    apiBase: apiBase,
    enabled: enabled,
    api: api,
    store: store,
    mountTurnstile: mountTurnstile,
    charCount: charCount,
    formatTime: formatTime,
    el: el,
    browserLang: browserLang,
    isLocal: isLocal
  };
})();
