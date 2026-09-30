// Utilidades de autenticación y permisos compartidas por las rutas de la API.
const db = require('./db');

const ROLES = ['admin', 'supervisor', 'aplicador'];
const MIN_PASSWORD_LENGTH = 8;

// Envuelve handlers async para que los errores lleguen al manejador de Express
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function publicUser(u) {
  return { id: Number(u.id), username: u.username, name: u.name, role: u.role };
}

// Carga el usuario de la sesión y verifica que siga activo
const requireAuth = ah(async (req, res, next) => {
  const userId = req.session && req.session.userId;
  if (!userId) return res.status(401).json({ error: 'No autenticado' });
  const { rows } = await db.query(
    'SELECT id, username, name, role, active FROM users WHERE id = $1', [userId]);
  const user = rows[0];
  if (!user || !user.active) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Sesión inválida o usuario inactivo' });
  }
  user.id = Number(user.id);
  req.user = user;
  next();
});

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'No tenés permisos para esta acción' });
    }
    next();
  };
}

// Devuelve un mensaje de error si la contraseña no cumple la política, o null si está OK
function passwordError(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`;
  }
  if (password.length > 200) return 'La contraseña es demasiado larga';
  return null;
}

// Cierra las sesiones abiertas de un usuario (opcionalmente menos la actual)
async function killSessions(userId, exceptSid, client = db) {
  if (exceptSid) {
    await client.query("DELETE FROM session WHERE sess->>'userId' = $1 AND sid <> $2", [String(userId), exceptSid]);
  } else {
    await client.query("DELETE FROM session WHERE sess->>'userId' = $1", [String(userId)]);
  }
}

module.exports = { ROLES, MIN_PASSWORD_LENGTH, ah, publicUser, requireAuth, requireRole, passwordError, killSessions };
