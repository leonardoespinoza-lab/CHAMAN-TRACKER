// Autenticación del lado del cliente: el login y la sesión los valida el servidor
// (cookie httpOnly). localStorage se usa sólo como caché para pintar la UI rápido.
const SESSION_KEY = 'fumigacion_session';
const LOGIN_PAGE = 'login.html';

function cacheSession(user) {
  const session = {
    id: user.id,
    username: user.username,
    role: user.role,
    name: user.name,
    loginAt: new Date().toISOString()
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

function clearSessionCache() {
  localStorage.removeItem(SESSION_KEY);
}

const NEXT_KEY = 'chaman.next';
function goToLogin() {
  clearSessionCache();
  if (!/login\.html$/.test(window.location.pathname)) {
    // Al volver a entrar se regresa a esta misma página (p. ej. el detalle de un trabajo)
    try { sessionStorage.setItem(NEXT_KEY, location.pathname.replace(/^\//, '') + location.search + location.hash); } catch (_) {}
    window.location.href = LOGIN_PAGE;
  }
}
// Página a la que volver después del login (sólo páginas propias .html)
function takeNextPage() {
  let next = null;
  try { next = sessionStorage.getItem(NEXT_KEY); sessionStorage.removeItem(NEXT_KEY); } catch (_) {}
  return next && /^[\w-]+\.html([?#].*)?$/.test(next) && !/^login\.html/.test(next) ? next : null;
}

// ===== Sesión: cierre por inactividad, aviso previo y varias pestañas =====
// El servidor decide (última actividad real + vencimiento absoluto) y en cada respuesta de la API manda el
// tiempo restante (X-Session-*). Acá: se marcan los pedidos hechos con la persona usando la app, se avisa
// 2 min antes ("Seguir conectado" / "Cerrar sesión"), y las pestañas se sincronizan (localStorage +
// BroadcastChannel): la actividad en una mantiene vivas las otras y salir en una cierra todas.
const SessionUI = (function () {
  const STATE_KEY = 'chaman.sessionState', ACT_KEY = 'chaman.lastInteraction', REASON_KEY = 'chaman.logoutReason', MSG_KEY = 'chaman.sessionMsg';
  const ACTIVE_WINDOW_MS = 60000;
  const tabId = Math.random().toString(36).slice(2);
  let lastInteraction = Date.now();            // abrir o recargar la página cuenta como uso
  let st = null, started = false, timer = null, modal = null, modalKind = null, absDismissed = false, checking = false, expiredOnce = false;
  let lastPing = 0, confirmedAt = 0; // confirmedAt: última respuesta del servidor (sin conexión no se avisa nada)
  const bc = typeof BroadcastChannel === 'function' ? new BroadcastChannel('chaman-session') : null;
  const ls = { get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }, del(k) { try { localStorage.removeItem(k); } catch (_) {} } };
  try { st = JSON.parse(ls.get(STATE_KEY) || 'null'); } catch (_) { st = null; }

  function fmtDur(ms) {
    const m = Math.round(ms / 60000);
    if (m < 60) return m + ' min';
    const h = m / 60;
    if (h < 48) return (Number.isInteger(h) ? h : h.toFixed(1).replace('.', ',')) + ' h';
    return Math.round(h / 24) + ' días';
  }
  function fmtClock(ms) { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  function broadcast(msg) {
    msg = Object.assign({ from: tabId, at: Date.now() }, msg);
    if (bc) { try { bc.postMessage(msg); } catch (_) {} }
    ls.set(MSG_KEY, JSON.stringify(msg)); // respaldo para navegadores sin BroadcastChannel
  }
  function save(next, quiet) {
    st = next; ls.set(STATE_KEY, JSON.stringify(st));
    if (!quiet) tick();
  }
  function fromInfo(i) {
    if (!i) return;
    const now = Date.now();
    confirmedAt = now;
    save({ idleDeadline: now + i.idleLeftMs, absDeadline: now + i.absLeftMs, warn: i.warnMs, idleMs: i.idleMs, maxMs: i.maxMs || (st && st.maxMs) || 0, exempt: !!i.exempt, at: now });
  }
  function fromHeaders(h) {
    const idle = h.get('X-Session-Idle-Left');
    if (idle == null) return;
    fromInfo({ idleLeftMs: Number(idle), absLeftMs: Number(h.get('X-Session-Abs-Left')), warnMs: Number(h.get('X-Session-Warn')),
      idleMs: Number(h.get('X-Session-Idle')) || (st && st.idleMs) || 0, exempt: h.get('X-Session-Exempt') === '1' });
  }
  function recentlyActive() {
    const shared = Number(ls.get(ACT_KEY)) || 0;
    return Date.now() - Math.max(lastInteraction, shared) < ACTIVE_WINDOW_MS;
  }
  function setReason(r) { ls.set(REASON_KEY, JSON.stringify({ reason: r, at: Date.now() })); }
  function clearReason() { ls.del(REASON_KEY); }
  function takeReason() {
    let r = null; try { r = JSON.parse(ls.get(REASON_KEY) || 'null'); } catch (_) {}
    ls.del(REASON_KEY);
    return r && Date.now() - r.at < 30 * 60000 ? r.reason : null;
  }
  function noteExpired(reason) { if (reason) setReason(reason); else if (!ls.get(REASON_KEY)) setReason('closed'); }

  // Toques / teclas: cuentan como uso. Si hace rato que el servidor no registra actividad, se le avisa.
  function onInteract() {
    if (modal) return; // con el aviso abierto sólo "Seguir conectado" extiende la sesión
    const now = Date.now();
    if (now - lastInteraction > 2000) { lastInteraction = now; ls.set(ACT_KEY, String(now)); }
    if (!st || !st.idleMs || !started) return;
    const every = Math.min(60000, st.idleMs / 4);
    const serverLast = st.idleDeadline - st.idleMs;
    if (now - serverLast > every && now - lastPing > every) {
      lastPing = now;
      fetch('/api/auth/activity', { method: 'POST', credentials: 'same-origin' }).then(r => r.ok ? r.json() : null).then(d => d && fromInfo(d.session)).catch(() => {});
    }
  }
  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(ev => window.addEventListener(ev, onInteract, { passive: true, capture: true }));

  function hideModal() { if (modal) { modal.remove(); modal = null; modalKind = null; } }
  function showModal(kind) {
    if (modal && modalKind === kind) return;
    hideModal();
    injectDialogStyles();
    modalKind = kind;
    modal = document.createElement('div');
    modal.className = 'ch-overlay ch-sess-overlay';
    modal.setAttribute('role', 'alertdialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-labelledby', 'chSessTitle');
    modal.innerHTML = kind === 'idle' ? `
      <div class="ch-dialog ch-sess" id="chSessDialog">
        <h3 id="chSessTitle">⏳ Tu sesión está por cerrarse</h3>
        <p>No hubo actividad en los últimos ${fmtDur(st.idleMs - st.warn)}. Por seguridad la sesión se cierra en</p>
        <div class="ch-count" id="chSessCount">–</div>
        <p style="font-size:.8rem;color:var(--text-muted)">Si te quedan cambios sin guardar, tocá “Seguir conectado”.</p>
        <div class="ch-actions">
          <button type="button" class="ch-cancel" id="chSessLogout">Cerrar sesión</button>
          <button type="button" class="ch-ok" id="chSessStay">Seguir conectado</button>
        </div>
      </div>` : `
      <div class="ch-dialog ch-sess" id="chSessDialog">
        <h3 id="chSessTitle">🔒 La sesión llega a su duración máxima</h3>
        <p>Por seguridad cada sesión dura como máximo ${fmtDur(st.maxMs || 0)}. Se cierra en</p>
        <div class="ch-count" id="chSessCount">–</div>
        <p style="font-size:.8rem;color:var(--text-muted)">Guardá lo que estés haciendo; después vas a tener que volver a ingresar.</p>
        <div class="ch-actions">
          <button type="button" class="ch-cancel" id="chSessLogout">Cerrar sesión</button>
          <button type="button" class="ch-ok" id="chSessOk">Entendido</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#chSessLogout').onclick = () => logout();
    const stay = modal.querySelector('#chSessStay');
    if (stay) { stay.onclick = keepAlive; stay.focus(); }
    const ok = modal.querySelector('#chSessOk');
    if (ok) ok.onclick = () => { absDismissed = true; hideModal(); };
    tick();
  }
  async function keepAlive() {
    const b = modal && modal.querySelector('#chSessStay'); if (b) b.disabled = true;
    try {
      const r = await fetch('/api/auth/keepalive', { method: 'POST', credentials: 'same-origin' });
      if (r.status === 401) { noteExpired(r.headers.get('X-Session-Expired') || 'idle'); return expired(); }
      const d = await r.json();
      lastInteraction = Date.now(); ls.set(ACT_KEY, String(lastInteraction));
      hideModal(); fromInfo(d.session);
      broadcast({ type: 'extended' });
    } catch (_) { if (b) b.disabled = false; }
  }
  // Pregunta al servidor sin contar como actividad (otra pestaña u otro equipo pudo haberla extendido)
  async function check() {
    if (checking) return; checking = true;
    try {
      const r = await (window.chamanRawFetch || fetch)('/api/auth/session', { credentials: 'same-origin', cache: 'no-store', headers: { 'X-Chaman-Background': '1' } });
      if (r.status === 401) { noteExpired(r.headers.get('X-Session-Expired') || (st && Date.now() >= st.absDeadline ? 'absolute' : 'idle')); expired(); return; }
      if (r.ok) fromInfo((await r.json()).session);
    } catch (_) { /* sin conexión: se reintenta en el próximo ciclo */ }
    finally { checking = false; }
  }
  function expired(fromOtherTab) {
    if (expiredOnce) return; expiredOnce = true;
    hideModal(); clearInterval(timer);
    if (!fromOtherTab) broadcast({ type: 'expired' });
    if (typeof window.chamanOnUnauthorized === 'function') {
      // tracker: pide la contraseña ahí mismo y sigue grabando; el aviso vuelve con la próxima respuesta del servidor
      expiredOnce = false; st = null; timer = setInterval(tick, 1000); window.chamanOnUnauthorized(); return;
    }
    goToLogin();
  }
  let lastCheckAt = 0;
  function tick() {
    if (!started || !st || !st.idleMs) return;
    const now = Date.now();
    if (st.exempt) { hideModal(); return; }
    const idleRem = st.idleDeadline - now, absRem = st.absDeadline - now;
    if (idleRem <= 0 || absRem <= 0) { if (now - lastCheckAt > 3000) { lastCheckAt = now; check(); } return; }
    const kind = idleRem <= st.warn ? 'idle' : (absRem <= st.warn && !absDismissed ? 'abs' : null);
    if (!kind) { if (modal) hideModal(); return; }
    // antes de avisar, confirmar con el servidor (otra pestaña u otro equipo pudo extenderla; sin conexión no se avisa)
    if (!modal && now - confirmedAt > 15000) { if (now - lastCheckAt > 3000) { lastCheckAt = now; check(); } return; }
    showModal(kind);
    const c = modal && modal.querySelector('#chSessCount');
    if (c) c.textContent = fmtClock(kind === 'idle' ? idleRem : absRem);
  }
  function onMessage(m) {
    if (!m || m.from === tabId) return;
    if (m.type === 'logout') { clearSessionCache(); if (!/login\.html$/.test(location.pathname)) { location.href = LOGIN_PAGE; } }
    else if (m.type === 'expired') { if (started) { noteExpired(null); expired(true); } }
    else if (m.type === 'extended') { hideModal(); try { st = JSON.parse(ls.get(STATE_KEY) || 'null'); } catch (_) {} tick(); }
    else if (m.type === 'login') { if (/login\.html$/.test(location.pathname) && typeof requireGuest === 'function') requireGuest(); }
  }
  if (bc) bc.onmessage = (e) => onMessage(e.data);
  window.addEventListener('storage', (e) => {
    if (e.key === STATE_KEY && e.newValue) { try { st = JSON.parse(e.newValue); } catch (_) {} if (modal && st && st.idleDeadline - Date.now() > st.warn) hideModal(); tick(); }
    else if (e.key === MSG_KEY && e.newValue && !bc) { try { onMessage(JSON.parse(e.newValue)); } catch (_) {} }
  });
  function start() {
    if (started) return; started = true;
    timer = setInterval(tick, 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { lastCheckAt = 0; tick(); } });
  }
  return { start, fromHeaders, fromInfo, recentlyActive, broadcast, setReason, clearReason, takeReason, noteExpired, fmtDur,
    state: () => st, check, _tick: tick,
    // sólo para pruebas automáticas: simula que la persona no toca la página desde hace ms
    _idleFor(ms) { lastInteraction = Date.now() - ms; ls.set(ACT_KEY, String(lastInteraction)); } };
})();

// Si cualquier llamada a la API responde 401, la sesión venció: volver al login.
// Una página puede manejarlo sin salir (el tracker pide la contraseña ahí mismo y sigue grabando el GPS):
// window.chamanOnUnauthorized = () => { ... }
let unauthorizedPending = false;
(function installFetch401Handler() {
  const originalFetch = window.fetch.bind(window);
  window.chamanRawFetch = originalFetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const isApi = url.includes('/api/');
    // Lectura hecha con la persona usando la app (tocó/tecleó hace < 1 min o recién abrió la página):
    // el servidor la cuenta como actividad. Los refrescos automáticos sin uso no la llevan.
    if (isApi && SessionUI.recentlyActive()) {
      init = Object.assign({}, init);
      const h = new Headers(init.headers || (input && typeof input !== 'string' ? input.headers : undefined));
      h.set('X-Chaman-Active', '1');
      init.headers = h;
    }
    const res = await originalFetch(input, init);
    if (isApi) SessionUI.fromHeaders(res.headers);
    if (res.status === 401 && isApi && !url.includes('/api/auth/')) {
      SessionUI.noteExpired(res.headers.get('X-Session-Expired'));
      if (typeof window.chamanOnUnauthorized === 'function') {
        if (!unauthorizedPending) { unauthorizedPending = true; Promise.resolve().then(() => { unauthorizedPending = false; window.chamanOnUnauthorized(); }); }
      } else {
        goToLogin();
      }
    }
    return res;
  };
})();

// Al redirigir (sin sesión o sin permiso) se corta el script de la página: así no aparecen errores
// como "Cannot read properties of null (reading 'name')" mientras el navegador cambia de página.
function stopPage() {
  const e = new Error('Redirigiendo…');
  e.chamanRedirect = true;
  throw e;
}
window.addEventListener('error', (e) => { if (e.error && e.error.chamanRedirect) e.preventDefault(); });

async function login(username, password) {
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ username: username.trim().toLowerCase(), password })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.error || 'No se pudo iniciar sesión (error ' + res.status + ')' };
    }
    SessionUI.clearReason();
    SessionUI.broadcast({ type: 'login' });
    return { ok: true, session: cacheSession(data.user) };
  } catch (e) {
    return { ok: false, error: 'No se pudo conectar con el servidor' };
  }
}

// Salir: borra la sesión en el servidor y cierra todas las pestañas abiertas de la app
async function logout(opts = {}) {
  try {
    await fetch(opts.allDevices ? '/api/auth/logout-all' : '/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch (_) { /* igual salimos */ }
  clearSessionCache();
  SessionUI.broadcast({ type: 'logout' });
  SessionUI.setReason(opts.allDevices ? 'all' : 'logout');
  try { sessionStorage.removeItem(NEXT_KEY); } catch (_) {}
  window.location.href = LOGIN_PAGE;
}
function logoutAllDevices() {
  if (!confirm('Se va a cerrar tu sesión en todos los dispositivos (computadoras y celulares), incluido este. ¿Seguir?')) return;
  logout({ allDevices: true });
}

function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Consulta al servidor quién está logueado.
// Devuelve el usuario, null si no hay sesión (401), o lanza error si no hay conexión.
async function fetchMe() {
  const res = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error('Error ' + res.status);
  const data = await res.json();
  if (data.session) SessionUI.fromInfo(data.session);
  return data.user || null;
}

// Verifica la sesión en el servidor y corrige la caché o redirige si hace falta.
// Sólo un 401 cierra la sesión; un error de red o un 5xx (p. ej. durante un redeploy) mantiene la caché.
async function verifySession(allowedRoles = []) {
  try {
    const user = await fetchMe();
    if (!user) {
      if (typeof window.chamanOnUnauthorized === 'function') { window.chamanOnUnauthorized(); return getSession(); }
      goToLogin();
      return null;
    }
    const session = cacheSession(user);
    if (allowedRoles.length && !allowedRoles.includes(user.role)) {
      redirectByRole(user.role);
      return null;
    }
    return session;
  } catch (_) {
    // Sin conexión o servidor caído: se mantiene la sesión en caché
    return getSession();
  }
}

// Devuelve la sesión en caché para pintar la página enseguida y la valida
// contra el servidor en segundo plano (si no es válida, redirige al login).
// Si no hay caché (p. ej. el navegador borró el almacenamiento) pero la cookie sigue vigente,
// se consulta al servidor antes de mandar al login y se recarga la página.
function requireAuth(allowedRoles = []) {
  const session = getSession();
  if (!session) {
    fetchMe().then((user) => {
      if (!user) return goToLogin();
      cacheSession(user);
      if (allowedRoles.length && !allowedRoles.includes(user.role)) redirectByRole(user.role);
      else location.reload();
    }).catch(() => goToLogin());
    stopPage();
  }
  if (allowedRoles.length && !allowedRoles.includes(session.role)) {
    redirectByRole(session.role);
    stopPage();
  }
  verifySession(allowedRoles);
  SessionUI.start();
  return session;
}

function redirectByRole(role) {
  if (role === 'aplicador') {
    window.location.href = 'tracker.html';
  } else if (role === 'admin') {
    window.location.href = 'tablero.html'; // tablero ejecutivo
  } else {
    window.location.href = 'trabajos.html';
  }
}

// Después del login: volver a la página donde se cortó la sesión, o a la inicial del rol
function goAfterLogin(role) {
  const next = takeNextPage();
  if (next) window.location.href = next;
  else redirectByRole(role);
}

// En el login: si ya hay una sesión válida en el servidor, ir directo al panel
async function requireGuest() {
  try {
    const user = await fetchMe();
    if (user) {
      cacheSession(user);
      goAfterLogin(user.role);
    } else {
      clearSessionCache();
    }
  } catch (_) {
    /* sin conexión o sin base: se queda en el login */
  }
}

// ===== Íconos de línea (sprite local icons.svg, Lucide – ISC) =====
function chIcon(name) {
  return `<svg class="i" aria-hidden="true"><use href="icons.svg#i-${name}"/></svg>`;
}

// En el celular el menú se desplaza en horizontal: que la página actual quede a la vista
function revealActiveNav() {
  const nav = document.querySelector('header nav');
  const a = nav && nav.querySelector('.nav-link.active');
  if (!a || nav.scrollWidth <= nav.clientWidth + 1) return;
  const d = a.getBoundingClientRect().left - nav.getBoundingClientRect().left;
  if (d < 12 || d + a.offsetWidth > nav.clientWidth - 28) nav.scrollLeft += d - 12;
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(revealActiveNav));
else requestAnimationFrame(revealActiveNav);

// ===== Diálogo "Cambiar mi contraseña" (disponible en todas las pantallas) =====
function injectDialogStyles() {
  if (document.getElementById('chaman-dialog-styles')) return;
  const style = document.createElement('style');
  style.id = 'chaman-dialog-styles';
  style.textContent = `
    .ch-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0,0.7); display: flex;
      align-items: flex-start; justify-content: center; z-index: 1000;
      padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right))
               max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
      overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
    .ch-dialog { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 24px;
      width: 100%; max-width: 380px; color: var(--text); font-family: 'Segoe UI', system-ui, sans-serif;
      box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); margin: auto; box-sizing: border-box; }
    .ch-dialog h3 { font-size: 1.05rem; color: var(--accent-text); margin: 0 0 16px; }
    .ch-dialog label { display: block; font-size: 0.75rem; font-weight: 600; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: 0.04em; margin: 12px 0 6px; }
    .ch-dialog input { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border-strong);
      background: var(--bg); color: var(--text); font-size: 16px; min-height: 44px; outline: none; box-sizing: border-box; }
    .ch-dialog input:focus { border-color: var(--accent); }
    .ch-msg { margin-top: 12px; font-size: 0.85rem; padding: 8px 12px; border-radius: 8px; display: none; }
    .ch-msg.error { display: block; background: var(--danger-bg); color: var(--danger-text); }
    .ch-msg.ok { display: block; background: var(--success-bg); color: var(--success-text); }
    .ch-actions { display: flex; gap: 10px; margin-top: 18px; }
    .ch-actions button { flex: 1; padding: 10px; min-height: 44px; border-radius: 8px; border: none; font-weight: 700;
      font-size: 0.9rem; cursor: pointer; }
    .ch-actions .ch-cancel { background: transparent; border: 1px solid var(--border-strong); color: var(--text-2); }
    .ch-actions .ch-ok { background: var(--accent); color: var(--on-accent); }
    .ch-actions button:disabled { opacity: 0.5; cursor: wait; }
    .ch-note { font-size: 0.8rem; color: var(--text-muted); margin: 10px 0 0; line-height: 1.4; }
    .ch-sep { border-top: 1px solid var(--border); margin: 16px 0 14px; }
    .ch-wide { width: 100%; min-height: 44px; margin-top: 10px; border-radius: 8px; background: transparent; cursor: pointer;
      border: 1px solid var(--danger, #ef4444); color: var(--danger-text, #fca5a5); font-weight: 700; font-size: 0.88rem; }
    .ch-wide:hover { background: var(--danger-bg, rgba(239,68,68,.12)); }
    .ch-sess .ch-count { font-size: 2rem; font-weight: 800; color: var(--accent-text); text-align: center; margin: 6px 0 4px;
      font-variant-numeric: tabular-nums; }
    .ch-sess p { margin: 0; line-height: 1.45; color: var(--text-2, #d4d4d8); font-size: 0.92rem; }
  `;
  document.head.appendChild(style);
}

function openPasswordDialog() {
  injectDialogStyles();
  const overlay = document.createElement('div');
  overlay.className = 'ch-overlay';
  overlay.innerHTML = `
    <form class="ch-dialog" id="chPwdForm">
      <h3>Cambiar mi contraseña</h3>
      <label for="chPwdCurrent">Contraseña actual</label>
      <input type="password" id="chPwdCurrent" autocomplete="current-password" required />
      <label for="chPwdNew">Contraseña nueva (mínimo 8 caracteres)</label>
      <input type="password" id="chPwdNew" autocomplete="new-password" minlength="8" required />
      <label for="chPwdRepeat">Repetir contraseña nueva</label>
      <input type="password" id="chPwdRepeat" autocomplete="new-password" minlength="8" required />
      <div class="ch-msg" id="chPwdMsg"></div>
      <div class="ch-actions">
        <button type="button" class="ch-cancel" id="chPwdCancel">Cancelar</button>
        <button type="submit" class="ch-ok" id="chPwdOk">Guardar</button>
      </div>
      <p class="ch-note">Al cambiarla se cierran tus sesiones en los otros dispositivos.</p>
      <div class="ch-sep"></div>
      <h3 style="margin-bottom:6px">Sesiones</h3>
      <p class="ch-note" id="chSessNote">La sesión se cierra sola después de un tiempo sin uso.</p>
      <button type="button" class="ch-wide" id="chLogoutAll">Cerrar sesión en todos los dispositivos</button>
    </form>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  const msg = overlay.querySelector('#chPwdMsg');
  overlay.querySelector('#chPwdCancel').addEventListener('click', close);
  overlay.querySelector('#chLogoutAll').addEventListener('click', logoutAllDevices);
  const st = SessionUI.state();
  if (st && st.idleMs) overlay.querySelector('#chSessNote').textContent = st.exempt
    ? 'Mientras tengas un trabajo en curso la sesión no se cierra. Si no, se cierra tras ' + SessionUI.fmtDur(st.idleMs) + ' sin uso.'
    : 'Esta sesión se cierra tras ' + SessionUI.fmtDur(st.idleMs) + ' sin uso y, como máximo, ' + SessionUI.fmtDur(st.maxMs || 0) + ' después de entrar.';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#chPwdCurrent').focus();
  overlay.querySelector('#chPwdForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const current = overlay.querySelector('#chPwdCurrent').value;
    const next = overlay.querySelector('#chPwdNew').value;
    const repeat = overlay.querySelector('#chPwdRepeat').value;
    if (next !== repeat) {
      msg.className = 'ch-msg error';
      msg.textContent = 'Las contraseñas nuevas no coinciden';
      return;
    }
    const btn = overlay.querySelector('#chPwdOk');
    btn.disabled = true;
    try {
      const res = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: next })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'No se pudo cambiar la contraseña');
      msg.className = 'ch-msg ok';
      msg.textContent = 'Contraseña actualizada ✓ Se cerraron tus sesiones en otros dispositivos.';
      setTimeout(close, 1800);
    } catch (err) {
      msg.className = 'ch-msg error';
      msg.textContent = err.message;
      btn.disabled = false;
    }
  });
}

// ===== Alertas operativas: enlace con contador en el encabezado (supervisor/admin) =====
// Se conecta al aviso en vivo (SSE /api/alerts/stream); si no se puede, consulta cada 30 s.
// Dispara los eventos "chaman:alerts-summary" y "chaman:alert" para que cada pantalla se actualice.
const ALERT_TITLES = { velocidad: 'Exceso de velocidad', parada: 'Parada larga', sin_senal: 'Sin señal GPS', ruta_incompleta: 'Tramos de ruta salteados', no_inicio: 'No arrancó a tiempo', clima: 'Pronóstico no apto' };
function injectAlertStyles() {
  if (document.getElementById('chaman-alert-styles')) return;
  const style = document.createElement('style');
  style.id = 'chaman-alert-styles';
  style.textContent = `
    .nav-link .al-count { display: inline-block; min-width: 20px; padding: 1px 6px; margin-left: 4px; border-radius: 999px;
      background: var(--warning); color: var(--on-solid); font-size: 0.72rem; font-weight: 800; text-align: center; line-height: 1.4; }
    .nav-link .al-count.high { background: var(--danger); color: white; animation: chAlPulse 1.6s infinite; }
    .nav-link .al-count[hidden] { display: none; }
    @keyframes chAlPulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(239,68,68,.7); } 50% { box-shadow: 0 0 0 5px rgba(239,68,68,0); } }
    .ch-toasts { position: fixed; right: 12px; bottom: calc(12px + env(safe-area-inset-bottom)); z-index: 900;
      display: flex; flex-direction: column; gap: 8px; max-width: min(380px, calc(100vw - 24px)); }
    .ch-toast { display: flex; align-items: center; gap: 8px; background: var(--surface); color: var(--text); border: 1px solid var(--border-strong);
      border-left: 5px solid var(--warning); border-radius: 10px; padding: 6px 6px 6px 12px; box-shadow: 0 8px 24px rgba(0,0,0,.45);
      font-family: 'Segoe UI', system-ui, sans-serif; font-size: 0.86rem; line-height: 1.35; cursor: pointer; }
    .ch-toast.alta { border-left-color: var(--danger); }
    .ch-toast .tx { flex: 1; }
    .ch-toast b { color: #fff; }
    .ch-toast button { background: none; border: none; color: var(--text-muted); font-size: 1.1rem; min-width: 44px; min-height: 44px; cursor: pointer; border-radius: 8px; }
    .ch-toast button:hover { background: var(--border); color: #fff; }
  `;
  document.head.appendChild(style);
}
function alertToast(alert) {
  injectAlertStyles();
  let box = document.querySelector('.ch-toasts');
  if (!box) { box = document.createElement('div'); box.className = 'ch-toasts'; box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
  while (box.children.length >= 3) box.firstChild.remove();
  const t = document.createElement('div');
  t.className = 'ch-toast ' + (alert.severity || '');
  const info = window.AlertsCore ? AlertsCore.TYPE_INFO[alert.type] : null;
  const lot = alert.job && alert.job.lotName ? alert.job.lotName : 'Trabajo #' + alert.jobId;
  t.innerHTML = `<span class="tx">${info ? info.icon + ' ' : '⚠️ '}<b></b><br><span class="sub"></span></span><button type="button" aria-label="Cerrar aviso">✕</button>`;
  t.querySelector('b').textContent = ALERT_TITLES[alert.type] || 'Alerta';
  t.querySelector('.sub').textContent = lot + (alert.applicator ? ' · ' + alert.applicator.name : '');
  t.addEventListener('click', (e) => {
    if (e.target.closest('button')) { t.remove(); return; }
    location.href = 'trabajos.html?trabajo=' + alert.jobId;
  });
  box.appendChild(t);
  setTimeout(() => t.remove(), 9000);
}
function initAlertsNav(opts = {}) {
  const s = getSession();
  if (!s || !['admin', 'supervisor'].includes(s.role)) return;
  injectAlertStyles();
  // Barra lateral (nav.js) o, en pantallas viejas, el menú del encabezado
  const nav = document.querySelector('.sb-nav') || document.querySelector('header nav');
  if (!nav) return;
  let link = document.getElementById('navAlerts');
  if (!link) {
    link = document.createElement('a');
    link.className = 'nav-link';
    link.id = 'navAlerts';
    link.href = 'alertas.html';
    const first = nav.querySelector('a');
    if (first && first.nextSibling) nav.insertBefore(link, first.nextSibling); else nav.appendChild(link);
    link.innerHTML = chIcon('bell') + '<span>Alertas</span>';
  }
  if (!link.querySelector('.al-count')) link.insertAdjacentHTML('beforeend', '<span class="al-count" hidden></span>');
  // Enlaces de gestión: Tablero (admin, primero) y Gestión (supervisor/admin, después de Alertas); nav.js ya los dibuja
  const page = (location.pathname.split('/').pop() || '').toLowerCase();
  const addLink = (id, href, html, before) => {
    if (document.getElementById(id)) return;
    const a = document.createElement('a');
    a.className = 'nav-link' + (page === href ? ' active' : '');
    if (page === href) a.setAttribute('aria-current', 'page');
    a.id = id; a.href = href; a.innerHTML = html;
    nav.insertBefore(a, before);
  };
  if (s.role === 'admin') addLink('navTablero', 'tablero.html', chIcon('layout-dashboard') + '<span>Tablero</span>', nav.firstChild);
  addLink('navGestion', 'gestion.html', chIcon('package') + '<span>Gestión</span>', link.nextSibling);
  requestAnimationFrame(revealActiveNav);
  const badge = link.querySelector('.al-count');
  const setSummary = (sum) => {
    badge.hidden = !sum.unseen;
    badge.textContent = sum.unseen > 99 ? '99+' : String(sum.unseen);
    badge.classList.toggle('high', sum.openHigh > 0);
    link.title = `${sum.unseen} sin ver · ${sum.open} abiertas`;
    link.setAttribute('aria-label', `Alertas: ${sum.unseen} sin ver, ${sum.open} abiertas`);
    window.dispatchEvent(new CustomEvent('chaman:alerts-summary', { detail: sum }));
  };
  let poll = null;
  const pollOnce = async () => {
    try { const r = await fetch('/api/alerts/summary'); if (r.ok) setSummary(await r.json()); } catch (_) {}
  };
  const startPoll = () => { if (!poll) { poll = setInterval(pollOnce, 30000); pollOnce(); } };
  if (!window.EventSource) return startPoll();
  let es = null;
  const openStream = () => {
    const s = es = new EventSource('/api/alerts/stream');
    s.addEventListener('summary', (e) => setSummary(JSON.parse(e.data)));
    s.addEventListener('alert', (e) => {
      const ev = JSON.parse(e.data);
      window.dispatchEvent(new CustomEvent('chaman:alert', { detail: ev }));
      if (ev.action === 'created' && ev.alert.severity !== 'info' && !opts.noToast) alertToast(ev.alert);
    });
    s.addEventListener('error', () => { if (s.readyState === EventSource.CLOSED && es === s) startPoll(); });
  };
  openStream();
  // Al salir de la página se cierra la conexión (si no, quedan abiertas en la caché atrás/adelante y agotan las 6 por servidor)
  window.addEventListener('pagehide', () => { if (es) { es.close(); es = null; } });
  window.addEventListener('pageshow', (e) => { if (e.persisted && !es && !poll) openStream(); });
}
