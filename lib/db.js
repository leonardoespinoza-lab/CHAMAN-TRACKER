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
  },
  {
    version: 6,
    name: 'alertas operativas: alertas, configuración, pausas e inicio programado',
    sql: `
      -- Inicio programado (opcional) y pausa actual del aplicador
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS planned_start_at TIMESTAMPTZ;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;
      -- Pausas del aplicador (con el GPS en pausa no hay alertas de parada ni de falta de señal)
      CREATE TABLE IF NOT EXISTS job_pauses (
        id          BIGSERIAL PRIMARY KEY,
        job_id      BIGINT NOT NULL REFERENCES jobs(id),
        user_id     BIGINT REFERENCES users(id),
        paused_at   TIMESTAMPTZ NOT NULL,
        resumed_at  TIMESTAMPTZ,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS job_pauses_job_idx ON job_pauses (job_id, paused_at);
      -- Alertas: una sola abierta por tipo y trabajo (resolved_at IS NULL)
      CREATE TABLE IF NOT EXISTS alerts (
        id               BIGSERIAL PRIMARY KEY,
        job_id           BIGINT NOT NULL REFERENCES jobs(id),
        type             TEXT NOT NULL CHECK (type IN ('velocidad', 'parada', 'sin_senal', 'ruta_incompleta', 'no_inicio')),
        severity         TEXT NOT NULL DEFAULT 'media' CHECK (severity IN ('alta', 'media', 'info')),
        started_at       TIMESTAMPTZ NOT NULL,
        resolved_at      TIMESTAMPTZ,
        details          JSONB NOT NULL DEFAULT '{}'::jsonb,
        acknowledged_by  BIGINT REFERENCES users(id),
        acknowledged_at  TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS alerts_one_open_uidx ON alerts (job_id, type) WHERE resolved_at IS NULL;
      CREATE INDEX IF NOT EXISTS alerts_job_idx ON alerts (job_id, started_at);
      CREATE INDEX IF NOT EXISTS alerts_started_idx ON alerts (started_at DESC);
      CREATE INDEX IF NOT EXISTS alerts_unseen_idx ON alerts (acknowledged_at) WHERE acknowledged_at IS NULL;
      -- Configuración general (umbrales de alertas, etc.) en JSON
      CREATE TABLE IF NOT EXISTS settings (
        key         TEXT PRIMARY KEY,
        value       JSONB NOT NULL,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_by  BIGINT REFERENCES users(id)
      );
    `
  },
  {
    version: 7,
    name: 'etapas de trabajo, método de aplicación y velocidad máxima por trabajo',
    sql: `
      -- Etapas: un trabajo se puede hacer en varias jornadas. Cada etapa es una sesión de grabación.
      CREATE TABLE IF NOT EXISTS job_stages (
        id               BIGSERIAL PRIMARY KEY,
        job_id           BIGINT NOT NULL REFERENCES jobs(id),
        seq              INTEGER NOT NULL,
        applicator_id    BIGINT REFERENCES users(id),
        started_at       TIMESTAMPTZ NOT NULL,
        ended_at         TIMESTAMPTZ,
        ended_by         TEXT,
        distance_m       DOUBLE PRECISION,
        point_count      INTEGER,
        route_pct_start  DOUBLE PRECISION,
        route_pct_end    DOUBLE PRECISION,
        stats_at         TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (job_id, seq)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS job_stages_one_open_uidx ON job_stages (job_id) WHERE ended_at IS NULL;
      CREATE INDEX IF NOT EXISTS job_stages_applicator_open_idx ON job_stages (applicator_id) WHERE ended_at IS NULL;
      ALTER TABLE track_points ADD COLUMN IF NOT EXISTS stage_id BIGINT REFERENCES job_stages(id);
      CREATE INDEX IF NOT EXISTS track_points_stage_idx ON track_points (stage_id);
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS application_method TEXT;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS speed_limit_kmh DOUBLE PRECISION;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ;
      -- Trabajos ya iniciados: una sola etapa (del inicio al cierre) con todos sus puntos
      INSERT INTO job_stages (job_id, seq, applicator_id, started_at, ended_at, ended_by)
      SELECT j.id, 1, j.applicator_id,
             LEAST(j.started_at, COALESCE((SELECT min(recorded_at) FROM track_points t WHERE t.job_id = j.id), j.started_at)),
             CASE WHEN j.status = 'en_curso' AND j.deleted_at IS NULL THEN NULL
                  ELSE GREATEST(j.started_at, COALESCE(j.finished_at, j.deleted_at,
                         (SELECT max(recorded_at) FROM track_points t WHERE t.job_id = j.id), j.started_at)) END,
             CASE WHEN j.deleted_at IS NOT NULL THEN 'eliminado'
                  WHEN j.status = 'finalizado' THEN 'finalizado'
                  WHEN j.status = 'cancelado' THEN 'cancelado' ELSE NULL END
        FROM jobs j
       WHERE j.started_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM job_stages s WHERE s.job_id = j.id);
      UPDATE track_points t SET stage_id = s.id
        FROM job_stages s WHERE s.job_id = t.job_id AND s.seq = 1 AND t.stage_id IS NULL;
    `
  },
  {
    version: 8,
    name: 'catálogo de productos y maquinaria, máquinas, stock y datos de ejemplo',
    sql: `
      -- Catálogo de productos fitosanitarios (precargado desde SENASA / INTA; editable por el admin)
      CREATE TABLE IF NOT EXISTS products (
        id                  BIGSERIAL PRIMARY KEY,
        name                TEXT NOT NULL,
        active_ingredient   TEXT,
        commercial_names    TEXT,
        company             TEXT,
        category            TEXT NOT NULL DEFAULT 'otro',
        aptitudes           TEXT,
        formulation         TEXT,
        tox_class           TEXT CHECK (tox_class IS NULL OR tox_class IN ('Ia', 'Ib', 'II', 'III', 'IV', 'S/D')),
        tox_note            TEXT,
        targets             TEXT,
        crops               TEXT,
        dose_text           TEXT,
        dose_value          DOUBLE PRECISION,
        dose_unit           TEXT,
        phi_days            DOUBLE PRECISION,
        phi_text            TEXT,
        reentry_hours       DOUBLE PRECISION,
        reentry_text        TEXT,
        unit                TEXT NOT NULL DEFAULT 'L' CHECK (unit IN ('L', 'kg')),
        source              TEXT NOT NULL DEFAULT 'admin',
        source_url          TEXT,
        source_ref          TEXT,
        senasa_reg          TEXT,
        uses                JSONB,
        note                TEXT,
        low_stock_threshold DOUBLE PRECISION,
        active              BOOLEAN NOT NULL DEFAULT TRUE,
        seed_key            TEXT UNIQUE,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS products_active_name_idx ON products (active, name);
      -- Tipos de maquinaria y EPP (catálogo genérico, no unidades reales)
      CREATE TABLE IF NOT EXISTS machine_types (
        id          BIGSERIAL PRIMARY KEY,
        kind        TEXT NOT NULL CHECK (kind IN ('tractor', 'pulverizadora', 'mochila', 'epp', 'otro')),
        name        TEXT NOT NULL,
        description TEXT,
        specs       JSONB NOT NULL DEFAULT '{}'::jsonb,
        sources     JSONB NOT NULL DEFAULT '[]'::jsonb,
        active      BOOLEAN NOT NULL DEFAULT TRUE,
        seed_key    TEXT UNIQUE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      -- Máquinas (unidades reales del establecimiento). Km y horas = base cargada + etapas GPS de sus trabajos
      CREATE TABLE IF NOT EXISTS machines (
        id               BIGSERIAL PRIMARY KEY,
        type_id          BIGINT REFERENCES machine_types(id),
        kind             TEXT NOT NULL DEFAULT 'otro' CHECK (kind IN ('tractor', 'pulverizadora', 'mochila', 'otro')),
        name             TEXT NOT NULL,
        brand            TEXT,
        model            TEXT,
        plate            TEXT,
        year             INTEGER,
        tank_l           DOUBLE PRECISION,
        base_km          DOUBLE PRECISION NOT NULL DEFAULT 0,
        base_hours       DOUBLE PRECISION NOT NULL DEFAULT 0,
        service_every_h  DOUBLE PRECISION,
        last_service_h   DOUBLE PRECISION,
        notes            TEXT,
        example          BOOLEAN NOT NULL DEFAULT FALSE,
        active           BOOLEAN NOT NULL DEFAULT TRUE,
        created_by       BIGINT REFERENCES users(id),
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      -- Trabajo: producto del catálogo (el texto libre "product" sigue), máquina e implemento
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS product_id BIGINT REFERENCES products(id);
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS machine_id BIGINT REFERENCES machines(id);
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS implement_id BIGINT REFERENCES machines(id);
      CREATE INDEX IF NOT EXISTS jobs_machine_idx ON jobs (machine_id);
      CREATE INDEX IF NOT EXISTS jobs_implement_idx ON jobs (implement_id);
      CREATE INDEX IF NOT EXISTS jobs_product_idx ON jobs (product_id);
      -- Movimientos de stock: compra (+), consumo de un trabajo (−, se recalcula) y ajuste manual (±)
      CREATE TABLE IF NOT EXISTS stock_movements (
        id           BIGSERIAL PRIMARY KEY,
        product_id   BIGINT NOT NULL REFERENCES products(id),
        kind         TEXT NOT NULL CHECK (kind IN ('compra', 'consumo', 'ajuste')),
        quantity     DOUBLE PRECISION NOT NULL,
        unit         TEXT NOT NULL CHECK (unit IN ('L', 'kg')),
        moved_on     DATE NOT NULL DEFAULT CURRENT_DATE,
        supplier     TEXT,
        lot          TEXT,
        cost_total   DOUBLE PRECISION,
        reason       TEXT,
        job_id       BIGINT REFERENCES jobs(id),
        details      JSONB,
        example      BOOLEAN NOT NULL DEFAULT FALSE,
        created_by   BIGINT REFERENCES users(id),
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS stock_movements_product_idx ON stock_movements (product_id, moved_on);
      CREATE UNIQUE INDEX IF NOT EXISTS stock_movements_job_consumo_uidx ON stock_movements (job_id) WHERE kind = 'consumo';
    `
  }
];

const DEMO_USERS = [
  { username: 'admin', password: 'admin', name: 'Administrador', role: 'admin' },
  { username: 'supervisor', password: 'supervisor', name: 'Supervisor', role: 'supervisor' },
  { username: 'aplicador', password: 'aplicador', name: 'Aplicador', role: 'aplicador' }
];

// Catálogos de referencia (productos SENASA/INTA y tipos de maquinaria/EPP): se insertan los que
// falten (por seed_key) sin pisar lo que el admin haya editado o desactivado.
async function seedCatalog(client) {
  let data;
  try { data = require('./catalog-data.json'); } catch (e) { console.error('[db] Sin catálogo de referencia:', e.message); return; }
  const version = data.generatedAt + ':' + data.products.length + ':' + data.machineTypes.length;
  const { rows } = await client.query("SELECT value FROM settings WHERE key = 'catalog_seed'");
  if (rows[0] && rows[0].value && rows[0].value.version === version) return;
  const { rowCount: np } = await client.query(
    `INSERT INTO products (seed_key, name, active_ingredient, commercial_names, company, category, aptitudes, formulation,
                           tox_class, tox_note, targets, crops, dose_text, dose_value, dose_unit, phi_days, phi_text,
                           reentry_hours, reentry_text, unit, source, source_url, source_ref, senasa_reg, uses, note, active)
     SELECT p."seedKey", p.name, p."activeIngredient", p."commercialNames", p.company, p.category, p.aptitudes, p.formulation,
            p."toxClass", p."toxNote", p.targets, p.crops, p."doseText", p."doseValue", p."doseUnit", p."phiDays", p."phiText",
            p."reentryHours", p."reentryText", p.unit, p.source, p."sourceUrl", p."sourceRef", p."senasaReg", p.uses, p.note, p.active
       FROM jsonb_to_recordset($1::jsonb) AS p("seedKey" text, name text, "activeIngredient" text, "commercialNames" text,
            company text, category text, aptitudes text, formulation text, "toxClass" text, "toxNote" text, targets text,
            crops text, "doseText" text, "doseValue" float8, "doseUnit" text, "phiDays" float8, "phiText" text,
            "reentryHours" float8, "reentryText" text, unit text, source text, "sourceUrl" text, "sourceRef" text,
            "senasaReg" text, uses jsonb, note text, active boolean)
     ON CONFLICT (seed_key) DO NOTHING`, [JSON.stringify(data.products)]);
  const { rowCount: nm } = await client.query(
    `INSERT INTO machine_types (seed_key, kind, name, description, specs, sources)
     SELECT m."seedKey", m.kind, m.name, m.description, COALESCE(m.specs, '{}'::jsonb), COALESCE(m.sources, '[]'::jsonb)
       FROM jsonb_to_recordset($1::jsonb) AS m("seedKey" text, kind text, name text, description text, specs jsonb, sources jsonb)
     ON CONFLICT (seed_key) DO NOTHING`, [JSON.stringify(data.machineTypes)]);
  await client.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('catalog_seed', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify({ version })]);
  console.log(`[db] Catálogo de referencia: ${np} productos y ${nm} tipos de maquinaria/EPP nuevos`);
}

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

    await seedCatalog(client);

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
