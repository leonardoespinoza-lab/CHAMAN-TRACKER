const USERS = {
  admin: { password: 'admin', role: 'admin', name: 'Administrador' },
  supervisor: { password: 'supervisor', role: 'supervisor', name: 'Supervisor' },
  aplicador: { password: 'aplicador', role: 'aplicador', name: 'Aplicador' }
};

const SESSION_KEY = 'fumigacion_session';

function login(username, password) {
  const user = USERS[username.toLowerCase()];
  if (!user || user.password !== password) {
    return { ok: false, error: 'Usuario o contraseña incorrectos' };
  }
  const session = {
    username: username.toLowerCase(),
    role: user.role,
    name: user.name,
    loginAt: new Date().toISOString()
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return { ok: true, session };
}

function logout() {
  localStorage.removeItem(SESSION_KEY);
  window.location.href = 'login.html';
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

function requireAuth(allowedRoles = []) {
  const session = getSession();
  if (!session) {
    window.location.href = 'login.html';
    return null;
  }
  if (allowedRoles.length && !allowedRoles.includes(session.role)) {
    redirectByRole(session.role);
    return null;
  }
  return session;
}

function redirectByRole(role) {
  if (role === 'aplicador') {
    window.location.href = 'tracker.html';
  } else {
    window.location.href = 'index.html';
  }
}

function requireGuest() {
  const session = getSession();
  if (session) {
    redirectByRole(session.role);
  }
}
