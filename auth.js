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
