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

function goToLogin() {
  clearSessionCache();
  if (!/login\.html$/.test(window.location.pathname)) {
    window.location.href = LOGIN_PAGE;
  }
}

// Si cualquier llamada a la API responde 401, la sesión venció: volver al login
(function installFetch401Handler() {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const res = await originalFetch(input, init);
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (res.status === 401 && url.includes('/api/') && !url.includes('/api/auth/')) {
      goToLogin();
    }
    return res;
  };
})();

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
    return { ok: true, session: cacheSession(data.user) };
  } catch (e) {
    return { ok: false, error: 'No se pudo conectar con el servidor' };
  }
}

async function logout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch (_) { /* igual salimos */ }
  clearSessionCache();
  window.location.href = LOGIN_PAGE;
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
  return data.user || null;
}

// Verifica la sesión en el servidor y corrige la caché o redirige si hace falta
async function verifySession(allowedRoles = []) {
  try {
    const user = await fetchMe();
    if (!user) {
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
function requireAuth(allowedRoles = []) {
  const session = getSession();
  if (!session) {
    window.location.href = LOGIN_PAGE;
    return null;
  }
  if (allowedRoles.length && !allowedRoles.includes(session.role)) {
    redirectByRole(session.role);
    return null;
  }
  verifySession(allowedRoles);
  return session;
}

function redirectByRole(role) {
  if (role === 'aplicador') {
    window.location.href = 'tracker.html';
  } else {
    window.location.href = 'index.html';
  }
}

// En el login: si ya hay una sesión válida en el servidor, ir directo al panel
async function requireGuest() {
  try {
    const user = await fetchMe();
    if (user) {
      cacheSession(user);
      redirectByRole(user.role);
    } else {
      clearSessionCache();
    }
  } catch (_) {
    /* sin conexión o sin base: se queda en el login */
  }
}

// ===== Diálogo "Cambiar mi contraseña" (disponible en todas las pantallas) =====
function injectDialogStyles() {
  if (document.getElementById('chaman-dialog-styles')) return;
  const style = document.createElement('style');
  style.id = 'chaman-dialog-styles';
  style.textContent = `
    .ch-overlay { position: fixed; inset: 0; background: rgba(2,6,23,0.7); display: flex;
      align-items: center; justify-content: center; z-index: 1000; padding: 16px; }
    .ch-dialog { background: #1e293b; border: 1px solid #334155; border-radius: 16px; padding: 24px;
      width: 100%; max-width: 380px; color: #e2e8f0; font-family: 'Segoe UI', system-ui, sans-serif;
      box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); }
    .ch-dialog h3 { font-size: 1.05rem; color: #38bdf8; margin: 0 0 16px; }
    .ch-dialog label { display: block; font-size: 0.75rem; font-weight: 600; color: #94a3b8;
      text-transform: uppercase; letter-spacing: 0.04em; margin: 12px 0 6px; }
    .ch-dialog input { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #475569;
      background: #0f172a; color: #e2e8f0; font-size: 0.95rem; outline: none; box-sizing: border-box; }
    .ch-dialog input:focus { border-color: #0ea5e9; }
    .ch-msg { margin-top: 12px; font-size: 0.85rem; padding: 8px 12px; border-radius: 8px; display: none; }
    .ch-msg.error { display: block; background: #450a0a; color: #fca5a5; }
    .ch-msg.ok { display: block; background: #052e16; color: #86efac; }
    .ch-actions { display: flex; gap: 10px; margin-top: 18px; }
    .ch-actions button { flex: 1; padding: 10px; border-radius: 8px; border: none; font-weight: 700;
      font-size: 0.9rem; cursor: pointer; }
    .ch-actions .ch-cancel { background: transparent; border: 1px solid #475569; color: #cbd5e1; }
    .ch-actions .ch-ok { background: #0ea5e9; color: white; }
    .ch-actions button:disabled { opacity: 0.5; cursor: wait; }
  `;
  document.head.appendChild(style);
}

function openPasswordDialog() {
  injectDialogStyles();
  const overlay = document.createElement('div');
  overlay.className = 'ch-overlay';
  overlay.innerHTML = `
    <form class="ch-dialog" id="chPwdForm">
      <h3>🔑 Cambiar mi contraseña</h3>
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
    </form>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  const msg = overlay.querySelector('#chPwdMsg');
  overlay.querySelector('#chPwdCancel').addEventListener('click', close);
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
      msg.textContent = 'Contraseña actualizada ✓';
      setTimeout(close, 1200);
    } catch (err) {
      msg.className = 'ch-msg error';
      msg.textContent = err.message;
      btn.disabled = false;
    }
  });
}
