// Conexión a PostgreSQL, migraciones automáticas y seed de usuarios demo.
const { Pool, types } = require('pg');
const bcrypt = require('bcryptjs');

// Las columnas DATE se devuelven como texto 'AAAA-MM-DD' (sin corrimiento de zona horaria)
types.setTypeParser(1082, (v) => v);

const DATABASE_URL = process.env.DATABASE_URL || '';

let pool = null;
let ready = false;
let lastError = null;

// SSL: se respeta PGSSLMODE si está definida; si no, se desactiva para la red
// privada de Railway (*.railway.internal) y localhost, y se activa (sin validar
// el certificado autofirmado) para conexiones públicas (proxy de Railway).
function sslConfig(url) {
  const mode = (process.env.PGSSLMODE || '').toLowerCase();
  if (mode === 'disable') return false;
  if (mode === 'verify-full' || mode === 'verify-ca') return { rejectUnauthorized: true };
  if (mode) return { rejectUnauthorized: false };
  let host = '';
  try { host = new URL(url).hostname; } catch { /* URL inválida: la valida pg */ }
  if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1' ||
      host.endsWith('.railway.internal')) {
    return false;
  }
  return { rejectUnauthorized: false };
}

// Migraciones: cada una se aplica una sola vez (tabla schema_migrations).
const MIGRATIONS = [
  {
    version: 1,
    name: 'esquema inicial: usuarios, zonas, trabajos, puntos GPS y sesiones',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id            BIGSERIAL PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE CHECK (username = lower(username) AND length(username) > 0),
        password_hash TEXT NOT NULL,
        name          TEXT NOT NULL,
        role          TEXT NOT NULL CHECK (role IN ('admin', 'supervisor', 'aplicador')),
        active        BOOLEAN NOT NULL DEFAULT TRUE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS zones (
        id          BIGSERIAL PRIMARY KEY,
        name        TEXT NOT NULL DEFAULT 'Zona',
        geometry    JSONB NOT NULL,
        properties  JSONB NOT NULL DEFAULT '{}'::jsonb,
        assigned_to BIGINT REFERENCES users(id),
        created_by  BIGINT REFERENCES users(id),
        status      TEXT NOT NULL DEFAULT 'activa' CHECK (status IN ('activa', 'reemplazada', 'cerrada')),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        closed_at   TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS zones_status_created_idx ON zones (status, created_at DESC);
      CREATE INDEX IF NOT EXISTS zones_assigned_idx ON zones (assigned_to, status);

      -- Trabajo de aplicación: zona (lote) + fórmula + aplicador/máquina/equipo GPS.
      -- La fórmula queda en columnas simples; más adelante puede pasar a una tabla
      -- de productos por trabajo sin cambiar el resto.
      CREATE TABLE IF NOT EXISTS jobs (
        id             BIGSERIAL PRIMARY KEY,
        zone_id        BIGINT NOT NULL REFERENCES zones(id),
        applicator_id  BIGINT REFERENCES users(id),
        machine        TEXT,
        device_id      TEXT,          -- equipo GPS (p. ej. Wanway GS900/GS10G); NULL = GPS del celular
        lot_name       TEXT,
        product        TEXT,
        dose           NUMERIC,
        dose_unit      TEXT,
        liters_per_ha  NUMERIC,
        scheduled_date DATE,
        notes          TEXT,
        status         TEXT NOT NULL DEFAULT 'pendiente'
                       CHECK (status IN ('pendiente', 'en_curso', 'finalizado', 'cancelado')),
        created_by     BIGINT REFERENCES users(id),
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        started_at     TIMESTAMPTZ,
        finished_at    TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS jobs_zone_idx ON jobs (zone_id);
      CREATE INDEX IF NOT EXISTS jobs_applicator_status_idx ON jobs (applicator_id, status);
      CREATE INDEX IF NOT EXISTS jobs_status_created_idx ON jobs (status, created_at DESC);

      CREATE TABLE IF NOT EXISTS track_points (
        id          BIGSERIAL PRIMARY KEY,
        job_id      BIGINT REFERENCES jobs(id),
        zone_id     BIGINT REFERENCES zones(id),
        user_id     BIGINT NOT NULL REFERENCES users(id),
        source      TEXT NOT NULL DEFAULT 'telefono',  -- origen del punto: telefono / equipo GPS
        lat         DOUBLE PRECISION NOT NULL CHECK (lat BETWEEN -90 AND 90),
        lng         DOUBLE PRECISION NOT NULL CHECK (lng BETWEEN -180 AND 180),
        accuracy    REAL,
        speed       REAL,
        recorded_at TIMESTAMPTZ NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        cleared_at  TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS track_points_job_time_idx ON track_points (job_id, recorded_at);
      CREATE INDEX IF NOT EXISTS track_points_zone_time_idx ON track_points (zone_id, recorded_at);
      CREATE INDEX IF NOT EXISTS track_points_user_time_idx ON track_points (user_id, recorded_at);

      -- Tabla de sesiones que usa connect-pg-simple
      CREATE TABLE IF NOT EXISTS session (
        sid    VARCHAR NOT NULL PRIMARY KEY,
        sess   JSON NOT NULL,
        expire TIMESTAMP(6) NOT NULL
      );
      CREATE INDEX IF NOT EXISTS session_expire_idx ON session (expire);
    `
  },
  {
    version: 2,
    name: 'origen de zonas (panel simple o trabajo)',
    sql: `
      -- 'panel' = zona rápida del panel simple (endpoints /api/zone); 'trabajo' = lote de un trabajo
      ALTER TABLE zones ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'panel';
      CREATE INDEX IF NOT EXISTS zones_origin_status_idx ON zones (origin, status, created_at DESC);
    `
  },
  {
    version: 3,
    name: 'id de cliente en puntos GPS (evita duplicados al reenviar la cola offline)',
    sql: `
      ALTER TABLE track_points ADD COLUMN IF NOT EXISTS client_id TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS track_points_user_client_uidx
        ON track_points (user_id, client_id) WHERE client_id IS NOT NULL;
    `
  },
  {
    version: 4,
    name: 'recorrido planificado del trabajo (pasadas) y tolerancia',
    sql: `
      -- GeoJSON MultiLineString con las pasadas planificadas (NULL = sin recorrido)
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS route JSONB;
      -- Distancia máxima (m) del GPS a la pasada para darla por hecha (NULL = valor por defecto)
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS route_tolerance_m REAL;
    `
  },
  {
    version: 5,
    name: 'ruta como base del trabajo: ancho de pasada, zona derivada, zona cubierta y borrado lógico',
    sql: `
      -- Ancho de pasada / aplicación (m). NULL = trabajo anterior (se usa el valor por defecto)
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS pass_width_m REAL;
      -- Origen de la zona (zones.geometry): 'ruta' = calculada a partir de las pasadas;
      -- NULL o 'dibujada' = polígono dibujado a mano (trabajos anteriores o panel simple)
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS zone_source TEXT;
      -- Zona cubierta por el GPS (se calcula al finalizar) y porcentajes finales
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS covered_geometry JSONB;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS coverage_pct REAL;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS route_pct REAL;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS covered_at TIMESTAMPTZ;
      -- Borrado lógico: el trabajo desaparece de las listas pero se conserva con su recorrido
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS deleted_by BIGINT REFERENCES users(id);
      CREATE INDEX IF NOT EXISTS jobs_not_deleted_idx ON jobs (status, created_at DESC) WHERE deleted_at IS NULL;
    `
  }
];

const DEMO_USERS = [
  { username: 'admin', password: 'admin', name: 'Administrador', role: 'admin' },
  { username: 'supervisor', password: 'supervisor', name: 'Supervisor', role: 'supervisor' },
  { username: 'aplicador', password: 'aplicador', name: 'Aplicador', role: 'aplicador' }
];

async function migrate(client) {
  await client.query('BEGIN');
  try {
    // Lock para que dos instancias no migren a la vez (p. ej. durante un redeploy)
    await client.query('SELECT pg_advisory_xact_lock(727274)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map(r => r.version));
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      await client.query(m.sql);
      await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
      console.log(`[db] Migración ${m.version} aplicada: ${m.name}`);
    }

    // Seed de usuarios demo sólo si la tabla está vacía
    const { rows: [{ count }] } = await client.query('SELECT count(*)::int AS count FROM users');
    if (count === 0) {
      for (const u of DEMO_USERS) {
        const hash = await bcrypt.hash(u.password, 10);
        await client.query(
          'INSERT INTO users (username, password_hash, name, role) VALUES ($1, $2, $3, $4)',
          [u.username, hash, u.name, u.role]
        );
      }
      console.warn('[db] Se crearon los usuarios demo (admin, supervisor, aplicador). ¡Cambiá sus contraseñas!');
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

// Inicializa el pool y reintenta la migración hasta que la base responda.
function init() {
  if (!DATABASE_URL) {
    console.error('[db] ERROR: falta la variable DATABASE_URL. El servidor arranca igual, ' +
      'pero la API responde 503 hasta que se configure la base de datos.');
    lastError = new Error('DATABASE_URL no configurada');
    return;
  }
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: sslConfig(DATABASE_URL),
    max: 10,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000
  });
  pool.on('error', (err) => console.error('[db] Error en conexión inactiva:', err.message));

  let attempt = 0;
  const tryMigrate = async () => {
    attempt++;
    let client;
    try {
      client = await pool.connect();
      await migrate(client);
      ready = true;
      lastError = null;
      console.log('[db] Base de datos lista.');
    } catch (err) {
      lastError = err;
      const delay = Math.min(30000, 2000 * attempt);
      console.error(`[db] No se pudo conectar/migrar (intento ${attempt}): ${err.message}. Reintento en ${delay / 1000}s`);
      setTimeout(tryMigrate, delay);
    } finally {
      if (client) client.release();
    }
  };
  tryMigrate();
}

module.exports = {
  init,
  getPool: () => pool,
  isConfigured: () => !!DATABASE_URL,
  isReady: () => ready,
  lastError: () => lastError,
  query: (text, params) => pool.query(text, params),
  migrate
};
