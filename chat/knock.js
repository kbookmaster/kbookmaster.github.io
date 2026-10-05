// 대문의 노크 창. 대문(index.html)의 Message 버튼이 KChatKnock.open()을 부른다.
(function () {
  var K = window.KChat;
  var el = K.el;
  var MAX_CHARS = 1000;
  var MAX_NAME = 40;
  var overlay = null;
  var lastFocus = null;

  function roomUrl(key) {
    var url = '/chat/#k=' + encodeURIComponent(key);
    var api = K.isLocal() && new URLSearchParams(location.search).get('api');
    return api ? '/chat/?api=' + encodeURIComponent(api) + '#k=' + encodeURIComponent(key) : url;
  }

  function close() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    document.removeEventListener('keydown', onKey);
    if (lastFocus) lastFocus.focus();
  }

  function onKey(e) {
    if (e.key === 'Escape') close();
  }

  function show(content) {
    if (!overlay) {
      lastFocus = document.activeElement;
      overlay = el('div', { class: 'kc-overlay', onclick: function (e) { if (e.target === overlay) close(); } });
      document.body.appendChild(overlay);
      document.addEventListener('keydown', onKey);
    }
    overlay.innerHTML = '';
    var modal = el('div', { class: 'kc-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'kc-title' }, [content]);
    overlay.appendChild(modal);
    var focusable = modal.querySelector('input, textarea, button.kc-btn');
    if (focusable) focusable.focus();
  }

  function head(title) {
    return el('div', { class: 'kc-modal-head' }, [
      el('h2', { id: 'kc-title', text: title }),
      el('button', { type: 'button', class: 'kc-close', 'aria-label': 'Close', onclick: close, text: '×' })
    ]);
  }

  function privacy() {
    return el('p', { class: 'kc-privacy' }, [el('strong', { text: 'Privacy, briefly. ' }), K.PRIVACY_NOTE_KNOCK]);
  }

  function showForm() {
    var name = el('input', { class: 'kc-input', id: 'kc-name', type: 'text', maxlength: String(MAX_NAME), autocomplete: 'name' });
    var letter = el('textarea', { class: 'kc-input', id: 'kc-letter', rows: '6' });
    var counter = el('div', { class: 'kc-counter', 'aria-live': 'polite', text: '0 / ' + MAX_CHARS });
    var turnstileBox = el('div', { class: 'kc-turnstile' });
    var error = el('p', { class: 'kc-error', role: 'alert' });
    var send = el('button', { type: 'submit', class: 'kc-btn', text: 'Knock' });
    var turnstile = null;

    letter.addEventListener('input', function () {
      var n = K.charCount(letter.value);
      counter.textContent = n + ' / ' + MAX_CHARS;
      counter.classList.toggle('over', n > MAX_CHARS);
    });

    var form = el('form', { novalidate: true }, [
      head('Knock on my door'),
      el('p', { class: 'kc-note', text: 'Leave your name and a short first letter. Write in any language; I\'ll read it in Korean and reply in yours. If I write back, a small conversation room opens for you.' }),
      el('label', { class: 'kc-label', for: 'kc-name', text: 'Your name' }),
      name,
      el('label', { class: 'kc-label', for: 'kc-letter', text: 'Your letter' }),
      letter,
      counter,
      turnstileBox,
      error,
      el('div', { class: 'kc-actions' }, [send, el('button', { type: 'button', class: 'kc-btn quiet', text: 'Cancel', onclick: close })]),
      el('p', { class: 'kc-note', style: 'margin-top:12px', text: 'You can knock once from this browser, so take your time.' }),
      privacy()
    ]);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      error.textContent = '';
      var n = name.value.trim();
      var l = letter.value.trim();
      if (!n) { error.textContent = 'Please tell me your name.'; name.focus(); return; }
      if (!l) { error.textContent = 'Please write a few words.'; letter.focus(); return; }
      if (K.charCount(l) > MAX_CHARS) { error.textContent = 'Your letter is a little long. Please keep it under ' + MAX_CHARS + ' characters.'; return; }
      var token = turnstile ? turnstile.getToken() : '';
      send.disabled = true;
      send.textContent = 'Sending…';
      K.api('POST', '/api/knock', { body: { name: n, letter: l, lang: K.browserLang(), turnstileToken: token } })
        .then(function (data) {
          K.store.set(K.KEYS.knockToken, data.token);
          showSent();
        })
        .catch(function (err) {
          send.disabled = false;
          send.textContent = 'Knock';
          if (turnstile) turnstile.reset();
          if (err.code === 'turnstile_missing' || err.code === 'turnstile_failed') error.textContent = 'Please complete the quick check above, then try again.';
          else if (err.code === 'busy') error.textContent = 'My door is very busy today. Please try again tomorrow.';
          else error.textContent = 'Something went wrong. Please try again in a moment.';
        });
    });

    show(form);
    K.mountTurnstile(turnstileBox).then(function (t) { turnstile = t; }).catch(function () {
      error.textContent = 'The quick human check could not load. Please refresh the page and try again.';
    });
  }

  function showSent() {
    show(el('div', {}, [
      head('Your knock is on its way'),
      el('p', { text: 'Thank you. I\'ll read your letter soon.' }),
      el('p', { text: 'If I write back, a small conversation room opens for you. Come back to this page in this same browser and press Message again to see if you\'ve been invited.' }),
      el('div', { class: 'kc-actions' }, [el('button', { type: 'button', class: 'kc-btn', text: 'Close', onclick: close })])
    ]));
  }

  function showWaiting() {
    show(el('div', {}, [
      head('Still waiting'),
      el('p', { text: 'Your knock has arrived. I haven\'t written back yet. Replies aren\'t instant, so please check again another day.' }),
      el('div', { class: 'kc-actions' }, [el('button', { type: 'button', class: 'kc-btn', text: 'Close', onclick: close })])
    ]));
  }

  function showInvited(key) {
    show(el('div', {}, [
      head('You\'re invited'),
      el('p', { text: 'I wrote back. Your conversation room is open.' }),
      el('div', { class: 'kc-actions' }, [
        el('a', { class: 'kc-btn', href: roomUrl(key), text: 'Open our conversation' }),
        el('button', { type: 'button', class: 'kc-btn quiet', text: 'Later', onclick: close })
      ])
    ]));
  }

  function showClosed() {
    show(el('div', {}, [
      head('This conversation is closed'),
      el('p', { text: 'This conversation is no longer open. Thank you for knocking.' }),
      el('div', { class: 'kc-actions' }, [el('button', { type: 'button', class: 'kc-btn', text: 'Close', onclick: close })])
    ]));
  }

  function showChecking(token) {
    show(el('div', {}, [head('Checking your knock'), el('p', { class: 'kc-note', text: 'One moment…' })]));
    K.api('POST', '/api/knock/status', { body: { token: token } })
      .then(function (data) {
        if (data.status === 'invited') {
          K.store.set(K.KEYS.roomKey, data.roomKey);
          showInvited(data.roomKey);
        } else if (data.status === 'waiting') {
          showWaiting();
        } else if (data.status === 'closed') {
          showClosed();
        } else {
          // 기록이 지워졌다 (대화를 지웠거나 정리됨). 다시 노크할 수 있게 한다.
          K.store.remove(K.KEYS.knockToken);
          showForm();
        }
      })
      .catch(function () {
        show(el('div', {}, [
          head('Hmm'),
          el('p', { text: 'I couldn\'t check right now. Please try again in a moment.' }),
          el('div', { class: 'kc-actions' }, [el('button', { type: 'button', class: 'kc-btn', text: 'Close', onclick: close })])
        ]));
      });
  }

  function open() {
    var roomKey = K.store.get(K.KEYS.roomKey);
    if (roomKey) { location.href = roomUrl(roomKey); return; }
    var token = K.store.get(K.KEYS.knockToken);
    if (token) showChecking(token);
    else showForm();
  }

  window.KChatKnock = { open: open, enabled: K.enabled };
})();
