// Gestión de usuarios (sólo admin) y cambio de la propia contraseña.
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../lib/db');
const { ROLES, ah, publicUser, requireAuth, requireRole, passwordError, killSessions, sessionStats } = require('../lib/auth');

const Policy = require('../lib/session-policy');
const router = express.Router();
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;

function userRow(u) {
  return {
    ...publicUser(u),
    active: u.active,
    createdAt: u.created_at,
    updatedAt: u.updated_at
  };
}

function parseId(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Id inválido' });
    return null;
  }
  return id;
}

// ----- Cambio de la propia contraseña (cualquier usuario logueado) -----
router.post('/auth/password', requireAuth, ah(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Completá la contraseña actual y la nueva' });
  }
  const err = passwordError(newPassword);
  if (err) return res.status(400).json({ error: err });
  const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!rows[0] || !(await bcrypt.compare(String(currentPassword), rows[0].password_hash))) {
    return res.status(400).json({ error: 'La contraseña actual no es correcta' });
  }
  if (currentPassword === newPassword) {
    return res.status(400).json({ error: 'La contraseña nueva tiene que ser distinta de la actual' });
  }
  const hash = await bcrypt.hash(newPassword, 10);
  await db.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [hash, req.user.id]);
  // Se cierran las otras sesiones abiertas de este usuario (se mantiene la actual)
  await killSessions(req.user.id, req.sessionID);
  res.json({ ok: true });
}));

// ----- Administración de usuarios (sólo admin) -----
router.use('/users', requireAuth, requireRole('admin'));

router.get('/users', ah(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, username, name, role, active, created_at, updated_at FROM users
      ORDER BY active DESC, CASE role WHEN 'admin' THEN 0 WHEN 'supervisor' THEN 1 ELSE 2 END, username`);
  const pol = await Policy.getSettings();
  const st = await sessionStats((sess) => { const a = Policy.aliveNow(sess, pol); return a.idle && a.absolute; });
  res.json({ users: rows.map(u => ({ ...userRow(u), ...(st.get(Number(u.id)) || { sessions: 0, lastActivity: null }) })) });
}));

router.post('/users', ah(async (req, res) => {
  const body = req.body || {};
  const username = String(body.username || '').trim().toLowerCase();
  const name = String(body.name || '').trim();
  const role = String(body.role || '');
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Usuario inválido: de 3 a 32 caracteres, sólo letras minúsculas, números, punto, guion o guion bajo' });
  }
  if (!name || name.length > 100) return res.status(400).json({ error: 'Ingresá el nombre (hasta 100 caracteres)' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Rol inválido' });
  const err = passwordError(body.password);
  if (err) return res.status(400).json({ error: err });

  const hash = await bcrypt.hash(body.password, 10);
  try {
    const { rows } = await db.query(
      `INSERT INTO users (username, password_hash, name, role, active)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, username, name, role, active, created_at, updated_at`,
      [username, hash, name, role, body.active === false ? false : true]);
    res.status(201).json({ ok: true, user: userRow(rows[0]) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Ya existe un usuario con ese nombre de usuario' });
    throw e;
  }
}));

// Aplica cambios de nombre/rol/estado validando las reglas de administradores
async function updateUser(req, res, changes) {
  const id = parseId(req, res);
  if (id == null) return;
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    // Bloquea a los admins activos para evitar carreras al quitar el último
    await client.query("SELECT id FROM users WHERE role = 'admin' AND active FOR UPDATE");
    const { rows } = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [id]);
    const target = rows[0];
    if (!target) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    const newRole = changes.role !== undefined ? changes.role : target.role;
    const newActive = changes.active !== undefined ? changes.active : target.active;
    const newName = changes.name !== undefined ? changes.name : target.name;

    if (id === req.user.id && (newRole !== target.role || newActive !== target.active)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No podés cambiar tu propio rol ni desactivar tu propio usuario' });
    }
    if (target.role === 'admin' && target.active && (newRole !== 'admin' || !newActive)) {
      const { rows: [{ c }] } = await client.query(
        "SELECT count(*)::int AS c FROM users WHERE role = 'admin' AND active AND id <> $1", [id]);
      if (c === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'No se puede dejar el sistema sin ningún administrador activo' });
      }
    }
    const { rows: updated } = await client.query(
      `UPDATE users SET name = $1, role = $2, active = $3, updated_at = now() WHERE id = $4
       RETURNING id, username, name, role, active, created_at, updated_at`,
      [newName, newRole, newActive, id]);
    // Si se desactiva o cambia de rol, se cierran sus sesiones
    if (!newActive || newRole !== target.role) await killSessions(id, null, client);
    await client.query('COMMIT');
    res.json({ ok: true, user: userRow(updated[0]) });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

router.patch('/users/:id', ah(async (req, res) => {
  const body = req.body || {};
  const changes = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name || name.length > 100) return res.status(400).json({ error: 'Ingresá el nombre (hasta 100 caracteres)' });
    changes.name = name;
  }
  if (body.role !== undefined) {
    if (!ROLES.includes(body.role)) return res.status(400).json({ error: 'Rol inválido' });
    changes.role = body.role;
  }
  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') return res.status(400).json({ error: 'Estado inválido' });
    changes.active = body.active;
  }
  await updateUser(req, res, changes);
}));

// "Eliminar" = desactivar (no se borran usuarios para conservar el historial)
router.delete('/users/:id', ah(async (req, res) => {
  await updateUser(req, res, { active: false });
}));

router.post('/users/:id/password', ah(async (req, res) => {
  const id = parseId(req, res);
  if (id == null) return;
  const password = (req.body || {}).password;
  const err = passwordError(password);
  if (err) return res.status(400).json({ error: err });
  const hash = await bcrypt.hash(password, 10);
  const { rowCount } = await db.query(
    'UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [hash, id]);
  if (!rowCount) return res.status(404).json({ error: 'Usuario no encontrado' });
  // Obliga a volver a entrar con la nueva contraseña (menos la sesión actual si es uno mismo)
  await killSessions(id, id === req.user.id ? req.sessionID : null);
  res.json({ ok: true });
}));

// Cerrar todas las sesiones de un usuario (todos sus dispositivos). Si es uno mismo se conserva la actual
// (para cerrar también esta, usar "Cerrar sesión en todos los dispositivos").
router.post('/users/:id/sessions/revoke', ah(async (req, res) => {
  const id = parseId(req, res);
  if (id == null) return;
  const { rows } = await db.query('SELECT id FROM users WHERE id = $1', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
  const closed = await killSessions(id, id === req.user.id ? req.sessionID : null);
  res.json({ ok: true, closed, keptCurrent: id === req.user.id });
}));

module.exports = router;
