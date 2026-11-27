'use strict';
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const S = { user: null, csrf: '', admin: false, list: { products: [], page: 1, pages: 1, total: 0 }, mine: [], page: 1, minP: '', maxP: '', stock: false, adminTab: 'disputes', adminDisp: 'open', adminRep: 'open', adminQ: '', cat: 'all', q: '', seller: null, sort: 'name', cart: { items: [], total: 0 }, view: 'shop', sellTab: 'listings', edit: null, auth: 'login', lastUser: '', cfg: {}, photo: null, photos: [], avatar: null, ship: null, news: null, newsGuestDone: false, gReady: false, hasPw: true, notes: { threads: [], buyer_unread: 0, seller_unread: 0, to_ship: 0 } };
const CATS = ['Electronics', 'Clothing', 'Food', 'Books', 'Furniture', 'Other'];
const VIEWS = ['shop', 'orders', 'sell'], SELL_TABS = ['listings', 'orders', 'payouts', 'profile'];
const SITE_TITLE = /^\/product\/\d+/.test(location.pathname) ? 'BlueMart | Shop & Sell Online' : document.title;
let baseTitle = document.title;
const setBaseTitle = t => { baseTitle = t; renderBadges(); };
/* Currency symbol comes from /api/session (config.currency_symbol); "$" until it has loaded. Prices arrive as strings, so always Number(). */
let SYM = '$';
const money = n => SYM + (SYM.length > 1 ? ' ' : '') + (Number(n) || 0).toFixed(2);
const toNum = v => Number(v) || 0;
const real = v => (v && v !== 'Not selected' && v !== 'Not shipped') ? v : null;
const img = (u, w) => u ? u.replace('/upload/', `/upload/f_auto,q_auto,w_${w}/`) : '';
const debounce = (f, ms = 200) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => f(...a), ms); }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
/* The server stores UTC timestamps without a timezone suffix; add one so the browser shows the person's local time. */
const when = s => new Date(/(Z|[+-]\d\d:?\d\d)$/i.test(s) ? s : s + 'Z');
const stamp = s => when(s).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') e.className = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else if (k === 'data') Object.assign(e.dataset, v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  e.append(...kids.flat().filter(x => x != null && x !== false));
  return e;
}

async function api(url, { method = 'GET', body } = {}) {
  const o = { method, headers: {} };
  if (method !== 'GET' && S.csrf) o.headers['X-CSRF-Token'] = S.csrf;
  if (body instanceof FormData) o.body = body;
  else if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
  try {
    const r = await fetch(url, o);
    let d = {};
    try { d = await r.json(); } catch { /* empty body */ }
    if (!r.ok) {
      if (Array.isArray(d)) d = {};
      d.success = false; d.status = r.status;
      d.message = d.message || (r.status === 413 ? 'That file is too large. Please choose a smaller photo.' : `Request failed (${r.status}).`);
      /* A 401 while we think we are signed in means the session cookie expired. */
      if (r.status === 401 && S.user) sessionExpired();
    }
    return d;
  } catch { return { success: false, message: 'Network error. Check your connection and try again.' }; }
}

/* Toasts live in a popover (the browser's top layer), so they appear ABOVE any open dialog.
   Re-showing the popover on every toast also keeps it above a dialog that was opened later. */
function toast(msg, type = '') {
  const box = $('#toasts');
  const t = h('div', { class: 'toast ' + type }, msg);
  box.append(t);
  if (box.showPopover) {
    try { if (box.matches(':popover-open')) box.hidePopover(); box.showPopover(); } catch { /* fall back to the fixed-position box */ }
  }
  setTimeout(() => {
    t.remove();
    if (!box.children.length && box.hidePopover) { try { box.hidePopover(); } catch { /* already hidden */ } }
  }, 4500);
}

function empty(title, msg, action) {
  return h('div', { class: 'empty' }, h('h3', {}, title), h('p', {}, msg),
    action ? h('button', { class: 'btn', on: { click: action[1] } }, action[0]) : null);
}
const gate = (msg) => empty(msg, 'Create a free account or sign in to continue.', ['Sign in', () => openAuth('login')]);

function ask(title, msg, ok = 'Confirm', danger = false) {
  return new Promise(res => {
    const d = $('#dlg-ask');
    $('#ask-t').textContent = title; $('#ask-m').textContent = msg;
    const b = $('#ask-ok'); b.textContent = ok; b.className = 'btn' + (danger ? ' danger' : '');
    d.returnValue = ''; d.onclose = () => res(d.returnValue === 'ok'); d.showModal();
  });
}

/* Like ask(), but also collects a short reason. Resolves to the text, or null when cancelled. */
function askReason(title, msg, ok = 'Confirm') {
  return new Promise(res => {
    const d = $('#dlg-ask'), inp = $('#ask-in');
    $('#ask-t').textContent = title; $('#ask-m').textContent = msg;
    const b = $('#ask-ok'); b.textContent = ok; b.className = 'btn danger';
    inp.hidden = false; inp.value = ''; d.returnValue = '';
    d.onclose = () => { inp.hidden = true; res(d.returnValue === 'ok' ? inp.value.trim() : null); };
    inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); b.click(); } };
    d.showModal(); inp.focus();
  });
}

function avatarEl(url, name, size = 56) {
  const st = `width:${size}px;height:${size}px;font-size:${Math.round(size * .42)}px`;
  return url
    ? h('img', { class: 'avatar', src: img(url, size * 2), alt: '', style: st, width: size, height: size, referrerpolicy: 'no-referrer' })
    : h('span', { class: 'avatar ph', style: st, 'aria-hidden': 'true' }, (name || '?').slice(0, 1).toUpperCase());
}

/* ---------- show / hide password ---------- */
/* pwField(input) returns a wrapper holding the input plus a Show/Hide button. */
function pwField(input) {
  const wrap = h('div', { class: 'pw' });
  const btn = h('button', { class: 'pw-t', type: 'button', 'aria-label': 'Show password', 'aria-pressed': 'false',
    on: { click: () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? 'Hide' : 'Show';
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      btn.setAttribute('aria-pressed', String(show));
      input.focus();
    } } }, 'Show');
  wrap.append(input, btn);
  return wrap;
}
/* Wrap an input that already sits in the page HTML. */
function wrapPw(sel) {
  const i = $(sel), ph = document.createComment('');
  i.replaceWith(ph); ph.replaceWith(pwField(i));
}
/* Put every password box back to hidden (after sign-in, or when a dialog opens). */
function hidePasswords() {
  $$('.pw').forEach(w => {
    const i = w.querySelector('input'), b = w.querySelector('button');
    i.type = 'password'; b.textContent = 'Show';
    b.setAttribute('aria-pressed', 'false'); b.setAttribute('aria-label', 'Show password');
  });
}

/* ---------- views ---------- */
function view(v, { push = true } = {}) {
  if (v === 'cart') return openCart();
  if (v === 'admin' && !S.admin) v = 'shop';
  /* Leaving a /product/<id> page: put "/" back in the address bar (unless the browser's Back button already did). */
  if (v !== 'product' && productIdFromPath() != null) {
    productSeq++; curProduct = null; setBaseTitle(SITE_TITLE);
    if (push) { try { history.pushState({ v }, '', '/'); } catch { /* history unavailable */ } }
  }
  S.view = v;
  const navV = v === 'product' ? 'shop' : v;
  $$('.view').forEach(e => e.hidden = e.id !== 'v-' + v);
  $$('.nav button').forEach(b => { const on = b.dataset.v === navV; b.classList.toggle('on', on); on ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'); });
  if (v === 'orders') loadOrders();
  if (v === 'sell') loadSell();
  if (v === 'admin') loadAdmin();
  scrollTo({ top: 0 });
}

/* ---------- notifications (unread messages + orders waiting to ship) ---------- */
let pollTimer = null;
const threadCount = (id, seller, asBuyer) => (S.notes.threads || []).filter(t => t.order_id === id && t.seller === seller && t.as_buyer === asBuyer).reduce((a, t) => a + t.n, 0);
function renderBadges() {
  const n = S.notes, set = (sel, v) => $$(sel).forEach(e => { e.textContent = v; e.hidden = !v; });
  const toShip = n.to_ship || 0, sellN = (n.seller_unread || 0) + toShip;
  set('.bn-bell', Math.min(n.feed_unread || 0, 99)); set('.bn-orders', n.buyer_unread || 0); set('.bn-sell', sellN); set('.bn-ship', toShip);
  $$('[data-unread]').forEach(e => {
    const [side, id, seller] = e.dataset.unread.split('|'), c = threadCount(+id, seller, side === 'b');
    e.textContent = c; e.hidden = !c;
  });
  const total = (n.buyer_unread || 0) + sellN;
  document.title = (total ? `(${total}) ` : '') + baseTitle;
}
async function pollNotes() {
  if (!S.user || document.hidden) return;
  if (S.admin) loadAdminCounts();
  const r = await api('/api/notifications');
  if (!r.success) return;
  S.notes = { threads: r.threads || [], buyer_unread: r.buyer_unread || 0, seller_unread: r.seller_unread || 0, to_ship: r.to_ship || 0, feed_unread: r.feed_unread || 0 };
  renderBadges();
}
function startPolling() { clearInterval(pollTimer); pollTimer = setInterval(pollNotes, 30000); pollNotes(); }
function stopPolling() {
  clearInterval(pollTimer); pollTimer = null;
  S.notes = { threads: [], buyer_unread: 0, seller_unread: 0, to_ship: 0 }; renderBadges();
}
function sessionExpired() {
  S.user = null; S.csrf = ''; S.cart = { items: [], total: 0 }; setAdmin(false);
  $('#btn-acct').textContent = 'Sign in'; $('#bellwrap').hidden = true; closeBell();
  stopPolling(); renderCart(); S.news = null; renderNews(); renderShop();
  toast('Your session expired. Please sign in again.', 'bad');
  if (S.view !== 'shop') view(S.view);
  if (!$('#dlg-auth').open) openAuth('login');
}

/* ---------- auth ---------- */
/* Message shown INSIDE the sign-in dialog (wrong password, locked account, success...).
   An empty text hides it. */
function authMsg(text, ok = false) {
  const m = $('#a-msg');
  if (!text) { m.hidden = true; m.textContent = ''; return; }
  m.textContent = text; m.className = 'form-msg' + (ok ? ' ok' : ''); m.hidden = false;
}
function openAuth(tab = 'login') {
  hidePasswords();
  setAuthTab(tab); $('#a-resend').hidden = true; $('#dlg-auth').showModal(); setTimeout(() => $('#a-user').focus(), 50);
  initGoogle();
}
function setAuthTab(t) {
  S.auth = t; authMsg('');
  $$('.auth-t button').forEach(b => b.classList.toggle('on', b.dataset.a === t));
  $('#a-email-w').hidden = t !== 'register'; $('#a-hint').hidden = t !== 'register'; $('#a-consents').hidden = t !== 'register';
  $('#a-forgot').hidden = t !== 'login';
  $('#a-user-l').textContent = t === 'login' ? 'Username or email' : 'Username';
  $('#a-go').textContent = t === 'login' ? 'Sign in' : 'Create account';
  $('#a-pass').autocomplete = t === 'login' ? 'current-password' : 'new-password';
}
function setUser(name, csrf, isAdmin) {
  S.user = { username: name }; S.csrf = csrf || '';
  $('#btn-acct').textContent = name; $('#bellwrap').hidden = false;
  setAdmin(isAdmin);
}
/* The Admin nav item exists only for admins (the server still enforces it on every /api/admin call). */
function setAdmin(on) {
  S.admin = on === true;
  $('#nav-admin').hidden = !S.admin;
  if (S.admin) loadAdminCounts();
  else { $$('.bn-admin, .bn-adm-disputes, .bn-adm-reports').forEach(e => { e.textContent = '0'; e.hidden = true; }); if (S.view === 'admin') view('shop'); }
}
/* Everything that happens after ANY successful sign-in (password or Google). */
async function afterLogin(username, csrf, isAdmin) {
  $('#dlg-auth').close(); $('#f-auth').reset(); hidePasswords(); authMsg('');
  setUser(username, csrf, isAdmin);
  toast('Welcome, ' + username + '!', 'ok');
  startPolling();
  await Promise.all([loadCart(), refreshProducts(), loadNews()]);
  if (S.view !== 'shop') view(S.view);
}
async function submitAuth(e) {
  e.preventDefault();
  authMsg('');
  const username = $('#a-user').value.trim(), password = $('#a-pass').value, email = $('#a-email').value.trim();
  if (!username || !password || (S.auth === 'register' && !email)) return authMsg('Please fill in every field.');
  if (S.auth === 'register') {
    /* Same rules as the server, so people get the answer instantly. */
    if (!/^\w{3,100}$/.test(username)) return authMsg('Username can only contain letters, numbers and underscores (3 characters or more).');
    if (!/^\S+@\S+\.\S+$/.test(email)) return authMsg('Please enter a valid email address.');
    if (password.length < 8) return authMsg('Password must be at least 8 characters.');
    if (!($('#a-age').checked && $('#a-terms').checked)) return authMsg('Please confirm you are 18+ and accept the Terms and Privacy Policy.');
  }
  const btn = $('#a-go'), label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Please wait…';
  S.lastUser = username;   // may be a username or an email: the server accepts both for resend
  const r = await api('/api/' + S.auth, { method: 'POST', body: S.auth === 'login' ? { username, password } : { username, password, email, accept_terms: $('#a-terms').checked, age_confirmed: $('#a-age').checked } });
  btn.disabled = false; btn.textContent = label;
  $('#a-resend').hidden = !(!r.success && /verify your email/i.test(r.message || ''));
  if (!r.success) {
    authMsg(r.message || 'Something went wrong. Please try again.');
    if (S.auth === 'login') { $('#a-pass').value = ''; $('#a-pass').focus(); }   // wrong password: clear it and let them retype
    return;
  }
  if (S.auth === 'register') {
    $('#a-pass').value = ''; setAuthTab('login');
    return authMsg(r.message, true);   // set AFTER the tab switch, which clears the message
  }
  await afterLogin(r.username || username, r.csrf_token, r.is_admin);
}

/* ---------- forgot password: emailed 6-digit code, then a new password ---------- */
const RP = { step: 1, id: '' };
function rpMsg(text, ok = false) {
  const m = $('#rp-msg');
  if (!text) { m.hidden = true; m.textContent = ''; return; }
  m.textContent = text; m.className = 'form-msg' + (ok ? ' ok' : ''); m.hidden = false;
}
function rpStep(n) {
  RP.step = n;
  $('#rp-step1').hidden = n !== 1; $('#rp-step2').hidden = n !== 2; $('#rp-resend').hidden = n !== 2;
  $('#rp-go').textContent = n === 1 ? 'Send code' : 'Change password';
  $('#rp-intro').textContent = n === 1
    ? "Enter your account email or username and we'll email you a 6-digit code."
    : 'Enter the code from your email and choose a new password.';
}
function openReset() {
  const prefill = $('#a-user').value.trim();   // reuse whatever they already typed on the sign-in form
  $('#dlg-auth').close();
  $('#f-reset').reset(); hidePasswords(); RP.id = '';
  $('#rp-id').value = prefill;
  rpStep(1); rpMsg('');
  $('#dlg-reset').showModal(); setTimeout(() => $('#rp-id').focus(), 50);
}
async function submitReset(e) {
  e.preventDefault(); rpMsg('');
  const btn = $('#rp-go'), label = btn.textContent;
  if (RP.step === 1) {
    const id = $('#rp-id').value.trim();
    if (!id) return rpMsg('Enter your email or username.');
    btn.disabled = true; btn.textContent = 'Sending…';
    const r = await api('/api/forgot-password', { method: 'POST', body: { identifier: id } });
    btn.disabled = false; btn.textContent = label;
    if (!r.success) return rpMsg(r.message);
    RP.id = id; rpStep(2); rpMsg(r.message, true);
    setTimeout(() => $('#rp-code').focus(), 50);
    return;
  }
  const code = $('#rp-code').value.trim(), pass = $('#rp-pass').value, pass2 = $('#rp-pass2').value;
  if (!/^\d{6}$/.test(code)) return rpMsg('Enter the 6-digit code from your email.');
  if (pass.length < 8) return rpMsg('Password must be at least 8 characters.');
  if (pass !== pass2) return rpMsg('The two passwords do not match.');
  btn.disabled = true; btn.textContent = 'Please wait…';
  const r = await api('/api/reset-password', { method: 'POST', body: { identifier: RP.id, code, password: pass } });
  btn.disabled = false; btn.textContent = label;
  if (!r.success) return rpMsg(r.message);
  $('#dlg-reset').close();
  openAuth('login');
  $('#a-user').value = RP.id;
  authMsg(r.message, true);   // set AFTER openAuth, which clears the message
  setTimeout(() => $('#a-pass').focus(), 80);
}

/* ---------- Google sign-in (button appears only if the server has GOOGLE_CLIENT_ID) ---------- */
function loadGoogle() {
  if (window.google && google.accounts && google.accounts.id) return Promise.resolve(true);
  return new Promise(res => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = () => res(true); s.onerror = () => res(false);
    document.head.append(s);
  });
}
async function initGoogle() {
  if (!S.cfg.google_client_id) return;
  if (!S.gReady) {
    if (!await loadGoogle()) return;
    try { google.accounts.id.initialize({ client_id: S.cfg.google_client_id, callback: googleCallback }); S.gReady = true; }
    catch { return; }
  }
  const box = $('#g-btn');
  $('#g-wrap').hidden = false; box.replaceChildren();
  google.accounts.id.renderButton(box, { type: 'standard', theme: currentTheme() === 'light' ? 'outline' : 'filled_black', size: 'large', text: 'continue_with', shape: 'pill', width: 300 });
}
async function googleCallback(resp) {
  authMsg('');
  const r = await api('/api/auth/google', { method: 'POST', body: { credential: resp.credential, accept_terms: $('#a-terms').checked, age_confirmed: $('#a-age').checked } });
  if (r.needs_consent) {   // brand-new Google user: show the 18+ / Terms boxes, then they click Google again
    setAuthTab('register'); $('#a-resend').hidden = true;
    return authMsg(r.message);
  }
  if (!r.success) return authMsg(r.message || 'Google sign-in failed. Please try again.');
  await afterLogin(r.username, r.csrf_token, r.is_admin);
}

/* ---------- account dialog ---------- */
async function openAccount() {
  $('#acct-name').textContent = 'Signed in as ' + S.user.username;
  $('#acct-info').hidden = true;
  $('#dlg-acct').showModal();
  const r = await api('/api/profile');
  if (!r.success) return;
  const p = r.profile;
  $('#acct-info').replaceChildren(
    p.email ? h('span', {}, p.email, ' ', h('span', { class: 'pill ' + (p.email_verified ? 'ok' : 'warn') }, p.email_verified ? 'email confirmed' : 'email not confirmed')) : null,
    p.member_since ? h('span', { class: 'mut' }, 'Member since ' + when(p.member_since).toLocaleDateString()) : null,
    h('span', { class: 'mut' }, p.google_linked ? (p.has_password ? 'Sign-in: password and Google' : 'Sign-in: Google (no password set)') : 'Sign-in: password'));
  $('#acct-info').hidden = false;
}
function cookieNotice() { try { if (localStorage.getItem('bm_cookie_ok')) return; } catch { /* show notice */ } $('#cookie').hidden = false; }
async function logout() {
  if (!await ask('Sign out?', 'You can sign back in at any time.', 'Sign out')) return;
  await api('/api/logout', { method: 'POST' }); location.reload();
}

/* ---------- newsletter: three states ---------- */
async function loadNews() {
  if (!S.user) { S.news = null; return renderNews(); }
  const r = await api('/api/newsletter/status');
  S.news = r.success ? !!r.subscribed : null;
  renderNews();
}
function renderNews() {
  const box = $('#news');
  /* State 3: signed-in member who is already subscribed -> Unsubscribe */
  if (S.user && S.news === true) {
    return box.replaceChildren(
      h('b', {}, 'BlueMart news'),
      h('p', { class: 'mut' }, 'You are subscribed to BlueMart news at your account email.'),
      h('div', { class: 'row' }, h('button', { class: 'btn ghost sm', type: 'button', on: { click: unsubscribeNews } }, 'Unsubscribe')));
  }
  /* A visitor who just subscribed on this page */
  if (!S.user && S.newsGuestDone) {
    return box.replaceChildren(
      h('b', {}, 'BlueMart news'),
      h('p', { class: 'ok' }, '✓ Thanks for subscribing! Every email has an unsubscribe link.'));
  }
  const consent = h('label', { class: 'chk', for: 'n-ok' }, h('input', { type: 'checkbox', id: 'n-ok' }),
    h('span', {}, 'I agree to receive occasional marketing emails from BlueMart. I can unsubscribe at any time. See the ', h('a', { href: '/privacy' }, 'Privacy Policy'), '.'));
  const go = h('button', { class: 'btn sm', type: 'submit' }, 'Subscribe');
  const form = S.user
    /* State 2: signed-in member, not subscribed -> no email box, we already have their address */
    ? h('form', { novalidate: true, on: { submit: subscribeNews } },
        h('b', {}, 'Get BlueMart news'),
        h('p', { class: 'mut' }, 'We will send offers and updates to your account email.'),
        consent, h('div', { class: 'row', style: 'margin-top:6px' }, go))
    /* State 1: visitor -> asks for an email */
    : h('form', { novalidate: true, on: { submit: subscribeNews } },
        h('b', {}, 'Get BlueMart news'),
        h('div', { class: 'row' }, h('input', { id: 'n-email', type: 'email', placeholder: 'you@example.com', 'aria-label': 'Email address for the newsletter', autocomplete: 'email' }), go),
        consent);
  box.replaceChildren(form);
}
async function subscribeNews(e) {
  e.preventDefault();
  const emailEl = $('#n-email'), email = emailEl ? emailEl.value.trim() : '';
  if (!S.user && !email) return toast('Enter your email address.', 'bad');
  if (!$('#n-ok').checked) return toast('Please tick the box to agree to receive emails.', 'bad');
  const body = { consent: true }; if (!S.user) body.email = email;
  const r = await api('/api/newsletter/subscribe', { method: 'POST', body });
  toast(r.message, r.success ? 'ok' : 'bad');
  if (!r.success) return;
  if (S.user) S.news = true; else S.newsGuestDone = true;
  renderNews();
}
async function unsubscribeNews() {
  if (!await ask('Unsubscribe?', 'You will stop receiving BlueMart marketing emails. Order and account emails are not affected.', 'Unsubscribe')) return;
  const r = await api('/api/newsletter/unsubscribe', { method: 'POST' });
  toast(r.message, r.success ? 'ok' : 'bad');
  if (r.success) { S.news = false; renderNews(); }
}

/* ---------- shop (server-side search, filters, sorting and pagination) ---------- */
const PER_PAGE = 24;
let listSeq = 0;
function loadError(msg) {
  $('#count').textContent = ''; $('#pager').hidden = true;
  $('#grid').replaceChildren(empty('Could not load products', msg || 'Please check your connection and try again.', ['Try again', async () => { $('#grid').replaceChildren(...Array.from({ length: 4 }, () => h('div', { class: 'sk' }))); await refreshProducts(); }]));
}
function listQuery() {
  const q = new URLSearchParams();
  if (S.q) q.set('q', S.q);
  if (S.cat !== 'all') q.set('category', S.cat);
  if (S.seller) q.set('seller', S.seller);
  if (S.minP !== '') q.set('min_price', S.minP);
  if (S.maxP !== '') q.set('max_price', S.maxP);
  if (S.stock) q.set('in_stock', '1');
  q.set('sort', S.sort); q.set('page', String(S.page)); q.set('per_page', String(PER_PAGE));
  return q.toString();
}
async function refreshProducts() {
  const seq = ++listSeq;
  const r = await api('/api/products?' + listQuery());
  if (seq !== listSeq) return;   // a newer search is already running
  if (!r.success) { toast(r.message || 'Could not load products.', 'bad'); if (!S.list.products.length) loadError(r.message); return; }
  S.list = { products: r.products || [], page: r.page || 1, pages: r.pages || 1, total: r.total || 0 };
  if (S.list.page > S.list.pages && S.list.pages >= 1) { S.page = S.list.pages; return refreshProducts(); }   // the last page shrank
  renderShop();
}
/* A seller changed their own listings: refresh the public list and, if open, the Listings tab. */
function mineChanged() { refreshProducts(); if (S.view === 'sell' && S.sellTab === 'listings') loadSell(); }
function filtersChanged() { S.page = 1; refreshProducts(); }
function renderCats() {
  $('#cats').replaceChildren(...['all', ...CATS].map(c => h('button', { type: 'button', class: S.cat === c ? 'on' : '', 'aria-pressed': String(S.cat === c), data: { cat: c } }, c === 'all' ? 'All' : c)));
}
function syncFilterInputs() { $('#q').value = S.q; $('#f-min').value = S.minP; $('#f-max').value = S.maxP; $('#f-stock').checked = S.stock; $('#sort').value = S.sort; }
const anyFilter = () => S.q || S.cat !== 'all' || S.seller || S.minP !== '' || S.maxP !== '' || S.stock;
function clearFilters() { Object.assign(S, { q: '', cat: 'all', seller: null, minP: '', maxP: '', stock: false, page: 1 }); syncFilterInputs(); renderCats(); refreshProducts(); }
function renderShop() {
  const { products: l, total } = S.list;
  const ban = $('#seller-banner');
  ban.hidden = !S.seller;
  if (S.seller) ban.replaceChildren(h('span', {}, 'Showing products by ', h('b', {}, S.seller)), h('button', { class: 'btn ghost sm', type: 'button', on: { click: () => { S.seller = null; filtersChanged(); } } }, 'Show all products'));
  $('#grid').replaceChildren(...(l.length ? l.map(card) : [empty('No products found', anyFilter() ? 'Try another search, category or price range.' : 'No one has listed anything yet. Be the first!', anyFilter() ? ['Clear filters', clearFilters] : ['Start selling', () => view('sell')])]));
  $('#count').textContent = `${total} product${total === 1 ? '' : 's'}`;
  renderPager();
}
function renderPager() {
  const nav = $('#pager'), { page, pages } = S.list;
  nav.hidden = pages <= 1;
  if (pages <= 1) return nav.replaceChildren();
  const nums = [];
  for (let i = 1; i <= pages; i++) if (i === 1 || i === pages || Math.abs(i - page) <= 1) nums.push(i); else if (nums[nums.length - 1] !== '…') nums.push('…');
  nav.replaceChildren(
    h('button', { type: 'button', disabled: page <= 1, 'aria-label': 'Previous page', data: { page: page - 1 } }, '‹ Prev'),
    ...nums.map(n => n === '…' ? h('span', { class: 'gap', 'aria-hidden': 'true' }, '…')
      : h('button', { type: 'button', class: n === page ? 'on' : '', 'aria-label': 'Page ' + n, 'aria-current': n === page ? 'page' : null, data: { page: n } }, String(n))),
    h('button', { type: 'button', disabled: page >= pages, 'aria-label': 'Next page', data: { page: page + 1 } }, 'Next ›'));
}
/* Seller rating helpers (used on cards, the detail page and the "other sellers" list). */
const ratingText = (r, n) => (n > 0 && r != null) ? `★ ${Number(r).toFixed(1)} (${n})` : 'No reviews yet';
const verifiedBadge = () => h('span', { class: 'pill ok sm' }, '✓ Verified seller');
function card(p) {
  const q = +p.Quantity, mine = S.user && p.Seller === S.user.username;
  return h('article', { class: 'pc' },
    h('button', { class: 'pimg', type: 'button', 'aria-label': 'View ' + p['Product Name'], data: { act: 'open', id: p.id } },
      p.image_url ? h('img', { src: img(p.image_url, 480), alt: '', width: 480, height: 408, loading: 'lazy', decoding: 'async' }) : h('span', { class: 'noimg' }, 'No image'),
      q > 0 && q <= 3 ? h('span', { class: 'tag warn' }, `Only ${q} left`) : null, q <= 0 ? h('span', { class: 'tag bad' }, 'Sold out') : null),
    h('div', { class: 'pb' },
      h('div', { class: 'prow' }, h('h3', {}, h('button', { class: 'linkbtn pname', type: 'button', data: { act: 'open', id: p.id } }, p['Product Name'])), h('b', { class: 'price' }, money(p.Price))),
      p.description ? h('p', { class: 'pdesc' }, p.description) : null,
      h('div', { class: 'meta' }, h('span', { class: 'chip' }, p.Category || 'General'), h('span', {}, 'by ' + p.Seller + (mine ? ' (you)' : ''))),
      h('div', { class: 'sline' }, h('span', { class: 'star' }, ratingText(p.seller_rating, p.seller_rating_count)), p.seller_verified ? verifiedBadge() : null),
      mine ? null : h('button', { class: 'btn sm full', type: 'button', data: { act: 'add', id: p.id }, disabled: q <= 0 }, q <= 0 ? 'Sold out' : 'Add to cart')));
}
async function addToCart(id, qty = 1) {
  if (!S.user) { toast('Sign in to add items to your cart.'); openAuth('login'); return false; }
  const r = await api('/api/cart/add', { method: 'POST', body: { product_id: +id, quantity: Math.max(1, Math.floor(+qty) || 1) } });
  toast(r.message, r.success ? 'ok' : 'bad');
  if (r.success) { await loadCart(); openCart(); }
  else if (r.status === 400) { refreshProducts(); if (S.view === 'product' && curProduct) showProduct(curProduct.id, false); }
  return r.success;
}

/* ---------- product detail view (URL: /product/<id>) ---------- */
let curProduct = null, productSeq = 0;
const productIdFromPath = () => { const m = location.pathname.match(/^\/product\/(\d+)/); return m ? +m[1] : null; };
async function showProduct(id, push = true) {
  id = +id; if (!id) return;
  if (push) {
    try { history.replaceState({ v: S.view }, '', location.href); history.pushState({ p: id }, '', '/product/' + id); } catch { /* history unavailable */ }
  }
  const seq = ++productSeq, body = $('#product-body');
  view('product');
  body.replaceChildren(h('div', { class: 'sk', style: 'height:260px' }));
  const r = await api('/api/products/' + id);
  if (seq !== productSeq) return;   // the person already went elsewhere
  curProduct = null;
  if (!r.success) {
    setBaseTitle(SITE_TITLE);
    return body.replaceChildren(backButton(), r.status === 404
      ? empty('Product not found', 'This listing may have been removed or never existed.', ['Browse products', () => view('shop')])
      : empty('Could not load this product', r.message, ['Try again', () => showProduct(id, false)]));
  }
  curProduct = r.product;
  setBaseTitle(r.product['Product Name'] + ' | BlueMart');
  renderProduct(r.product);
}
const backButton = () => h('button', { class: 'btn ghost sm back', type: 'button', on: { click: () => view('shop') } }, '← Back to products');
function renderProduct(p) {
  const body = $('#product-body'), q = +p.Quantity, mine = S.user && p.Seller === S.user.username;
  const images = (p.images && p.images.length) ? p.images : (p.image_url ? [{ id: 0, url: p.image_url }] : []);
  const main = images.length ? h('img', { src: img(images[0].url, 900), alt: p['Product Name'] }) : h('span', { class: 'noimg' }, 'No image');
  const gal = h('div', { class: 'gal' }, h('div', { class: 'pdi' }, main));
  if (images.length > 1) {
    const thumbs = h('div', { class: 'thumbs', role: 'group', 'aria-label': 'Product photos' });
    images.forEach((im, i) => {
      const b = h('button', { type: 'button', class: i === 0 ? 'on' : '', 'aria-label': `Show photo ${i + 1} of ${images.length}`, 'aria-pressed': String(i === 0),
        on: { click: () => { main.src = img(im.url, 900); [...thumbs.children].forEach(c => { c.classList.toggle('on', c === b); c.setAttribute('aria-pressed', String(c === b)); }); } } },
        h('img', { src: img(im.url, 120), alt: '', loading: 'lazy' }));
      thumbs.append(b);
    });
    gal.append(thumbs);
  }
  const qty = h('input', { class: 'qty', type: 'number', min: 1, max: Math.max(1, q), value: 1, 'aria-label': 'Quantity' });
  const info = h('div', { class: 'pdb' }, h('span', { class: 'chip' }, p.Category || 'General'), h('h2', {}, p['Product Name']),
    h('div', { class: 'price big' }, money(p.Price)),
    h('p', { class: q > 0 ? 'ok' : 'bad', style: 'margin:0' }, q > 0 ? `${q} in stock` : 'Sold out'),
    h('div', { class: 'sline', style: 'font-size:.88rem' }, 'Sold by ', h('button', { class: 'linkbtn', type: 'button', on: { click: () => openSeller(p.Seller) } }, p.Seller), h('span', { class: 'star' }, ratingText(p.seller_rating, p.seller_rating_count)), p.seller_verified ? verifiedBadge() : null),
    p.description ? h('p', { class: 'pdesc-full' }, p.description) : null,
    p.hidden ? h('div', { class: 'note warn' }, 'Removed by moderators: this listing is hidden from buyers.') : null,
    mine ? h('p', { class: 'mut' }, 'This is your listing.') : q > 0 && !p.hidden ? h('div', { class: 'row' }, h('label', { for: 'pd-qty', class: 'mut', style: 'margin:0' }, 'Quantity'), Object.assign(qty, { id: 'pd-qty' }),
      h('button', { class: 'btn', type: 'button', on: { click: () => addToCart(p.id, qty.value) } }, 'Add to cart')) : null,
    mine ? null : h('p', { style: 'margin:0;font-size:.8rem' }, h('button', { class: 'linkbtn', type: 'button', on: { click: () => openReport(p) } }, 'Report this listing')));
  const others = p.other_sellers || [];
  const otherBox = others.length ? h('section', { class: 'card others' }, h('h2', {}, 'Other sellers of this product'),
    ...others.map(o => {
      const oq = +o.Quantity, omine = S.user && o.Seller === S.user.username;
      return h('div', { class: 'line' },
        h('div', {}, h('button', { class: 'linkbtn', type: 'button', on: { click: () => openSeller(o.Seller) } }, o.Seller), h('span', { class: 'sline' }, h('span', { class: 'star' }, ratingText(o.seller_rating, o.seller_rating_count)), o.seller_verified ? verifiedBadge() : null)),
        h('div', {}, h('b', { class: 'price' }, money(o.Price)), h('span', { class: oq > 0 ? 'mut' : 'bad', style: 'font-size:.8rem' }, oq > 0 ? `${oq} in stock` : 'Sold out'),
          h('button', { class: 'btn ghost sm', type: 'button', on: { click: () => showProduct(o.id) } }, 'View'),
          omine ? h('span', { class: 'mut', style: 'font-size:.8rem' }, 'Your listing') : h('button', { class: 'btn sm', type: 'button', disabled: oq <= 0, 'aria-label': 'Add to cart from ' + o.Seller, on: { click: () => addToCart(o.id, 1) } }, oq <= 0 ? 'Sold out' : 'Add to cart')));
    })) : null;
  body.replaceChildren(backButton(), h('div', { class: 'pd' }, gal, info), otherBox);
}
let reportCtx = null;
function openReport(p) {
  if (!S.user) { toast('Sign in to report a listing.'); return openAuth('login'); }
  reportCtx = p.id; $('#f-report').reset(); $('#rep-msg').hidden = true;
  $('#rep-name').textContent = p['Product Name'] + ' · sold by ' + p.Seller;
  $('#dlg-report').showModal(); setTimeout(() => $('#rep-text').focus(), 50);
}
async function submitReport(e) {
  e.preventDefault();
  const m = $('#rep-msg'), t = $('#rep-text').value.trim();
  m.hidden = true;
  if (t.length < 5 || t.length > 500) { m.textContent = 'Please describe the problem in 5 to 500 characters.'; m.className = 'form-msg'; m.hidden = false; return; }
  const b = $('#rep-go'); b.disabled = true;
  const r = await api(`/api/products/${reportCtx}/report`, { method: 'POST', body: { reason: t } });
  b.disabled = false;
  if (!r.success) { m.textContent = r.message || 'Could not send the report.'; m.className = 'form-msg'; m.hidden = false; return; }
  $('#dlg-report').close(); toast(r.message || 'Thanks, we will review this listing.', 'ok');
}

/* ---------- public seller profile ---------- */
function sellerStats(s) {
  return [
    s.verified ? '✓ Verified seller' : null,
    s.rating_count ? `★ ${s.rating_average.toFixed(1)} (${s.rating_count} review${s.rating_count === 1 ? '' : 's'})` : 'No reviews yet',
    s.completed_orders ? `${s.completed_orders} completed order${s.completed_orders === 1 ? '' : 's'}` : null,
    s.on_time_rate ? `${s.on_time_rate}% shipped on time` : null,
  ].filter(Boolean).join(' · ');
}
async function openSeller(username) {
  const d = $('#dlg-seller');
  d.replaceChildren(h('button', { class: 'x', type: 'button', 'aria-label': 'Close', on: { click: () => d.close() } }, '×'), h('div', { class: 'sk', style: 'height:160px' }));
  d.showModal();
  const r = await api('/api/sellers/' + encodeURIComponent(username));
  if (!r.success) { d.replaceChildren(h('button', { class: 'x', type: 'button', 'aria-label': 'Close', on: { click: () => d.close() } }, '×'), empty('Could not load this seller', r.message)); return; }
  const s = r.seller;
  d.replaceChildren(
    h('button', { class: 'x', type: 'button', 'aria-label': 'Close', on: { click: () => d.close() } }, '×'),
    h('div', { class: 'shead' }, avatarEl(s.avatar_url, s.display_name || s.username, 72),
      h('div', {}, h('h2', {}, s.display_name || s.username),
        h('p', { class: 'mut' }, '@' + s.username + (s.location ? ' · ' + s.location : '')))),
    h('p', { class: 'mut', style: 'margin:0 0 12px;font-size:.88rem' }, sellerStats(s)),
    s.bio ? h('p', { class: 'bio' }, s.bio) : null,
    h('div', { class: 'row', style: 'margin-bottom:12px' }, h('button', { class: 'btn ghost sm', type: 'button', on: { click: () => {
      d.close(); Object.assign(S, { q: '', cat: 'all', seller: s.username, minP: '', maxP: '', stock: false, page: 1 });
      syncFilterInputs(); renderCats(); view('shop'); refreshProducts();
      $('#shop-ctl').scrollIntoView({ behavior: 'smooth', block: 'start' }); } } }, 'See their products')),
    h('h3', { style: 'font-size:1rem;margin-bottom:4px' }, 'Reviews'),
    ...(s.reviews.length ? s.reviews.map(v => h('div', { class: 'rev' },
      h('div', { class: 'line', style: 'padding:0' }, h('b', {}, '★'.repeat(v.rating)), h('span', { class: 'mut', style: 'font-size:.8rem' }, 'Verified purchase · ' + v.buyer_username + ' · ' + when(v.created_at).toLocaleDateString())),
      v.review_text ? h('p', {}, v.review_text) : null)) : [h('p', { class: 'mut' }, 'No reviews yet.')]));
}

/* ---------- cart ---------- */
let lastFocus = null;
const inertBg = on => ['.top', '.nav', '#main', '.foot', '#cookie'].forEach(s => { const e = $(s); if (e) e.inert = on; });
function openCart() { lastFocus = document.activeElement; $('#drawer').classList.add('on'); $('#drawer').setAttribute('aria-hidden', 'false'); $('#veil').classList.add('on'); inertBg(true); setTimeout(() => $('#cart-close').focus(), 50); if (S.user) loadCart(); else renderCart(); }
function closeCart() { if (!$('#drawer').classList.contains('on')) return; $('#drawer').classList.remove('on'); $('#drawer').setAttribute('aria-hidden', 'true'); $('#veil').classList.remove('on'); inertBg(false); if (lastFocus && lastFocus.focus) lastFocus.focus(); }
async function loadCart() {
  if (!S.user) { S.cart = { items: [], total: 0 }; return renderCart(); }
  const r = await api('/api/cart');
  if (r.success) S.cart = { items: r.items, total: r.total };
  renderCart();
}
function renderCart() {
  const n = S.cart.items.reduce((a, i) => a + i.quantity, 0);
  $$('.cn').forEach(e => { e.textContent = n; e.hidden = !n; });
  $('#cart-list').replaceChildren(...(S.cart.items.length ? S.cart.items.map(cartRow)
    : [S.user ? empty('Your cart is empty', 'Add something you like and it will appear here.', ['Browse products', () => { closeCart(); view('shop'); }]) : gate('Sign in to use your cart')]));
  const short = S.cart.items.some(i => i.available_stock < i.quantity);
  $('#cart-total').textContent = money(S.cart.total);
  $('#btn-checkout').disabled = !S.cart.items.length || short; $('#btn-clear').hidden = !S.cart.items.length;
}
function cartRow(i) {
  const short = i.available_stock < i.quantity;
  const qty = h('input', { type: 'number', min: 1, max: Math.max(1, i.available_stock), value: i.quantity, 'aria-label': 'Quantity for ' + i.product_name,
    on: { change: async () => {
      /* The server accepts 1..stock only, so fix the number here instead of showing an error. */
      const want = Math.min(Math.max(1, Math.floor(+qty.value) || 1), Math.max(1, i.available_stock));
      qty.value = want;
      const r = await api('/api/cart/update', { method: 'PUT', body: { product_id: i.product_id, quantity: want } });
      if (!r.success) toast(r.message, 'bad'); loadCart(); } } });
  return h('div', { class: 'ci' },
    i.image_url ? h('img', { src: img(i.image_url, 120), alt: '', width: 60, height: 60, loading: 'lazy' }) : h('span', { class: 'noimg' }, '—'),
    h('div', {}, h('b', {}, i.product_name), h('div', { class: 'mut', style: 'font-size:.82rem' }, `${money(i.price)} each · ${i.available_stock} available`),
      short ? h('div', { class: 'bad', style: 'font-size:.78rem' }, i.available_stock ? `Only ${i.available_stock} left: lower the quantity to check out.` : 'Sold out: remove it to check out.') : null,
      h('button', { class: 'link', type: 'button', on: { click: async () => { const r = await api('/api/cart/remove/' + i.product_id, { method: 'DELETE' }); toast(r.message, r.success ? 'ok' : 'bad'); loadCart(); } } }, 'Remove')),
    h('div', { style: 'text-align:right' }, qty, h('div', { style: 'font-weight:700;margin-top:6px' }, money(i.subtotal))));
}

/* ---------- checkout: delivery address -> Stripe ---------- */
function openShipping() {
  if (!S.user) return openAuth('login');
  if (!S.cart.items.length) return;
  closeCart();
  const f = S.ship || {};   // remembered for this visit only, never written to storage
  $('#s-name').value = f.full_name || ''; $('#s-phone').value = f.phone || ''; $('#s-addr').value = f.address || '';
  $('#s-city').value = f.city || ''; $('#s-region').value = f.region || ''; $('#s-country').value = f.country || ''; $('#s-notes').value = f.notes || '';
  $('#ship-total').textContent = money(S.cart.total);
  const b = $('#s-go'); b.disabled = false; b.textContent = 'Continue to payment';
  $('#dlg-ship').showModal(); setTimeout(() => $('#s-name').focus(), 50);
}
async function submitShipping(e) {
  e.preventDefault();
  const v = id => $(id).value.trim();
  const shipping = { full_name: v('#s-name'), phone: v('#s-phone'), address: v('#s-addr'), city: v('#s-city'), region: v('#s-region'), country: v('#s-country'), notes: v('#s-notes') };
  const need = [['full_name', 'name', 2], ['phone', 'phone number', 5], ['address', 'street address', 5], ['city', 'city', 2], ['country', 'country', 2]];
  for (const [k, label, min] of need) if (shipping[k].length < min) return toast(`Please enter a valid ${label}.`, 'bad');
  S.ship = shipping;
  const b = $('#s-go'); b.disabled = true; b.textContent = 'Preparing checkout…';
  const r = await api('/api/create-checkout-session', { method: 'POST', body: { shipping } });
  if (r.success && r.checkout_url) { location.href = r.checkout_url; return; }
  toast(r.message || 'Could not start checkout.', 'bad');
  b.disabled = false; b.textContent = 'Continue to payment';
  loadCart(); refreshProducts();   // stock may have changed
}

/* ---------- buyer orders ---------- */
function orderState(o) {
  if (o.payment_status === 'refunded') return ['Refunded', 'bad'];
  if (o.status === 'cancelled') return ['Cancelled', 'bad'];
  if (o.status === 'disputed') return ['Dispute open', 'bad'];
  if (o.status === 'completed') return ['Completed', 'ok'];
  if (o.payment_status !== 'paid') return ['Awaiting payment', 'warn'];
  if (o.status === 'delivered') return ['Delivered · confirm receipt', 'ok'];
  if (o.status === 'shipped') return ['Shipped', ''];
  return ['Paid · seller preparing', ''];
}
function timeline(o) {
  const at = o.status === 'completed' ? 4 : o.status === 'delivered' ? 3 : o.status === 'shipped' ? 2 : o.payment_status === 'paid' ? 1 : 0;
  return h('div', { class: 'tl' }, ['Paid', 'Preparing', 'Shipped', 'Delivered', 'Done'].map((t, i) => h('span', { class: i <= at ? 'd' : '' }, t)));
}
async function loadOrders() {
  const box = $('#orders');
  if (!S.user) return box.replaceChildren(gate('Sign in to see your orders'));
  box.replaceChildren(h('div', { class: 'sk' }));
  const r = await api('/api/orders');
  if (!r.success) return box.replaceChildren(empty('Could not load orders', r.message));
  /* Checkouts that were abandoned (never paid, then released) are noise: hide them. */
  const shown = r.orders.filter(o => !(o.status === 'cancelled' && o.payment_status === 'unpaid'));
  const hidden = r.orders.length - shown.length;
  if (!shown.length) return box.replaceChildren(empty('No orders yet', 'When you buy something it will show up here.', ['Start shopping', () => view('shop')]));
  box.replaceChildren(...shown.map(orderCard), hidden ? h('p', { class: 'mut', style: 'font-size:.8rem;text-align:center' }, `${hidden} abandoned checkout${hidden === 1 ? '' : 's'} not shown.`) : null);
  renderBadges();
}
function orderCard(o) {
  const [label, cls] = orderState(o), groups = {};
  const paid = o.payment_status === 'paid', closed = ['cancelled', 'refunded'].includes(o.status) || o.payment_status === 'refunded';
  o.items.forEach(i => (groups[i.seller_username || 'Seller'] ||= []).push(i));
  const card = h('section', { class: 'card' },
    h('div', { class: 'top-row' }, h('div', {}, h('b', {}, 'Order #' + o.id), h('div', { class: 'mut', style: 'font-size:.8rem' }, stamp(o.created_at))), h('span', { class: 'pill ' + cls }, label)),
    paid && !closed ? timeline(o) : null);
  if (o.ship_to) card.append(h('div', { class: 'box' }, h('span', { class: 'mut' }, 'Delivering to'), h('b', { class: 'addr', style: 'color:var(--tx)' }, o.ship_to)));
  Object.entries(groups).forEach(([seller, items]) => {
    const it = items[0], sh = it.shipment_status || 'pending', rated = o.reviews && o.reviews[seller];
    card.append(h('div', { class: 'grp' },
      h('div', { class: 'line' }, h('b', {}, 'Seller: ', h('button', { class: 'linkbtn', type: 'button', on: { click: () => openSeller(seller) } }, seller)), paid && !closed ? h('span', { class: 'mut' }, sh.replace('_', ' ')) : null),
      ...items.map(i => h('div', { class: 'line' }, h('span', {}, `${i.product_name} × ${i.quantity}`), h('b', {}, money(i.price * i.quantity)))),
      paid && !closed ? h('div', { class: 'box' }, h('span', { class: 'mut' }, 'Provider: ', h('b', { style: 'color:var(--tx)' }, real(it.provider) || 'Not added yet')), h('span', { class: 'mut' }, 'Tracking: ', h('b', { style: 'color:var(--tx)' }, real(it.tracking_number) || 'Waiting for seller'))) : null,
      paid && !closed ? h('div', { class: 'row', style: 'margin-top:10px' },
        h('button', { class: 'btn ghost sm', type: 'button', on: { click: () => openChat(o.id, seller, seller) } }, 'Message ' + seller, h('span', { class: 'badge alert', hidden: true, 'data-unread': `b|${o.id}|${seller}` }, '0')),
        o.status === 'completed' ? (rated
          ? h('span', { class: 'pill ok' }, `You rated ${seller} ${'★'.repeat(rated)}`)
          : h('button', { class: 'btn ghost sm', type: 'button', on: { click: () => openReview(o.id, seller) } }, 'Rate ' + seller)) : null) : null));
  });
  const acts = h('div', { class: 'row', style: 'margin-top:14px;justify-content:space-between' }, h('b', {}, 'Total ' + money(o.total)));
  const btns = h('div', { class: 'row' });
  if (paid && o.status === 'delivered') btns.append(h('button', { class: 'btn sm', type: 'button', on: { click: async () => {
    if (!await ask('Confirm delivery?', `Confirm you received everything in order #${o.id}. This releases the seller payout in the BlueMart ledger.`, 'Yes, I received it')) return;
    const r = await api(`/api/orders/${o.id}/confirm`, { method: 'POST', body: {} }); toast(r.message, r.success ? 'ok' : 'bad'); if (r.success) loadOrders(); } } }, '✓ Confirm delivery'));
  if (paid && !['completed', 'cancelled', 'refunded', 'disputed'].includes(o.status)) btns.append(h('button', { class: 'btn danger sm', type: 'button', on: { click: () => openDispute(o.id) } }, 'Report a problem'));
  if (!paid && o.status === 'pending') btns.append(h('button', { class: 'btn ghost sm', type: 'button', on: { click: async () => {
    if (!await ask('Cancel this checkout?', 'Your items will be released right away. Your cart is kept so you can try again.', 'Cancel checkout', true)) return;
    const r = await api(`/api/orders/${o.id}/cancel-checkout`, { method: 'POST', body: {} }); toast(r.message, r.success ? 'ok' : 'bad');
    loadOrders(); loadCart(); refreshProducts(); } } }, 'Cancel checkout'));
  acts.append(btns); card.append(acts);
  if (paid && o.status !== 'completed' && !closed) card.append(h('div', { class: 'note' }, 'BlueMart keeps the seller\'s payout marked as on hold until every shipment is delivered and you confirm receipt.'));
  if (o.status === 'disputed') card.append(h('div', { class: 'note warn' }, 'Your report is open. Payouts stay on hold while it is reviewed, and delivery cannot be confirmed until it is resolved.'));
  if (o.dispute) {
    const d = o.dispute;
    if (d.status === 'resolved') card.append(h('div', { class: 'note' }, h('b', {}, d.resolution === 'refund_buyer' ? 'Dispute resolved: you were refunded. ' : 'Dispute resolved: the payout was released to the seller. '), d.resolution_note || ''));
    else card.append(h('div', { class: 'note warn' }, 'Your report: ', d.reason));
  }
  if (paid && o.status === 'delivered' && Number(S.cfg.auto_confirm_days) > 0) card.append(h('div', { class: 'note' }, `Orders are confirmed automatically ${S.cfg.auto_confirm_days} days after delivery if no dispute is opened.`));
  if (o.payment_status === 'refunded') card.append(h('div', { class: 'note' }, 'This order was cancelled and your payment was refunded to your original payment method. Banks can take a few days to show it.'));
  if (!paid && o.status === 'pending') card.append(h('div', { class: 'note warn' }, 'Payment has not been completed. Your items are held for a short time and are released automatically if you do not pay (or right away if you cancel checkout). Already paid? ', h('button', { class: 'linkbtn', type: 'button', on: { click: async e => { e.target.disabled = true; const r = await api(`/api/orders/${o.id}/verify-payment`, { method: 'POST', body: {} }); toast(r.message, r.success && r.paid ? 'ok' : ''); loadOrders(); loadCart(); } } }, 'Check payment status')));
  return card;
}
let disputeId = null, reviewCtx = null;
function openDispute(id) { disputeId = id; $('#f-dispute').reset(); $('#dlg-dispute').showModal(); }
function openReview(id, seller) { reviewCtx = { id, seller }; $('#r-title').textContent = 'Rate ' + seller; $('#f-review').reset(); $('#dlg-review').showModal(); }

/* ---------- order messages (buyer <-> seller) ---------- */
const chat = { id: null, seller: null, sig: '', timer: null };
const chatUrl = () => `/api/orders/${chat.id}/messages?seller=${encodeURIComponent(chat.seller)}`;
function openChat(id, seller, who) {
  Object.assign(chat, { id, seller, sig: '' });
  $('#c-title').textContent = `Order #${id} · ${who}`;
  $('#c-log').replaceChildren(h('p', { class: 'mut' }, 'Loading…'));
  $('#c-text').value = ''; $('#c-count').textContent = '0/1000';
  $('#dlg-chat').showModal();
  loadChat(true);
  clearInterval(chat.timer); chat.timer = setInterval(() => loadChat(false), 8000);
}
async function loadChat(force) {
  const id = chat.id, seller = chat.seller; if (id == null) return;
  const r = await api(chatUrl());
  if (id !== chat.id || seller !== chat.seller) return;   // a different chat was opened meanwhile
  const log = $('#c-log');
  if (!r.success) { if (force) log.replaceChildren(h('p', { class: 'bad' }, r.message)); return; }
  const last = r.messages[r.messages.length - 1];
  const sig = r.messages.length + '|' + (last ? last.created_at : '');
  if (!force && sig === chat.sig) return;
  chat.sig = sig;
  const stick = force || log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  log.replaceChildren(...(r.messages.length ? r.messages.map(m =>
    h('div', { class: 'msg' + (m.mine ? ' me' : '') }, m.body, h('small', {}, (m.mine ? 'You' : m.sender) + ' · ' + stamp(m.created_at))))
    : [h('p', { class: 'mut' }, 'No messages yet. Say hello!')]));
  if (stick) log.scrollTop = log.scrollHeight;
}
async function sendChat(e) {
  e.preventDefault();
  const t = $('#c-text').value.trim(); if (!t || chat.id == null) return;
  const b = $('#c-go'); b.disabled = true;
  const r = await api(chatUrl(), { method: 'POST', body: { body: t } });
  b.disabled = false;
  if (!r.success) return toast(r.message, 'bad');
  $('#c-text').value = ''; $('#c-count').textContent = '0/1000';
  loadChat(true);
}

/* ---------- sell ---------- */
async function loadSell() {
  const body = $('#sell-body');
  $$('#sell-tabs button').forEach(b => { b.classList.toggle('on', b.dataset.t === S.sellTab); b.setAttribute('aria-pressed', String(b.dataset.t === S.sellTab)); });
  $('#btn-add-product').hidden = !S.user || S.sellTab !== 'listings';
  const on = $('#sell-tabs button.on'); if (on && on.scrollIntoView) on.scrollIntoView({ inline: 'center', block: 'nearest' });
  if (!S.user) return body.replaceChildren(gate('Sign in to start selling'));
  await ({ listings: sellListings, orders: sellOrders, payouts: sellPayouts, profile: sellProfile })[S.sellTab](body);
  renderBadges();
}
/* ---------- photos: drag & drop, preview, auto-resize (product photo and profile photo) ---------- */
const PHOTO_OK = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const AVATAR_OK = ['image/jpeg', 'image/png', 'image/webp'];   // the server rejects GIF avatars
const PHOTO_MAX_IN = 15 * 1024 * 1024;     // refuse enormous originals
const PHOTO_MAX_OUT = 4.5 * 1024 * 1024;   // stay under the server's 5 MB request limit
const fmtSize = b => b < 1048576 ? Math.max(1, Math.round(b / 1024)) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
async function loadBitmap(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    return await new Promise((resolve, reject) => {   // fallback via data: URL (allowed by our CSP)
      const fr = new FileReader();
      fr.onload = () => { const im = new Image(); im.onload = () => resolve(im); im.onerror = () => reject(new Error('bad image')); im.src = fr.result; };
      fr.onerror = () => reject(new Error('bad image')); fr.readAsDataURL(file);
    });
  }
}
function drawScaled(src, w, ht, max) {
  const k = Math.min(1, max / Math.max(w, ht)), cw = Math.round(w * k), ch = Math.round(ht * k);
  const c = document.createElement('canvas'); c.width = cw; c.height = ch;
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, cw, ch); x.drawImage(src, 0, 0, cw, ch);
  return c;
}
const canvasBlob = (c, q) => new Promise(res => c.toBlob(res, 'image/jpeg', q));
async function processPhoto(file, { types = PHOTO_OK, maxDim = 1600 } = {}) {
  if (!types.includes(file.type)) throw new Error('Please choose a ' + (types === AVATAR_OK ? 'JPG, PNG or WEBP' : 'JPG, PNG, WEBP or GIF') + ' image.');
  if (file.size > PHOTO_MAX_IN) throw new Error('That photo is over 15 MB. Please choose a smaller one.');
  let bmp;
  try { bmp = await loadBitmap(file); } catch { throw new Error('That file could not be read as an image.'); }
  const w = bmp.width || bmp.naturalWidth, ht = bmp.height || bmp.naturalHeight;
  const thumb = drawScaled(bmp, w, ht, 160).toDataURL('image/jpeg', 0.75);
  let out = file;
  if (file.type === 'image/gif') {
    if (file.size > PHOTO_MAX_OUT) throw new Error('GIFs must be under 4.5 MB.');
  } else if (Math.max(w, ht) > maxDim || file.size > 1.5 * 1048576) {
    const c = drawScaled(bmp, w, ht, maxDim); let q = 0.88, blob = await canvasBlob(c, q);
    while (blob && blob.size > PHOTO_MAX_OUT && q > 0.5) { q -= 0.1; blob = await canvasBlob(c, q); }
    if (!blob || blob.size > PHOTO_MAX_OUT) throw new Error('Could not shrink that photo enough. Please try a smaller one.');
    out = new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  }
  if (bmp.close) bmp.close();
  return { file: out, thumb, w, h: ht, original: file.size };
}
/* opts.key = which S.* slot holds the chosen photo ('photo' or 'avatar'). */
function photoField({ key = 'photo', types = PHOTO_OK, maxDim = 1600, label = 'product photo' } = {}) {
  const touch = window.matchMedia && matchMedia('(hover: none)').matches;
  const input = h('input', { type: 'file', accept: types.join(','), tabindex: '-1', 'aria-hidden': 'true', class: 'file-hide' });
  const icon = h('span', { class: 'drop-i', 'aria-hidden': 'true' });
  icon.innerHTML = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5-5 4 4 3-3 4 4"/></svg>';
  const zone = h('div', { class: 'drop', tabindex: '0', role: 'button', 'aria-label': `Add a ${label}. Press Enter to browse files, or drag a photo onto this area.` },
    icon,
    h('div', { class: 'drop-t' }, touch ? h('span', { class: 'drop-l' }, 'Tap to choose a photo') : ['Drag & drop a photo or ', h('span', { class: 'drop-l' }, 'browse')]),
    h('div', { class: 'drop-s' }, (types === AVATAR_OK ? 'JPG, PNG or WEBP' : 'JPG, PNG, WEBP or GIF') + ' · big photos are shrunk automatically'));
  const wrap = h('div', { class: 'photo-field' });
  const paint = () => {
    const p = S[key];
    if (!p) return wrap.replaceChildren(input, zone);
    wrap.replaceChildren(input, h('div', { class: 'prev' },
      h('img', { src: p.thumb, alt: 'Preview of the selected photo', width: 72, height: 72 }),
      h('div', { class: 'prev-i' }, h('b', {}, p.file.name), h('span', { class: 'mut' }, `${p.w}×${p.h} · ${fmtSize(p.file.size)}` + (p.file.size < p.original ? ` (was ${fmtSize(p.original)})` : ''))),
      h('button', { class: 'link', type: 'button', on: { click: () => { S[key] = null; paint(); } } }, 'Remove')));
  };
  const take = async file => {
    if (!file) return;
    zone.classList.add('busy');
    try { S[key] = await processPhoto(file, { types, maxDim }); } catch (e) { toast(e.message, 'bad'); }
    zone.classList.remove('busy'); input.value = ''; paint();
  };
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add('over'); }));
  ['dragleave', 'dragend'].forEach(ev => zone.addEventListener(ev, () => zone.classList.remove('over')));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('over'); take(e.dataTransfer.files[0]); });
  input.addEventListener('change', () => take(input.files[0]));
  paint();
  return wrap;
}

/* Profile photo: choose a file or take a picture. Phones open their camera; computers ask for the webcam. */
function avatarField(onChange) {
  const touch = window.matchMedia && matchMedia('(hover: none)').matches;
  const canStream = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && !touch;
  const fileIn = h('input', { type: 'file', accept: AVATAR_OK.join(','), tabindex: '-1', 'aria-hidden': 'true', class: 'file-hide' });
  const camIn = h('input', { type: 'file', accept: 'image/*', capture: 'user', tabindex: '-1', 'aria-hidden': 'true', class: 'file-hide' });
  const wrap = h('div', { class: 'photo-field' });
  const paint = () => {
    const p = S.avatar;
    if (p) return wrap.replaceChildren(fileIn, camIn, h('div', { class: 'prev' },
      h('img', { src: p.thumb, alt: 'Preview of the new profile photo', width: 72, height: 72 }),
      h('div', { class: 'prev-i' }, h('b', {}, 'New photo ready'), h('span', { class: 'mut' }, `${p.w}×${p.h} · ${fmtSize(p.file.size)} · saved when you press Save profile`)),
      h('button', { class: 'link', type: 'button', on: { click: () => { S.avatar = null; paint(); if (onChange) onChange(); } } }, 'Remove')));
    wrap.replaceChildren(fileIn, camIn, h('div', { class: 'pf-actions' },
      h('button', { class: 'btn ghost sm', type: 'button', on: { click: () => fileIn.click() } }, 'Choose Photo'),
      h('button', { class: 'btn ghost sm', type: 'button', on: { click: () => canStream ? openCamera() : camIn.click() } }, 'Take Photo')),
      h('div', { class: 'mut', style: 'font-size:.78rem' }, 'JPG, PNG or WEBP · big photos are shrunk automatically'));
  };
  const take = async file => {
    if (!file) return;
    try { S.avatar = await processPhoto(file, { types: AVATAR_OK, maxDim: 800 }); } catch (e) { toast(e.message, 'bad'); }
    fileIn.value = ''; camIn.value = ''; paint(); if (onChange) onChange();
  };
  fileIn.addEventListener('change', () => take(fileIn.files[0]));
  camIn.addEventListener('change', () => take(camIn.files[0]));
  async function openCamera() {
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 } }, audio: false }); }
    catch { return toast('The camera is blocked or missing. Allow camera access for this site, or use Choose Photo.', 'bad'); }
    const video = h('video', { autoplay: true, playsinline: true, muted: true });
    video.srcObject = stream;
    const stop = () => stream.getTracks().forEach(t => t.stop());
    const snap = h('button', { class: 'btn', type: 'button' }, 'Take picture');
    const dlg = h('dialog', { class: 'cam', 'aria-label': 'Take a profile photo' },
      h('h2', {}, 'Take a photo'), video,
      h('div', { class: 'acts-r', style: 'margin-top:12px' }, h('button', { class: 'btn ghost', type: 'button', on: { click: () => dlg.close() } }, 'Cancel'), snap));
    dlg.addEventListener('close', () => { stop(); dlg.remove(); });
    snap.addEventListener('click', () => {
      const w = video.videoWidth || 640, ht = video.videoHeight || 480, c = document.createElement('canvas'); c.width = w; c.height = ht;
      c.getContext('2d').drawImage(video, 0, 0, w, ht);
      c.toBlob(b => { dlg.close(); if (b) take(new File([b], 'camera.jpg', { type: 'image/jpeg' })); }, 'image/jpeg', 0.9);
    });
    document.body.append(dlg); dlg.showModal();
  }
  paint();
  return wrap;
}

const maxImages = () => Math.max(1, Number(S.cfg.max_product_images) || 5);
const IMG_MAX = 5 * 1048576;
/* Check each chosen file (type + size <= 5 MB; big photos are shrunk first) and return the ones that pass. */
async function pickPhotos(fileList, room) {
  const files = [...fileList], out = [];
  if (room <= 0) { toast(`You can have at most ${maxImages()} photos per product.`, 'bad'); return out; }
  if (files.length > room) toast(`Only ${room} more photo${room === 1 ? '' : 's'} can be added. The rest were skipped.`, 'bad');
  for (const f of files.slice(0, room)) {
    try {
      const ph = await processPhoto(f);
      if (ph.file.size > IMG_MAX) throw new Error('is larger than 5 MB.');
      out.push(ph);
    } catch (e) { toast(`${f.name}: ${e.message}`, 'bad'); }
  }
  return out;
}
/* Drag-and-drop area for SEVERAL photos (same look and behaviour as the single-photo area above).
   onFiles(array of File) does the work; full = true greys the area out (a product that has all its photos). */
function multiDrop({ onFiles, full = false }) {
  const touch = window.matchMedia && matchMedia('(hover: none)').matches;
  const input = h('input', { type: 'file', accept: PHOTO_OK.join(','), multiple: true, tabindex: '-1', 'aria-hidden': 'true', class: 'file-hide' });
  const icon = h('span', { class: 'drop-i', 'aria-hidden': 'true' });
  icon.innerHTML = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5-5 4 4 3-3 4 4"/></svg>';
  const zone = h('div', { class: 'drop' + (full ? ' busy' : ''), tabindex: full ? '-1' : '0', role: 'button', 'aria-disabled': String(full),
      'aria-label': 'Add photos. Press Enter to browse files, or drag photos onto this area.' },
    icon,
    h('div', { class: 'drop-t' }, full ? 'This listing has all its photos' : touch ? h('span', { class: 'drop-l' }, 'Tap to choose photos') : ['Drag & drop photos or ', h('span', { class: 'drop-l' }, 'browse')]),
    h('div', { class: 'drop-s' }, 'JPG, PNG, WEBP or GIF · big photos are shrunk automatically'));
  const camera = h('input', { type: 'file', accept: 'image/*', capture: 'environment', tabindex: '-1', 'aria-hidden': 'true', class: 'file-hide' });
  const take = async files => {
    files = [...(files || [])];                       // copy first: clearing the input empties its live FileList
    input.value = ''; camera.value = '';
    if (!files.length || full) return;
    zone.classList.add('busy');
    try { await onFiles(files); } finally { zone.classList.remove('busy'); }
  };
  zone.addEventListener('click', () => { if (!full) input.click(); });
  zone.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && !full) { e.preventDefault(); input.click(); } });
  ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); if (!full) zone.classList.add('over'); }));
  ['dragleave', 'dragend'].forEach(ev => zone.addEventListener(ev, () => zone.classList.remove('over')));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('over'); take(e.dataTransfer.files); });
  input.addEventListener('change', () => take(input.files));
  camera.addEventListener('change', () => take(camera.files));
  /* Phones and narrow screens: no drag & drop, just two big buttons (CSS swaps them in). */
  const mob = h('div', { class: 'mob-pick' },
    h('button', { class: 'btn', type: 'button', disabled: full, on: { click: () => input.click() } }, full ? 'This listing has all its photos' : 'Choose Photo'),
    h('button', { class: 'btn ghost', type: 'button', disabled: full, on: { click: () => camera.click() } }, 'Take Photo'),
    h('div', { class: 'mut', style: 'font-size:.78rem;text-align:center' }, 'JPG, PNG, WEBP or GIF · big photos are shrunk automatically'));
  return h('div', { class: 'photo-field' }, input, camera, zone, mob);
}
/* Multi-photo picker for the "Add a product" form: the chosen photos live in S.photos until the form is sent. */
function multiPhotoField() {
  const list = h('div', { class: 'mine-imgs', 'aria-live': 'polite' });
  const paint = () => list.replaceChildren(...S.photos.map((p, i) => h('div', { class: 'im' },
    h('img', { src: p.thumb, alt: 'Selected photo ' + (i + 1) }),
    h('button', { type: 'button', 'aria-label': 'Remove photo ' + (i + 1), on: { click: () => { S.photos.splice(i, 1); paint(); } } }, '×'))));
  const area = multiDrop({ onFiles: async files => {
    const got = await pickPhotos(files, maxImages() - S.photos.length);
    S.photos.push(...got); paint();
  } });
  paint();
  return h('div', {}, area, list);
}
/* Photos of an existing product (edit mode): add and remove straight away through the image endpoints. */
function existingPhotos(p) {
  const imgs = p.images || [];
  const area = multiDrop({ full: imgs.length >= maxImages(), onFiles: async files => {
    const got = await pickPhotos(files, maxImages() - imgs.length);
    if (!got.length) return;
    const fd = new FormData(); got.forEach(g => fd.append('images', g.file, g.file.name));
    const r = await api(`/api/products/${p.id}/images`, { method: 'POST', body: fd });
    toast(r.message, r.success ? 'ok' : 'bad');
    if (r.success) await refreshEdit();
  } });
  const grid = h('div', { class: 'mine-imgs' }, ...(imgs.length ? imgs.map((im, i) => h('div', { class: 'im' },
    h('img', { src: img(im.url, 120), alt: `Photo ${i + 1}` }),
    h('button', { type: 'button', 'aria-label': `Remove photo ${i + 1}`, on: { click: async () => {
      if (!await ask('Remove this photo?', 'It will no longer be shown on your listing.', 'Remove', true)) return;
      const r = await api(`/api/products/${p.id}/images/${im.id}`, { method: 'DELETE' });
      toast(r.message, r.success ? 'ok' : 'bad'); if (r.success) refreshEdit(); } } }, '×'))) : [h('span', { class: 'mut', style: 'font-size:.8rem' }, 'No photos yet.')]));
  return h('div', {}, grid, h('label', {}, `Add photos (${imgs.length}/${maxImages()})`), area,
    h('p', { class: 'mut', style: 'font-size:.78rem;margin:6px 0 0' }, 'JPG, PNG, WEBP or GIF, up to 5 MB each. Only upload photos you own or have permission to use.'));
}
/* Add / edit a product in a modal (a bottom sheet on phones). The form keeps the same field ids as before. */
function openProductModal(ed = null) {
  S.edit = ed; if (!ed) S.photos = [];
  const cur = S.cfg.currency || 'USD';
  const desc = h('textarea', { id: 'p-desc', maxlength: 2000, placeholder: 'Describe the item: condition, size, what is included…' }, ed ? (ed.description || '') : '');
  const dcnt = h('div', { class: 'count' }, `${desc.value.length}/2000`);
  desc.addEventListener('input', () => { dcnt.textContent = `${desc.value.length}/2000`; });
  const f = h('form', { id: 'f-prod', novalidate: true, on: { submit: submitProduct } },
    h('h2', { id: 'prod-t' }, ed ? 'Edit "' + ed['Product Name'] + '"' : 'Add a new product'),
    h('p', { class: 'mut', style: 'font-size:.8rem;margin:0' }, `BlueMart keeps a ${S.cfg.platform_fee_percent ?? 5}% fee on each sale, taken from your payout. Buyers pay only your listed price.`),
    h('div', { class: 'fgrid' },
      h('div', { class: 'span2' }, h('label', { for: 'p-name' }, 'Name'), h('input', { id: 'p-name', maxlength: 255, value: ed ? ed['Product Name'] : '' })),
      h('div', {}, h('label', { for: 'p-price' }, `Price (${cur})`), h('input', { id: 'p-price', type: 'number', inputmode: 'decimal', step: '0.01', min: S.cfg.min_price != null ? S.cfg.min_price : 0, max: S.cfg.max_price != null ? S.cfg.max_price : null, value: ed ? ed.Price : '' })),
      h('div', {}, h('label', { for: 'p-qty' }, 'Quantity'), h('input', { id: 'p-qty', type: 'number', inputmode: 'numeric', min: 0, step: 1, value: ed ? ed.Quantity : '' })),
      h('div', { class: 'span2' }, h('label', { for: 'p-cat' }, 'Category'), h('select', { id: 'p-cat' }, h('option', { value: '' }, 'Select…'), CATS.map(c => h('option', { value: c, selected: ed && ed.Category === c }, c)))),
      h('div', { class: 'span2' }, h('label', { for: 'p-desc' }, 'Description (optional)'), desc, dcnt)),
    ed ? [h('label', {}, 'Photos'), existingPhotos(ed)]
       : [h('label', {}, `Photos (optional, up to ${maxImages()})`), multiPhotoField(), h('p', { class: 'mut', style: 'font-size:.78rem;margin:6px 0 0' }, 'JPG, PNG, WEBP or GIF, up to 5 MB each. Only upload photos you own or have permission to use. Each of your listings needs its own name: to add stock to an existing listing use "+1 stock" or Edit.')],
    h('div', { class: 'acts-r' }, h('button', { class: 'btn ghost', type: 'button', on: { click: () => $('#dlg-prod').close() } }, 'Cancel'), h('button', { class: 'btn', id: 'p-go' }, ed ? 'Save changes' : 'List product')));
  $('#prod-body').replaceChildren(f);
  const d = $('#dlg-prod'); if (!d.open) d.showModal();
}
/* Reload my listings; if a product is open in the modal, redraw it from the fresh copy. */
async function refreshEdit() {
  const open = S.edit && S.edit.id;
  await loadSell(); refreshProducts();
  if (open) { const ed = S.mine.find(x => x.id === open); if (ed) openProductModal(ed); }
}
async function sellListings(body) {
  body.replaceChildren(h('div', { class: 'sk' }));
  const mr = await api('/api/seller/products');
  if (!mr.success) return body.replaceChildren(empty('Could not load your listings', mr.message));
  S.mine = mr.products || [];
  if (!S.mine.length) return body.replaceChildren(empty('Nothing listed yet', 'Add your first product and buyers can start ordering it.', ['+ Add new product', () => openProductModal(null)]));
  const stats = h('div', { class: 'stats' });
  const table = h('table', { class: 'inv' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Product'), h('th', {}, 'Category'), h('th', { class: 'num' }, 'Price'), h('th', { class: 'num' }, 'Stock'), h('th', {}, h('span', { class: 'sr' }, 'Actions')))),
    h('tbody', {}, ...S.mine.map(invRow)));
  body.replaceChildren(stats, h('section', { class: 'card flush' }, h('div', { class: 'tbl-wrap' }, table)));
  api('/api/statistics/mine').then(s => stats.append(h('div', {}, h('b', {}, s.total_products ?? 0), h('span', {}, 'Products listed')), h('div', {}, h('b', {}, s.total_quantity ?? 0), h('span', {}, 'Units in stock')), h('div', {}, h('b', {}, money(String(s.avg_price ?? '0').replace(/[^0-9.]/g, ''))), h('span', {}, 'Average price'))));
}
function invRow(p) {
  const q = +p.Quantity;
  return h('tr', {},
    h('td', { class: 'c-prod' }, h('div', { class: 'inv-p' },
      h('div', { class: 'inv-img' }, p.image_url ? h('img', { src: img(p.image_url, 120), alt: '', loading: 'lazy' }) : h('span', { class: 'noimg' }, 'No image')),
      h('div', {}, h('b', {}, p['Product Name']), p.hidden ? h('div', { class: 'inv-warn' }, 'Hidden by moderators: buyers cannot see this listing.') : null))),
    h('td', { 'data-l': 'Category' }, h('span', { class: 'chip' }, p.Category)),
    h('td', { class: 'num', 'data-l': 'Price' }, money(p.Price)),
    h('td', { class: 'num', 'data-l': 'Stock' }, q <= 0 ? h('span', { class: 'pill bad sm' }, 'Sold out') : q <= 3 ? h('span', { class: 'pill warn sm' }, `Only ${q} left`) : String(q)),
    h('td', { class: 'c-acts' }, h('div', { class: 'row' },
      h('button', { class: 'btn ghost sm', type: 'button', on: { click: async () => { const r = await api('/api/products/restock', { method: 'POST', body: { product_id: p.id, quantity: 1 } }); toast(r.message, r.success ? 'ok' : 'bad'); if (r.success) mineChanged(); } } }, '+1 stock'),
      h('button', { class: 'btn ghost sm', type: 'button', on: { click: () => openProductModal(p) } }, 'Edit'),
      h('button', { class: 'btn danger sm', type: 'button', on: { click: async () => { if (!await ask('Delete listing?', `Remove "${p['Product Name']}" from your store. Products that are part of an active order cannot be deleted yet.`, 'Delete', true)) return; const r = await api('/api/products/delete', { method: 'POST', body: { product_id: p.id } }); toast(r.message, r.success ? 'ok' : 'bad'); if (r.success) mineChanged(); } } }, 'Delete'))));
}
async function submitProduct(e) {
  e.preventDefault();
  const name = $('#p-name').value.trim(), price = $('#p-price').value, category = $('#p-cat').value, quantity = $('#p-qty').value, description = $('#p-desc').value.trim();
  if (!name) return toast('Product name is required.', 'bad');
  if (price !== '' && (+price < 0 || !isFinite(+price))) return toast('Price must be 0 or more.', 'bad');
  if (price !== '' && S.cfg.min_price != null && +price < +S.cfg.min_price) return toast(`Price must be at least ${money(S.cfg.min_price)}.`, 'bad');
  if (price !== '' && S.cfg.max_price != null && +price > +S.cfg.max_price) return toast(`Price must be at most ${money(S.cfg.max_price)}.`, 'bad');
  if (quantity !== '' && (+quantity < 0 || !Number.isInteger(+quantity))) return toast('Quantity must be a whole number, 0 or more.', 'bad');
  if (description.length > 2000) return toast('The description can be at most 2000 characters.', 'bad');
  const btn = $('#p-go'); btn.disabled = true; let r;
  if (S.edit) {
    const body = { product_id: S.edit.id, description };
    if (name !== S.edit['Product Name']) body.new_name = name;
    if (price !== '') body.price = +price; if (category) body.category = category; if (quantity !== '') body.quantity = +quantity;
    r = await api('/api/products/edit', { method: 'POST', body });
  } else {
    if (price === '' || !category || quantity === '') { btn.disabled = false; return toast('Price, category and quantity are required.', 'bad'); }
    const fd = new FormData(); fd.append('name', name); fd.append('price', price); fd.append('category', category); fd.append('quantity', quantity);
    if (description) fd.append('description', description);
    S.photos.forEach(p => fd.append('images', p.file, p.file.name));
    r = await api('/api/products/add', { method: 'POST', body: fd });
  }
  btn.disabled = false; toast(r.message, r.success ? 'ok' : 'bad');
  if (r.success) { $('#dlg-prod').close(); mineChanged(); }
}
const orderBucket = o => {
  const sh = o.shipment_status || 'pending';
  if (['cancelled', 'refunded'].includes(o.status) || o.payment_status === 'refunded' || sh === 'cancelled') return null;
  return sh === 'pending' ? 'ship' : sh === 'shipped' ? 'shipped' : 'delivered';
};
async function sellOrders(body) {
  body.replaceChildren(h('div', { class: 'sk' }));
  const r = await api('/api/seller/orders');
  if (!r.success) return body.replaceChildren(empty('Could not load orders', r.message));
  if (!r.orders.length) return body.replaceChildren(empty('No paid orders yet', 'Orders containing your products will appear here once they are paid.'));
  const groups = { ship: [], shipped: [], delivered: [] };
  r.orders.forEach(o => { const b = orderBucket(o); if (b) groups[b].push(o); });
  if (!groups[S.sellFilter]) S.sellFilter = 'ship';
  const FILTERS = [['ship', 'To Ship'], ['shipped', 'Shipped'], ['delivered', 'Delivered']];
  const EMPTY = { ship: ['Nothing to ship', 'New paid orders show up here.'], shipped: ['Nothing in transit', 'Orders you have shipped wait here until they are delivered.'], delivered: ['No delivered orders yet', 'Delivered and confirmed orders are listed here.'] };
  const paint = () => {
    const list = groups[S.sellFilter];
    body.replaceChildren(
      h('div', { class: 'pillbar', role: 'group', 'aria-label': 'Filter orders' }, ...FILTERS.map(([k, label]) =>
        h('button', { type: 'button', class: 'fpill' + (S.sellFilter === k ? ' on' : ''), 'aria-pressed': String(S.sellFilter === k), on: { click: () => { S.sellFilter = k; paint(); } } }, label, h('span', { class: 'cnt' }, String(groups[k].length))))),
      ...(list.length ? list.map(sellerCard) : [empty(...EMPTY[S.sellFilter])]));
  };
  paint();
}
function sellerCard(o) {
  const sh = o.shipment_status || 'pending', closed = ['cancelled', 'refunded'].includes(o.status) || o.payment_status === 'refunded';
  const pillText = o.status === 'disputed' ? 'dispute open' : closed ? 'cancelled' : sh.replace('_', ' ');
  const pillCls = o.status === 'disputed' || closed ? 'bad' : sh === 'pending' ? 'warn' : 'ok';
  const items = h('div', { class: 'oc-items' }, h('span', { class: 'mut oc-l' }, 'Products'),
    ...o.items.map(i => h('div', { class: 'line' }, h('span', {}, `${i.product_name} × ${i.quantity}`), h('b', {}, money(i.price * i.quantity)))));
  let ship;
  if (o.shipping) {
    const s = o.shipping, place = [s.city, s.region].filter(Boolean).join(', '), tel = (s.phone || '').replace(/[^\d+]/g, '');
    ship = h('div', { class: 'box oc-ship' },
      h('span', { class: 'mut oc-l' }, 'Ship to'),
      h('b', { style: 'color:var(--tx)' }, s.full_name),
      h('span', { class: 'addr' }, [s.address, place, s.country].filter(Boolean).join('\n')),
      s.phone ? h('span', {}, 'Phone: ', tel ? h('a', { href: 'tel:' + tel }, s.phone) : s.phone) : null,
      s.notes ? h('span', { class: 'mut' }, 'Notes: ' + s.notes) : null,
      h('span', { class: 'mut', style: 'font-size:.74rem' }, 'Use these details only to deliver this order.'));
  } else ship = h('div', { class: 'box oc-ship' }, h('span', { class: 'mut oc-l' }, 'Ship to'), h('span', { class: 'mut' }, 'No delivery address (the order was cancelled).'));
  const card = h('section', { class: 'card ocard' },
    h('div', { class: 'top-row' }, h('div', {}, h('b', {}, 'Order #' + o.id), h('div', { class: 'mut', style: 'font-size:.8rem' }, `Buyer ${o.buyer_username} · ${stamp(o.created_at)}`)), h('span', { class: 'pill ' + pillCls }, pillText)),
    h('div', { class: 'oc-grid' }, items, ship));
  if (o.payout_status) card.append(h('div', { class: 'note' }, `Your payout: ${money(o.payout_amount)} (fee ${money(o.platform_fee)}) · ${o.payout_status === 'released' ? 'released' : o.payout_status === 'cancelled' ? 'cancelled' : 'on hold until the buyer confirms delivery'}`));
  if (o.status === 'disputed') card.append(h('div', { class: 'note warn' }, 'The buyer opened a dispute. Payouts stay on hold until it is resolved. You can reply to the buyer in messages.'));
  if (['pending', 'shipped'].includes(sh) && !closed && o.status !== 'disputed' && o.status !== 'completed') {
    const prov = h('select', { 'aria-label': 'Carrier' }, ['DHL', 'FedEx', 'UPS', 'Local delivery', 'Other'].map(x => h('option', { selected: real(o.provider) === x }, x)));
    const trk = h('input', { placeholder: 'Tracking number', 'aria-label': 'Tracking number', maxlength: 150, value: real(o.tracking_number) || '' });
    const go = h('button', { class: 'btn', type: 'button', on: { click: async () => {
      if (trk.value.trim().length < 2) return toast('Enter a tracking number.', 'bad');
      go.disabled = true; const r = await api(`/api/seller/orders/${o.id}/ship`, { method: 'POST', body: { provider: prov.value, tracking_number: trk.value.trim() } });
      go.disabled = false; toast(r.message, r.success ? 'ok' : 'bad'); if (r.success) { loadSell(); pollNotes(); } } } }, sh === 'shipped' ? 'Update shipment' : 'Confirm Shipment');
    card.append(h('div', { class: 'ship' }, prov, trk, go));
  }
  const row = h('div', { class: 'row', style: 'margin-top:12px' });
  if (!closed) row.append(h('button', { class: 'btn ghost sm', type: 'button', on: { click: () => openChat(o.id, S.user.username, o.buyer_username) } }, 'Message buyer', h('span', { class: 'badge alert', hidden: true, 'data-unread': `s|${o.id}|${S.user.username}` }, '0')));
  if (sh === 'shipped' && !closed && o.status !== 'disputed') row.append(h('button', { class: 'btn ghost sm', type: 'button', on: { click: async () => { const r = await api(`/api/seller/orders/${o.id}/delivered`, { method: 'POST', body: {} }); toast(r.message, r.success ? 'ok' : 'bad'); if (r.success) loadSell(); } } }, 'Mark as delivered'));
  /* The server only lets a seller cancel & refund BEFORE shipping, and only single-seller orders. */
  if (sh === 'pending' && !['completed', 'cancelled', 'disputed'].includes(o.status) && !closed) row.append(h('button', { class: 'btn danger sm', type: 'button', on: { click: async () => {
    if (!await ask('Cancel and refund?', 'The buyer is refunded in full and the stock is returned. This cannot be undone. Orders with several sellers must be cancelled through support.', 'Cancel & refund', true)) return;
    const r = await api(`/api/seller/orders/${o.id}/cancel`, { method: 'POST', body: {} }); toast(r.message, r.success ? 'ok' : 'bad'); if (r.success) { loadSell(); pollNotes(); } } } }, 'Cancel & refund'));
  if (row.children.length) card.append(row);
  return card;
}
async function sellPayouts(body) {
  body.replaceChildren(h('div', { class: 'sk' }));
  const r = await api('/api/seller/payouts');
  if (!r.success) return body.replaceChildren(empty('Could not load payouts', r.message));
  const sum = st => r.payouts.filter(p => p.status === st).reduce((a, p) => a + toNum(p.payout_amount), 0);
  const avail = sum('released'), held = sum('held'), fee = S.cfg.platform_fee_percent ?? 5;
  const label = st => st === 'released' ? ['Available', 'ok'] : st === 'held' ? ['On hold', 'warn'] : st === 'cancelled' ? ['Cancelled', 'bad'] : [st, ''];
  body.replaceChildren(
    h('div', { class: 'stats' },
      h('div', {}, h('b', {}, money(avail)), h('span', {}, 'Available to Payout')),
      h('div', {}, h('b', {}, money(held)), h('span', {}, 'Pending / On Hold')),
      h('div', {}, h('b', {}, money(avail + held)), h('span', {}, 'Total Earned'))),
    h('section', { class: 'card pay-conn' },
      h('div', { class: 'top-row', style: 'margin:0 0 10px' }, h('div', {}, h('b', {}, 'Buyer payments'), h('p', { class: 'mut', style: 'margin:4px 0 0;font-size:.86rem' }, 'Buyers pay through Stripe. Every sale below was paid and is tracked here.')), h('span', { class: 'pill ok' }, 'Stripe connected')),
      h('div', { class: 'top-row', style: 'margin:0' }, h('div', {}, h('b', {}, 'Your payouts'), h('p', { class: 'mut', style: 'margin:4px 0 0;font-size:.86rem' }, 'Money you earn is recorded in the ledger below. Sending it to your bank is not automatic yet, so BlueMart pays you from this ledger.')), h('span', { class: 'pill warn' }, 'Paid from ledger'))),
    h('section', { class: 'card flush' }, h('div', { class: 'tbl-wrap' }, r.payouts.length
      ? h('table', { class: 'inv pay' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Order #'), h('th', { class: 'num' }, 'Sale Price'), h('th', { class: 'num' }, `${fee}% Platform Fee`), h('th', { class: 'num' }, 'Net Earnings'), h('th', {}, 'Payout Status'))),
          h('tbody', {}, ...r.payouts.map(p => { const [t, c] = label(p.status); return h('tr', {},
            h('td', { 'data-l': 'Date' }, when(p.created_at).toLocaleDateString([], { dateStyle: 'medium' })),
            h('td', { 'data-l': 'Order #' }, '#' + p.order_id),
            h('td', { class: 'num', 'data-l': 'Sale Price' }, money(p.gross_amount)),
            h('td', { class: 'num', 'data-l': 'Platform Fee' }, '− ' + money(p.platform_fee)),
            h('td', { class: 'num', 'data-l': 'Net Earnings' }, h('b', {}, money(p.payout_amount))),
            h('td', { 'data-l': 'Status' }, h('span', { class: 'pill sm ' + c }, t))); })))
      : h('p', { class: 'mut', style: 'padding:20px;text-align:center;margin:0' }, 'No payouts yet. An entry is added when one of your orders is paid.'))));
}
/* Seller profile tab: how you look to buyers + a form to edit it (display name, location, about, photo). */
async function sellProfile(body) {
  body.replaceChildren(h('div', { class: 'sk' }));
  const [pr, sr] = await Promise.all([api('/api/profile'), api('/api/sellers/' + encodeURIComponent(S.user.username))]);
  if (!pr.success || !sr.success) return body.replaceChildren(empty('Could not load profile', pr.message || sr.message));
  const p = pr.profile, s = sr.seller; S.avatar = null;
  const name = h('input', { id: 'pf-name', maxlength: 60, value: p.display_name, placeholder: p.username, autocomplete: 'nickname' });
  const loc = h('input', { id: 'pf-loc', maxlength: 100, value: p.location, placeholder: 'City, Country', autocomplete: 'address-level2' });
  const bio = h('textarea', { id: 'pf-bio', maxlength: 500, placeholder: 'Tell buyers what you sell and how you work.' }, p.bio);
  const cnt = h('div', { class: 'count' }, `${p.bio.length}/500`);
  bio.addEventListener('input', () => { cnt.textContent = `${bio.value.length}/500`; });
  const rm = p.avatar_url ? h('label', { class: 'chk', for: 'pf-rm' }, h('input', { type: 'checkbox', id: 'pf-rm' }), h('span', {}, 'Remove my current photo')) : null;
  const form = h('form', { class: 'card', novalidate: true, on: { submit: async e => {
    e.preventDefault();
    const fd = new FormData(); fd.append('display_name', name.value.trim()); fd.append('location', loc.value.trim()); fd.append('bio', bio.value.trim());
    if (S.avatar) fd.append('avatar', S.avatar.file, S.avatar.file.name);
    else if (rm && $('#pf-rm').checked) fd.append('remove_avatar', '1');
    go.disabled = true; const r = await api('/api/profile', { method: 'POST', body: fd }); go.disabled = false;
    toast(r.message, r.success ? 'ok' : 'bad'); if (r.success) loadSell(); } } },
    h('h2', {}, 'Your public profile'),
    h('p', { class: 'mut', style: 'font-size:.84rem;margin:0' }, 'Buyers see this when they open your name on a product or order. Your email is never shown.'),
    h('div', { class: 'pf-row' }, avatarEl(p.avatar_url, p.display_name || p.username, 64), h('span', { class: 'mut', style: 'font-size:.84rem' }, p.avatar_url ? 'Current photo' : 'No photo yet')),
    rm,
    h('label', {}, 'New photo (optional)'), avatarField(() => drawPrev()),
    h('label', { for: 'pf-name' }, 'Display name'), name,
    h('label', { for: 'pf-loc' }, 'Location'), loc,
    h('label', { for: 'pf-bio' }, 'About you'), bio, cnt);
  const go = h('button', { class: 'btn', type: 'submit' }, 'Save profile');
  form.append(h('div', { class: 'row', style: 'margin-top:14px' }, go));
  /* Live preview: redrawn on every keystroke, so you see what buyers will see before saving. */
  const prevBox = h('section', { class: 'card pf-prev', 'aria-label': 'Live preview of your store' });
  const drawPrev = () => {
    const nm = name.value.trim() || p.username, removed = rm && rm.querySelector('input').checked;
    const av = S.avatar ? h('img', { class: 'avatar', src: S.avatar.thumb, alt: '', style: 'width:72px;height:72px', width: 72, height: 72 }) : avatarEl(removed ? null : p.avatar_url, nm, 72);
    prevBox.replaceChildren(
      h('div', { class: 'top-row', style: 'margin-bottom:8px' }, h('span', { class: 'pill sm' }, 'Live preview'), h('span', { class: 'mut', style: 'font-size:.78rem' }, 'This is how buyers see your store')),
      h('div', { class: 'pf-prev-head' }, av, h('div', {}, h('h3', {}, nm, ' ', s.verified ? verifiedBadge() : null), h('div', { class: 'mut', style: 'font-size:.84rem' }, '@' + p.username + (loc.value.trim() ? ' · ' + loc.value.trim() : '')))),
      h('p', { class: bio.value.trim() ? '' : 'mut', style: 'margin:12px 0;white-space:pre-line' }, bio.value.trim() || 'Your “About you” text appears here.'),
      h('div', { class: 'stats' },
        h('div', {}, h('b', {}, s.rating_count ? '★ ' + s.rating_average.toFixed(1) : '—'), h('span', {}, `${s.rating_count} review${s.rating_count === 1 ? '' : 's'}`)),
        h('div', {}, h('b', {}, s.completed_orders), h('span', {}, 'Completed orders')),
        h('div', {}, h('b', {}, s.on_time_rate ? s.on_time_rate + '%' : '—'), h('span', {}, 'Shipped on time'))),
      h('p', { class: 'mut', style: 'font-size:.82rem;margin:0 0 12px' }, s.verified ? '✓ BlueMart has marked you as a Verified seller.' : 'The “Verified seller” badge is given by BlueMart staff. You cannot apply for it.'),
      h('button', { class: 'btn ghost sm', type: 'button', on: { click: () => openSeller(S.user.username) } }, 'Open public page'));
  };
  [name, loc, bio].forEach(e => e.addEventListener('input', drawPrev));
  if (rm) rm.querySelector('input').addEventListener('change', drawPrev);
  drawPrev();
  /* Delete account: password members confirm with their password, Google-only members type DELETE. */
  const hasPw = !!p.has_password;
  /* Change password (or set one, for people who signed up with Google). Other devices are signed out. */
  const pwCur = h('input', { id: 'pw-cur', type: 'password', autocomplete: 'current-password' });
  const pwNew = h('input', { id: 'pw-new', type: 'password', autocomplete: 'new-password', minlength: 8 });
  const pwNew2 = h('input', { id: 'pw-new2', type: 'password', autocomplete: 'new-password', minlength: 8 });
  const pwGo = h('button', { class: 'btn', type: 'submit' }, hasPw ? 'Change password' : 'Set password');
  const pwForm = h('form', { class: 'card', novalidate: true, on: { submit: async e => {
    e.preventDefault();
    if (hasPw && !pwCur.value) return toast('Enter your current password.', 'bad');
    if (pwNew.value.length < 8) return toast('The new password must be at least 8 characters.', 'bad');
    if (pwNew.value !== pwNew2.value) return toast('The two new passwords do not match.', 'bad');
    pwGo.disabled = true;
    const r = await api('/api/account/password', { method: 'POST', body: { current_password: hasPw ? pwCur.value : '', new_password: pwNew.value } });
    pwGo.disabled = false;
    toast(r.message, r.success ? 'ok' : 'bad');
    if (r.success) { if (r.csrf_token) S.csrf = r.csrf_token; loadSell(); } } } },
    h('h2', {}, hasPw ? 'Change password' : 'Set a password'),
    h('p', { class: 'mut', style: 'font-size:.84rem;margin:0' }, hasPw ? 'You will stay signed in here. Every other device is signed out.' : 'Add a password so you can also sign in with your email.'),
    hasPw ? h('label', { for: 'pw-cur' }, 'Current password') : null, hasPw ? pwField(pwCur) : null,
    h('label', { for: 'pw-new' }, 'New password (at least 8 characters)'), pwField(pwNew),
    h('label', { for: 'pw-new2' }, 'Repeat the new password'), pwField(pwNew2),
    h('div', { class: 'acts-r' }, pwGo));
  const delIn = h('input', { id: 'del-input', type: hasPw ? 'password' : 'text', autocomplete: hasPw ? 'current-password' : 'off', placeholder: hasPw ? '' : 'DELETE' });
  const delForm = h('form', { class: 'card', novalidate: true, style: 'border-color:rgba(248,113,113,.4)', on: { submit: async e => {
    e.preventDefault();
    const val = delIn.value;
    if (!val.trim()) return toast(hasPw ? 'Enter your password to continue.' : 'Type DELETE to confirm.', 'bad');
    if (!await ask('Delete your account?', 'Your email, listings, cart and delivery addresses are removed right away. This cannot be undone.', 'Delete my account', true)) return;
    const r = await api('/api/account/delete', { method: 'POST', body: hasPw ? { password: val } : { confirm: val.trim() } });
    toast(r.message, r.success ? 'ok' : 'bad');
    if (r.success) setTimeout(() => location.reload(), 1200); } } },
    h('h2', {}, 'Delete my account'),
    h('p', { class: 'mut', style: 'font-size:.86rem;margin:0' }, 'This removes your email, listings, cart and delivery addresses straight away. Order records we must keep for accounting stay in anonymised form. It cannot be undone, and you need to have no open orders.'),
    h('label', { for: 'del-input' }, hasPw ? 'Confirm your password' : 'Type DELETE to confirm'), hasPw ? pwField(delIn) : delIn,
    h('div', { class: 'acts-r' }, h('button', { class: 'btn danger', type: 'submit' }, 'Delete my account')));
  /* Settings: one card with two buttons; each opens its form underneath and closes the other. */
  pwForm.hidden = true; delForm.hidden = true;
  const panels = [['Change password', hasPw ? 'Pick a new password. Other devices are signed out.' : 'Add a password so you can also sign in with your email.', pwForm, 'pw-open'],
                  ['Delete account', 'Remove your email, listings and cart for good.', delForm, 'del-open']];
  const toggle = (form, btn) => { const open = form.hidden; panels.forEach(x => { x[2].hidden = true; x[4] && x[4].setAttribute('aria-expanded', 'false'); }); form.hidden = !open; btn.setAttribute('aria-expanded', String(open)); if (open) form.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); };
  const settings = h('section', { class: 'card' }, h('h2', {}, 'Settings'), h('div', { class: 'set-list' },
    ...panels.map(x => { const b = h('button', { class: x[3] === 'del-open' ? 'btn danger sm' : 'btn ghost sm', type: 'button', id: x[3], 'aria-expanded': 'false', on: { click: () => toggle(x[2], b) } }, x[0]); x[4] = b;
      return h('div', { class: 'set-row' }, h('div', {}, h('b', {}, x[0]), h('p', { class: 'mut' }, x[1])), b); })));
  body.replaceChildren(
    h('div', { class: 'pf-grid' }, form, h('div', {}, prevBox,
      h('section', { class: 'card' }, h('h2', {}, 'Recent reviews'), ...(s.reviews.length ? s.reviews.map(v => h('div', { class: 'rev' }, h('div', { class: 'line', style: 'padding:0' }, h('b', {}, '★'.repeat(v.rating)), h('span', { class: 'mut', style: 'font-size:.8rem' }, 'Verified purchase · ' + v.buyer_username + ' · ' + when(v.created_at).toLocaleDateString())), v.review_text ? h('p', {}, v.review_text) : null)) : [h('p', { class: 'mut' }, 'No reviews yet. Reviews appear after buyers complete an order.')]))),
    ), settings, pwForm, delForm);
}

/* ---------- payment return + deep links from emails ---------- */
/* Stripe tells our server about the payment by webhook, which can lag behind the redirect (or fail).
   So we ask the server to check with Stripe directly right away, and keep checking for ~20 seconds. */
async function awaitPayment(id) {
  for (let i = 0; i < 9; i++) {
    if (i % 2 === 0) await api(`/api/orders/${encodeURIComponent(id)}/verify-payment`, { method: 'POST', body: {} });
    const r = await api('/api/orders');
    const o = r.success && r.orders.find(x => String(x.id) === String(id));
    if (o && o.payment_status === 'paid') { toast(`Payment confirmed for order #${id}. Thank you!`, 'ok'); await loadCart(); if (S.view === 'orders') loadOrders(); return; }
    if (o && (o.status === 'cancelled' || o.payment_status === 'refunded')) { if (S.view === 'orders') loadOrders(); return; }
    await sleep(2500);
  }
  toast('Still confirming your payment. Use "Check payment status" on the order in a minute.');
  if (S.view === 'orders') loadOrders();
}
function handleUrl() {
  const p = new URLSearchParams(location.search), pay = p.get('payment'), id = p.get('order_id');
  /* Links in BlueMart emails: /?view=orders  and  /?view=sell&tab=orders */
  const tab = p.get('tab'), v = p.get('view');
  if (SELL_TABS.includes(tab)) S.sellTab = tab;
  if (VIEWS.includes(v)) view(v);
  if (pay === 'success') {
    view('orders');
    if (S.user) { toast(`Payment received${id ? ' for order #' + id : ''}. Confirming it now…`, 'ok'); if (id) awaitPayment(id); loadCart(); }
    else toast('Payment received. Sign in to see your order.', 'ok');
  } else if (pay === 'cancelled') {
    toast('Checkout was cancelled. Your cart is saved.');
    // Give the reserved stock back right away so the buyer can try again.
    if (S.user && id) api(`/api/orders/${encodeURIComponent(id)}/cancel-checkout`, { method: 'POST', body: {} }).then(() => { loadCart(); refreshProducts(); });
  }
  if (pay || v || tab) history.replaceState({}, '', location.pathname);
}

/* ---------- notification bell ---------- */
function timeAgo(iso) {
  const sec = Math.max(0, (Date.now() - when(iso).getTime()) / 1000);
  if (sec < 60) return 'Just now';
  if (sec < 3600) return Math.floor(sec / 60) + ' min ago';
  if (sec < 86400) return Math.floor(sec / 3600) + ' h ago';
  if (sec < 7 * 86400) return Math.floor(sec / 86400) + ' d ago';
  return when(iso).toLocaleDateString([], { dateStyle: 'medium' });
}
const bellOpen = () => !$('#bell-panel').hidden;
function closeBell() { $('#bell-panel').hidden = true; $('#btn-bell').setAttribute('aria-expanded', 'false'); }
function goNote(n) {
  closeBell();
  if (n.view === 'orders') return view('orders');
  if (String(n.view).startsWith('sell-')) { const t = n.view.slice(5); S.sellTab = SELL_TABS.includes(t) ? t : 'orders'; if (S.sellTab === 'orders') S.sellFilter = 'ship'; return view('sell'); }
}
async function loadBell() {
  const list = $('#bell-list');
  const r = await api('/api/notifications/feed');
  if (!r.success) return list.replaceChildren(h('p', { class: 'mut bell-empty' }, r.message || 'Could not load notifications.'));
  S.notes.feed_unread = r.unread; renderBadges();
  const KIND = { order: 'Order', message: 'Message', shipment: 'Shipping', payout: 'Payout', dispute: 'Dispute' };
  list.replaceChildren(...(r.items.length ? r.items.map(n => h('button', { type: 'button', class: 'bell-item' + (n.read ? '' : ' unread'), on: { click: async () => {
      if (!n.read) { await api('/api/notifications/read', { method: 'POST', body: { id: n.id } }); pollNotes(); }
      goNote(n); } } },
    h('span', { class: 'bell-top' }, h('span', { class: 'pill sm k-' + n.kind }, KIND[n.kind] || 'Update'), h('time', { class: 'mut', datetime: n.created_at }, timeAgo(n.created_at))),
    h('b', {}, n.title), n.body ? h('span', { class: 'mut' }, n.body) : null)) : [h('p', { class: 'mut bell-empty' }, 'You are all caught up. New orders, messages, shipments, payouts and disputes appear here.')]));
  $('#bell-all').disabled = !r.unread;
}
async function toggleBell() {
  if (bellOpen()) return closeBell();
  $('#bell-panel').hidden = false; $('#btn-bell').setAttribute('aria-expanded', 'true');
  $('#bell-list').replaceChildren(h('div', { class: 'sk' }));
  await loadBell();
}
function wireBell() {
  $('#btn-bell').onclick = e => { e.stopPropagation(); toggleBell(); };
  $('#bell-all').onclick = async () => { await api('/api/notifications/read', { method: 'POST', body: {} }); S.notes.feed_unread = 0; renderBadges(); loadBell(); };
  document.addEventListener('click', e => { if (bellOpen() && !e.target.closest('#bellwrap')) closeBell(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && bellOpen()) { closeBell(); $('#btn-bell').focus(); } });
}

/* ---------- wiring ---------- */
function wire() {
  /* Show/Hide buttons on the sign-in password and on the reset-password boxes. */
  wrapPw('#a-pass'); wrapPw('#rp-pass'); wrapPw('#rp-pass2');

  $('.nav').addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if (b) view(b.dataset.v); });
  wireBell();
  $('#btn-add-product').onclick = () => openProductModal(null);
  $('#dlg-prod').addEventListener('close', () => { S.edit = null; S.photos = []; });
  $('#btn-cart').onclick = openCart; $('#cart-close').onclick = closeCart; $('#veil').onclick = closeCart;
  $('#btn-acct').onclick = () => S.user ? openAccount() : openAuth('login');
  $('#acct-out').onclick = () => { $('#dlg-acct').close(); logout(); };
  $('#acct-profile').onclick = () => { $('#dlg-acct').close(); S.sellTab = 'profile'; view('sell'); };
  $('#cookie-ok').onclick = () => { try { localStorage.setItem('bm_cookie_ok', '1'); } catch { /* storage blocked */ } $('#cookie').hidden = true; };
  $('#btn-checkout').onclick = openShipping;
  $('#f-ship').addEventListener('submit', submitShipping);
  $('#btn-clear').onclick = async () => { if (!await ask('Clear your cart?', 'All items will be removed.', 'Clear cart', true)) return; const r = await api('/api/cart/clear', { method: 'DELETE' }); toast(r.message, r.success ? 'ok' : 'bad'); loadCart(); };
  $('#hero-browse').onclick = () => { $('#shop-ctl').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('#q').focus({ preventScroll: true }); };
  $('#hero-sell').onclick = () => view('sell');
  $('#q').addEventListener('input', debounce(e => { S.q = e.target.value.trim(); filtersChanged(); }, 350));
  $('#sort').onchange = e => { S.sort = e.target.value; filtersChanged(); };
  $('#cats').addEventListener('click', e => { const b = e.target.closest('button[data-cat]'); if (!b) return; S.cat = b.dataset.cat; renderCats(); filtersChanged(); });
  $('#grid').addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (!b) return; b.dataset.act === 'open' ? showProduct(b.dataset.id) : addToCart(b.dataset.id); });
  $('#f-min').addEventListener('input', debounce(e => { S.minP = e.target.value.trim(); filtersChanged(); }, 400));
  $('#f-max').addEventListener('input', debounce(e => { S.maxP = e.target.value.trim(); filtersChanged(); }, 400));
  $('#f-stock').addEventListener('change', e => { S.stock = e.target.checked; filtersChanged(); });
  $('#pager').addEventListener('click', e => { const b = e.target.closest('button[data-page]'); if (!b || b.disabled) return; S.page = +b.dataset.page; refreshProducts(); $('#shop-ctl').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  $('#f-report').addEventListener('submit', submitReport);
  $('#admin-tabs').addEventListener('click', e => { const b = e.target.closest('button[data-t]'); if (b) { if (S.adminTab !== b.dataset.t) S.adminQ = ''; S.adminTab = b.dataset.t; loadAdmin(); } });
  /* Back / Forward between the shop and /product/<id> pages */
  window.addEventListener('popstate', e => {
    const id = productIdFromPath();
    if (id != null) return showProduct(id, false);
    const v = e.state && e.state.v;
    view([...VIEWS, 'admin'].includes(v) ? v : 'shop', { push: false });
  });
  $('#orders-refresh').onclick = () => { loadOrders(); pollNotes(); };
  $('#sell-tabs').addEventListener('click', e => { const b = e.target.closest('button[data-t]'); if (b) { S.sellTab = b.dataset.t; loadSell(); } });
  $$('.auth-t button').forEach(b => b.onclick = () => setAuthTab(b.dataset.a));
  $('#f-auth').addEventListener('submit', submitAuth);
  /* typing again dismisses the previous error */
  $('#f-auth').addEventListener('input', () => { if (!$('#a-msg').hidden) authMsg(''); });
  $('#a-resend-l').onclick = async e => { e.preventDefault(); const r = await api('/api/resend-verification', { method: 'POST', body: { username: S.lastUser } }); authMsg(r.message, r.success); };

  /* forgot password */
  $('#a-forgot-l').onclick = e => { e.preventDefault(); openReset(); };
  $('#f-reset').addEventListener('submit', submitReset);
  $('#f-reset').addEventListener('input', () => { if (!$('#rp-msg').hidden) rpMsg(''); });
  $('#rp-back').onclick = e => { e.preventDefault(); $('#dlg-reset').close(); openAuth('login'); };
  $('#rp-resend-l').onclick = async e => {
    e.preventDefault(); if (!RP.id) return;
    const r = await api('/api/forgot-password', { method: 'POST', body: { identifier: RP.id } });
    rpMsg(r.message, r.success);
  };

  $$('[data-close]').forEach(b => b.onclick = () => b.closest('dialog').close());
  $$('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));
  $('#f-dispute').addEventListener('submit', async e => {
    e.preventDefault(); const t = $('#d-text').value.trim(); if (t.length < 5) return toast('Please describe the problem (at least 5 characters).', 'bad');
    const r = await api(`/api/orders/${disputeId}/dispute`, { method: 'POST', body: { reason: `${$('#d-type').value}: ${t}`.slice(0, 1000) } });
    toast(r.message, r.success ? 'ok' : 'bad'); if (r.success) { $('#dlg-dispute').close(); loadOrders(); } });
  $('#f-review').addEventListener('submit', async e => {
    e.preventDefault(); const r = await api(`/api/orders/${reviewCtx.id}/review`, { method: 'POST', body: { seller_username: reviewCtx.seller, rating: +$('#r-stars').value, review_text: $('#r-text').value.trim() } });
    toast(r.message, r.success ? 'ok' : 'bad'); if (r.success) { $('#dlg-review').close(); loadOrders(); } });
  /* messaging */
  $('#f-chat').addEventListener('submit', sendChat);
  $('#c-text').addEventListener('input', e => { $('#c-count').textContent = e.target.value.length + '/1000'; });
  $('#c-text').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#f-chat').requestSubmit(); } });
  $('#dlg-chat').addEventListener('close', () => { clearInterval(chat.timer); chat.id = null; pollNotes(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCart(); });
  /* check for new messages / orders to ship when the person comes back to the tab */
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollNotes(); });
  /* coming back from Stripe with the browser's Back button: start from a clean page */
  window.addEventListener('pageshow', e => { if (e.persisted) location.reload(); });
}

/* ---------- theme (light / dark) ---------- */
const THEME_KEY = 'bm_theme';
let themeWired = false;
function currentTheme() { return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'; }
function applyTheme(theme, save) {
  document.documentElement.setAttribute('data-theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f1f5f9' : '#070d1f');
  const btn = $('#btn-theme');
  if (btn) btn.setAttribute('aria-label', theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
  if (save) {
    const root = document.documentElement; root.classList.add('theme-anim'); setTimeout(() => root.classList.remove('theme-anim'), 350);
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* storage unavailable: theme applies for this visit only */ } }
}
function initTheme() {
  let theme = 'dark';
  try { const saved = localStorage.getItem(THEME_KEY); if (saved === 'light' || saved === 'dark') theme = saved; } catch { /* storage unavailable */ }
  applyTheme(theme, false);
  if (themeWired) return;
  themeWired = true;
  $('#btn-theme').addEventListener('click', () => applyTheme(currentTheme() === 'light' ? 'dark' : 'light', true));
  window.addEventListener('storage', e => { if (e.key === THEME_KEY && (e.newValue === 'light' || e.newValue === 'dark')) applyTheme(e.newValue, false); });
}

async function init() {
  initTheme();
  wire(); renderCats(); renderNews(); cookieNotice();
  $('#grid').replaceChildren(...Array.from({ length: 8 }, () => h('div', { class: 'sk' })));
  const s = await api('/api/session');
  S.cfg = s.config || {};
  if (S.cfg.currency_symbol) SYM = S.cfg.currency_symbol;
  if (s.logged_in) { setUser(s.username, s.csrf_token, s.is_admin); startPolling(); }
  await Promise.all([refreshProducts(), s.logged_in ? Promise.all([loadCart(), loadNews()]) : null]);
  handleUrl();
  const direct = productIdFromPath();
  if (direct != null) showProduct(direct, false);   // a shared /product/<id> link
}
init();

/* ---------- admin: disputes, listing reports, sellers (the server checks admin rights on every call) ---------- */
async function loadAdminCounts() {
  if (!S.admin) return;
  const r = await api('/api/admin/overview');
  if (!r.success) return;
  const c = r.counts || {}, set = (sel, v) => $$(sel).forEach(e => { e.textContent = v; e.hidden = !v; });
  set('.bn-adm-disputes', c.open_disputes || 0); set('.bn-adm-reports', c.open_reports || 0);
  set('.bn-admin', (c.open_disputes || 0) + (c.open_reports || 0));
}
function loadAdmin() {
  if (!S.admin) return;
  $$('#admin-tabs button').forEach(b => { const on = b.dataset.t === S.adminTab; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  const body = $('#admin-body');
  loadAdminCounts();
  if (S.adminTab === 'reports') return adminReports(body);
  if (S.adminTab === 'sellers') return adminSellers(body);
  if (S.adminTab === 'users') return adminUsers(body);
  if (S.adminTab === 'products') return adminProducts(body);
  return adminDisputes(body);
}
const filterSelect = (label, value, options, onChange) =>
  h('div', { class: 'row', style: 'margin:10px 0' }, h('span', { class: 'mut' }, label),
    h('select', { 'aria-label': label, on: { change: e => onChange(e.target.value) } }, ...options.map(([v, t]) => h('option', { value: v, selected: v === value }, t))));

async function adminDisputes(body) {
  body.replaceChildren(h('div', { class: 'sk' }));
  const r = await api('/api/admin/disputes?status=' + encodeURIComponent(S.adminDisp));
  if (!r.success) return body.replaceChildren(empty('Could not load disputes', r.message));
  const cards = r.disputes.map(d => {
    const note = h('textarea', { maxlength: 1000, 'aria-label': `Note for dispute ${d.id} (optional, sent to the buyer and seller)`, placeholder: 'Note to the buyer and seller (optional)' });
    const resolve = (resolution, label, text, danger) => h('button', { class: 'btn sm' + (danger ? ' danger' : ''), type: 'button', on: { click: async () => {
      if (!await ask(label + '?', text, label, danger)) return;
      const res = await api(`/api/admin/disputes/${d.id}/resolve`, { method: 'POST', body: { resolution, note: note.value.trim() } });
      toast(res.message, res.success ? 'ok' : 'bad'); if (res.success) loadAdmin(); } } }, label);
    const multi = d.sellers.length > 1;
    return h('section', { class: 'card' },
      h('div', { class: 'top-row' }, h('div', {}, h('b', {}, `Dispute #${d.id} · Order #${d.order_id}`), h('div', { class: 'mut', style: 'font-size:.8rem' }, stamp(d.created_at))), h('span', { class: 'pill ' + (d.status === 'open' ? 'warn' : 'ok') }, d.status)),
      h('div', { class: 'box' }, h('span', { class: 'mut' }, 'Buyer: ', h('b', { style: 'color:var(--tx)' }, d.buyer)), h('span', { class: 'mut' }, 'Seller(s): ', h('b', { style: 'color:var(--tx)' }, d.sellers.join(', ') || '—')), h('span', { class: 'mut' }, 'Order total: ', h('b', { style: 'color:var(--tx)' }, money(d.total_amount)), ' · order is ' + d.order_status)),
      h('p', {}, d.reason),
      d.status === 'open' ? h('div', {}, note, h('div', { class: 'row', style: 'margin-top:10px' },
        resolve('refund_buyer', 'Refund buyer', `Refunds the whole order (${money(d.total_amount)}) to the buyer through Stripe and cancels the held payouts.` + (multi ? ' This order has several sellers: all of them lose their payout.' : ''), true),
        resolve('release_seller', 'Release to seller', 'Treats the order as received and releases the held payout(s) to the seller(s).', false)))
        : h('div', { class: 'note' }, h('b', {}, d.resolution === 'refund_buyer' ? 'Refunded to buyer. ' : 'Released to seller. '), d.resolution_note || '', d.resolved_at ? h('span', { class: 'mut' }, ' · ' + stamp(d.resolved_at)) : null));
  });
  body.replaceChildren(filterSelect('Show', S.adminDisp, [['open', 'Open'], ['resolved', 'Resolved'], ['all', 'All']], v => { S.adminDisp = v; loadAdmin(); }),
    ...(cards.length ? cards : [empty('No disputes here', S.adminDisp === 'open' ? 'Nothing is waiting for review.' : 'Nothing matches this filter.')]));
}

async function adminReports(body) {
  body.replaceChildren(h('div', { class: 'sk' }));
  const r = await api('/api/admin/reports?status=' + encodeURIComponent(S.adminRep));
  if (!r.success) return body.replaceChildren(empty('Could not load reports', r.message));
  const act = async (url, payload) => { const res = await api(url, { method: 'POST', body: payload }); toast(res.message, res.success ? 'ok' : 'bad'); if (res.success) loadAdmin(); };
  const cards = r.reports.map(x => h('section', { class: 'card' },
    h('div', { class: 'top-row' }, h('div', {}, h('b', {}, x.product_name), h('div', { class: 'mut', style: 'font-size:.8rem' }, `Seller ${x.seller} · reported by ${x.reporter} · ${stamp(x.created_at)}`)),
      h('span', { class: 'pill ' + (x.status === 'open' ? 'warn' : 'ok') }, x.product_hidden ? x.status + ' · hidden' : x.status)),
    h('p', {}, x.reason),
    h('div', { class: 'row' },
      x.product_id ? h('button', { class: 'btn ghost sm', type: 'button', on: { click: () => showProduct(x.product_id) } }, 'View listing') : null,
      x.status === 'open' ? h('button', { class: 'btn ghost sm', type: 'button', on: { click: () => act(`/api/admin/reports/${x.id}/resolve`, { action: 'dismiss' }) } }, 'Dismiss') : null,
      x.status === 'open' && x.product_id && !x.product_hidden ? h('button', { class: 'btn danger sm', type: 'button', on: { click: async () => {
        if (!await ask('Hide this listing?', `"${x.product_name}" disappears from the marketplace and the seller is told. You can show it again later.`, 'Hide listing', true)) return;
        act(`/api/admin/reports/${x.id}/resolve`, { action: 'hide_listing' }); } } }, 'Hide listing') : null,
      x.product_id && x.product_hidden ? h('button', { class: 'btn sm', type: 'button', on: { click: () => act(`/api/admin/products/${x.product_id}/visibility`, { hidden: false }) } }, 'Show listing again') : null)));
  body.replaceChildren(filterSelect('Show', S.adminRep, [['open', 'Open'], ['all', 'All']], v => { S.adminRep = v; loadAdmin(); }),
    ...(cards.length ? cards : [empty('No reports here', 'No one has reported a listing.')]));
}

async function adminSellers(body) {
  const search = h('input', { type: 'search', value: S.adminQ, placeholder: 'Search sellers…', 'aria-label': 'Search sellers', autocomplete: 'off' });
  const list = h('div', {}, h('div', { class: 'sk' }));
  const draw = async () => {
    const r = await api('/api/admin/sellers?q=' + encodeURIComponent(S.adminQ));
    if (!r.success) return list.replaceChildren(empty('Could not load sellers', r.message));
    list.replaceChildren(...(r.sellers.length ? r.sellers.map(s => h('section', { class: 'card' },
      h('div', { class: 'top-row' }, h('div', {}, h('b', {}, s.username), h('div', { class: 'mut', style: 'font-size:.8rem' }, `${ratingText(s.rating_average, s.rating_count)} · ${s.product_count} listing${s.product_count === 1 ? '' : 's'} · ${s.completed_orders} completed order${s.completed_orders === 1 ? '' : 's'}`)),
        h('div', { class: 'row' }, s.verified ? verifiedBadge() : null,
          h('button', { class: 'btn ghost sm', type: 'button', on: { click: () => openSeller(s.username) } }, 'Profile'),
          banBtn(s.username, s.banned, draw),
          h('button', { class: 'btn sm' + (s.verified ? ' ghost' : ''), type: 'button', on: { click: async () => {
            const res = await api(`/api/admin/sellers/${encodeURIComponent(s.username)}/verify`, { method: 'POST', body: { verified: !s.verified } });
            toast(res.message, res.success ? 'ok' : 'bad'); if (res.success) draw(); } } }, s.verified ? 'Remove badge' : 'Verify seller'))))) : [empty('No sellers found', 'Try another name.')]));
  };
  search.addEventListener('input', debounce(e => { S.adminQ = e.target.value.trim(); draw(); }, 350));
  body.replaceChildren(h('div', { style: 'margin:10px 0' }, search), list);
  draw();
}

/* Ban (with a reason) or restore an account. Calls back with true when something changed. */
async function banToggle(username, banned, done) {
  if (banned) {
    const res = await api(`/api/admin/users/${encodeURIComponent(username)}/restore`, { method: 'POST' });
    toast(res.message, res.success ? 'ok' : 'bad'); if (res.success) done(); return;
  }
  const reason = await askReason(`Ban ${username}?`, 'They are signed out at once and cannot sign in. All their listings are hidden. Give a short reason (the user is told).', 'Ban account');
  if (reason === null) return;
  if (reason.length < 3) return toast('Please give a reason (at least 3 characters).', 'bad');
  const res = await api(`/api/admin/users/${encodeURIComponent(username)}/ban`, { method: 'POST', body: { reason } });
  toast(res.message, res.success ? 'ok' : 'bad'); if (res.success) done();
}
const banBtn = (username, banned, done) => h('button', { class: 'btn sm' + (banned ? '' : ' danger'), type: 'button', on: { click: () => banToggle(username, banned, done) } }, banned ? 'Restore account' : 'Ban account');

async function adminUsers(body) {
  const search = h('input', { type: 'search', value: S.adminQ, placeholder: 'Search by username or email…', 'aria-label': 'Search accounts', autocomplete: 'off' });
  const list = h('div', {}, h('div', { class: 'sk' }));
  const draw = async () => {
    const r = await api(`/api/admin/users?status=${S.adminUserStatus || 'all'}&q=` + encodeURIComponent(S.adminQ));
    if (!r.success) return list.replaceChildren(empty('Could not load accounts', r.message));
    list.replaceChildren(...(r.users.length ? r.users.map(u => h('section', { class: 'card' },
      h('div', { class: 'top-row' }, h('div', {}, h('b', {}, u.username), u.is_admin ? h('span', { class: 'pill sm' }, 'Admin') : null, u.banned ? h('span', { class: 'pill bad sm' }, 'Banned') : null,
        h('div', { class: 'mut', style: 'font-size:.8rem' }, `${u.email || 'no email'} · joined ${u.created_at ? when(u.created_at).toLocaleDateString() : '—'} · ${u.product_count} listing${u.product_count === 1 ? '' : 's'}`)),
        h('div', { class: 'row' }, h('button', { class: 'btn ghost sm', type: 'button', on: { click: () => openSeller(u.username) } }, 'Profile'), u.is_admin ? null : banBtn(u.username, u.banned, draw))),
      u.banned ? h('div', { class: 'note' }, h('b', {}, 'Reason: '), u.ban_reason) : null)) : [empty('No accounts found', 'Try another name or email.')]));
  };
  search.addEventListener('input', debounce(e => { S.adminQ = e.target.value.trim(); draw(); }, 350));
  body.replaceChildren(h('div', { style: 'margin:10px 0' }, search),
    filterSelect('Show', S.adminUserStatus || 'all', [['all', 'All accounts'], ['banned', 'Banned only']], v => { S.adminUserStatus = v; draw(); }), list);
  draw();
}

async function adminProducts(body) {
  const search = h('input', { type: 'search', value: S.adminQ, placeholder: 'Search by listing or seller…', 'aria-label': 'Search listings', autocomplete: 'off' });
  const list = h('div', {}, h('div', { class: 'sk' }));
  const draw = async () => {
    const r = await api(`/api/admin/products?status=${S.adminProdStatus || 'all'}&q=` + encodeURIComponent(S.adminQ));
    if (!r.success) return list.replaceChildren(empty('Could not load listings', r.message));
    list.replaceChildren(...(r.products.length ? r.products.map(p => h('section', { class: 'card' },
      h('div', { class: 'top-row' }, h('div', {}, h('b', {}, p.name), p.hidden ? h('span', { class: 'pill bad sm' }, p.hidden_by_ban ? 'Hidden · seller banned' : 'Hidden') : null, p.open_reports ? h('span', { class: 'pill warn sm' }, p.open_reports + ' report' + (p.open_reports === 1 ? '' : 's')) : null,
        h('div', { class: 'mut', style: 'font-size:.8rem' }, `Seller ${p.seller} · ${money(p.price)} · ${p.quantity} in stock`)),
        h('div', { class: 'row' }, h('button', { class: 'btn ghost sm', type: 'button', on: { click: () => showProduct(p.id) } }, 'View'),
          p.hidden && p.hidden_by_ban ? null : h('button', { class: 'btn sm' + (p.hidden ? '' : ' danger'), type: 'button', on: { click: async () => {
            if (!p.hidden && !await ask('Hide this listing?', `"${p.name}" disappears from the marketplace and the seller is told.`, 'Hide listing', true)) return;
            const res = await api(`/api/admin/products/${p.id}/visibility`, { method: 'POST', body: { hidden: !p.hidden } });
            toast(res.message, res.success ? 'ok' : 'bad'); if (res.success) draw(); } } }, p.hidden ? 'Show again' : 'Hide listing'))))) : [empty('No listings found', 'Try another search.')]));
  };
  search.addEventListener('input', debounce(e => { S.adminQ = e.target.value.trim(); draw(); }, 350));
  body.replaceChildren(h('div', { style: 'margin:10px 0' }, search),
    filterSelect('Show', S.adminProdStatus || 'all', [['all', 'All listings'], ['hidden', 'Hidden only']], v => { S.adminProdStatus = v; draw(); }), list);
  draw();
}
