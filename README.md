# Sistema de Fumigación

Login por roles + mapa + GPS compartido entre PC y celular, con usuarios, zonas,
trabajos y recorridos GPS guardados en PostgreSQL (no se pierde nada al redeployar).

## Arquitectura

- **`server.js`** – Express. Sirve las páginas (inyecta `MAPBOX_TOKEN` en `index.html` y
  `tracker.html`), la API y las sesiones.
- **`lib/auth.js`** – Sesión, permisos por rol y política de contraseñas (mínimo 8 caracteres).
- **`routes/jobs.js`** – Trabajos de aplicación (lote + fórmula + aplicador) y su recorrido GPS.
- **`routes/users.js`** – Gestión de usuarios (admin) y cambio de la propia contraseña.
- **`lib/db.js`** – Conexión a PostgreSQL (`pg`), migraciones automáticas al arrancar
  (tabla `schema_migrations`, idempotentes) y creación de los usuarios demo si la tabla
  `users` está vacía.
- **Sesiones** – `express-session` + `connect-pg-simple` (tabla `session` en Postgres).
  Cookie `chaman.sid` httpOnly, `SameSite=Lax` y `Secure` detrás del HTTPS de Railway.
  Contraseñas con `bcryptjs`. Límite de intentos fallidos de login por IP.
- **Front-end** – `login.html`, `trabajos.html` (supervisor/admin, pantalla principal),
  `index.html` (panel simple de una zona), `usuarios.html` (admin), `tracker.html` (aplicador) y `auth.js`. El login lo valida el servidor; `localStorage` es sólo una caché para pintar la
  pantalla. Si la API responde 401 se vuelve al login.
- Si falta `DATABASE_URL`, el servidor arranca igual (el healthcheck `/login.html` pasa),
  lo informa en el log y la API responde 503.

### Tablas

| Tabla | Para qué |
|-------|----------|
| `users` | Usuarios (`username` único, `password_hash`, `name`, `role`: admin / supervisor / aplicador, `active`) |
| `zones` | Lotes dibujados (`geometry` GeoJSON en `jsonb`, `assigned_to`, `created_by`, `status`: activa / reemplazada / cerrada) |
| `jobs` | Trabajos de aplicación: zona + aplicador + máquina + equipo GPS + fórmula (producto, dosis, litros/ha, fecha, lote), `status`: pendiente / en_curso / finalizado / cancelado, `started_at` / `finished_at` |
| `track_points` | Puntos GPS (`job_id`, `zone_id`, `user_id`, lat, lng, precisión, velocidad, `recorded_at`, `source`) |
| `session` | Sesiones de login |
| `schema_migrations` | Control de migraciones aplicadas |

Nada se borra físicamente: al reemplazar o borrar una zona queda "reemplazada"/"cerrada" (y su
trabajo finalizado/cancelado), y "limpiar trayectoria" marca los puntos con `cleared_at`.
Así queda todo el historial para reportes de cobertura más adelante.

### API

| Método y ruta | Quién | Qué hace |
|---------------|-------|----------|
| `POST /api/auth/login` | todos | `{ username, password }` → inicia sesión |
| `POST /api/auth/logout` | todos | Cierra la sesión |
| `GET /api/auth/me` | logueado | Usuario actual (401 si no hay sesión) |
| `POST /api/auth/password` | logueado | `{ currentPassword, newPassword }` → cambia la propia contraseña |
| `GET /api/users` | admin | Lista de usuarios |
| `POST /api/users` | admin | `{ username, name, role, password }` → crea usuario |
| `PATCH /api/users/:id` | admin | `{ name?, role?, active? }` → edita (no se puede cambiar el propio rol, desactivarse ni dejar el sistema sin admins) |
| `DELETE /api/users/:id` | admin | Desactiva el usuario (no se borra) |
| `POST /api/users/:id/password` | admin | `{ password }` → resetea la contraseña y cierra sus sesiones |
| `GET /api/zone` | logueado | Zona activa actual (+ trabajo abierto) |
| `POST /api/zone` | supervisor, admin | `{ zone, name?, assignedTo?, job? }` → asigna zona nueva y crea su trabajo |
| `DELETE /api/zone` | supervisor, admin | Cierra la zona activa |
| `GET /api/track` | supervisor, admin | Puntos GPS de la zona actual |
| `POST /api/track` | aplicador, admin | `{ points }` (uno o varios) → guarda puntos |
| `DELETE /api/track` | aplicador, supervisor, admin | Limpia (archiva) la trayectoria actual |
| `GET /api/status` | logueado | Resumen: zona, trabajo, cantidad de puntos |
| `GET /api/health` | público | Estado de la conexión a la base |
| `GET /api/applicators` | supervisor, admin | Aplicadores activos |
| `GET /api/jobs` | logueado | Trabajos (filtros `status`, `applicatorId`; el aplicador ve sólo los suyos) |
| `POST /api/jobs` | supervisor, admin | `{ lotName, geometry, product, dose, doseUnit, litersPerHa, scheduledDate, notes, applicatorId, machine?, deviceId? }` |
| `GET /api/jobs/:id` | según permiso | Trabajo + polígono + recorrido |
| `PATCH /api/jobs/:id` | supervisor, admin | Edita datos (aplicador sólo si está pendiente) |
| `POST /api/jobs/:id/start` | aplicador asignado, admin | Pasa a “en curso” (un aplicador no puede tener dos en curso) |
| `POST /api/jobs/:id/finish` | aplicador asignado, supervisor, admin | Finaliza |
| `POST /api/jobs/:id/cancel` | supervisor, admin | Cancela |
| `POST /api/jobs/:id/track` | aplicador asignado, admin | `{ points }` → puntos GPS del trabajo |
| `GET /api/jobs/:id/track?since=ID` | según permiso | Puntos nuevos desde un id |
| `GET /api/jobs/:id/stream` | según permiso | Seguimiento en vivo (Server-Sent Events): eventos `points` y `status` |

## Variables en Railway

| Variable | ¿Obligatoria? | Detalle |
|----------|---------------|---------|
| `DATABASE_URL` | Sí | Referencia a la base PostgreSQL de Railway (`${{Postgres.DATABASE_URL}}`) |
| `MAPBOX_TOKEN` | Sí | Token público `pk.` de Mapbox. Sin esa variable el mapa no carga |
| `SESSION_SECRET` | Recomendada | Texto largo y aleatorio. Si falta, se genera uno al arrancar y las sesiones se pierden en cada redeploy |
| `PGSSLMODE` | No | Forzar SSL (`require`) o desactivarlo (`disable`). Por defecto: sin SSL en la red privada `*.railway.internal`, con SSL en conexiones públicas |

## Usuarios demo

Se crean automáticamente **sólo si la tabla `users` está vacía** (primer arranque):

| Usuario | Contraseña | Rol |
|---------|------------|-----|
| admin | admin | Admin |
| supervisor | supervisor | Supervisor |
| aplicador | aplicador | Aplicador |

> ⚠️ **Cambiá estas contraseñas** antes de usar el sistema en serio: entrá como `admin`, abrí
> **👥 Usuarios** y usá **🔑 Resetear** en cada usuario (o cada uno con el botón **🔑 Contraseña**).
> Lo ideal es crear usuarios con nombre propio y desactivar los demo.

## Trabajos con fórmula

1. El supervisor entra a **📋 Trabajos** → **➕ Nuevo trabajo**: dibuja el lote, le pone nombre, carga la
   fórmula (producto, dosis y unidad, caldo l/ha, fecha, notas), elige el aplicador y opcionalmente
   máquina / equipo GPS.
2. El aplicador ve en su celular (**tracker.html**) los trabajos asignados, toca uno y **▶ Iniciar trabajo**.
   El GPS envía los puntos ligados a ese trabajo. Puede pausar/reanudar y **■ Finalizar**.
3. El supervisor filtra la lista por estado/aplicador y abre el detalle: polígono, recorrido, cobertura %,
   distancia, tiempo y velocidad promedio.

El **🗺️ Panel simple** (`index.html`, una zona rápida) sigue funcionando: cada zona asignada desde ahí
también genera un trabajo sin fórmula que el aplicador ve en su lista.

## GPS en vivo y modo sin conexión

- En el detalle de un trabajo abierto, el supervisor ve **en vivo** la posición del aplicador (marcador),
  el recorrido, la hora del último punto (“hace N s”), la velocidad y la cobertura %. Usa
  Server-Sent Events con la cookie de sesión; si no se puede, consulta cada 5 s (🟡). El stream se
  renueva solo cada 10 min y retoma desde el último punto (`Last-Event-ID`).
- El tracker guarda cada punto primero en el celular (`localStorage`) y lo envía en lotes. Sin señal,
  los puntos quedan guardados (aunque se cierre la página) y se envían cuando vuelve la conexión.
  Cada punto lleva un id propio, así los reenvíos no se duplican. Para finalizar un trabajo tiene que
  haber conexión (así no quedan puntos afuera).
- El tracker pide mantener la pantalla encendida mientras registra (Wake Lock), porque con la pantalla
  apagada los navegadores cortan el GPS.

## Gestión de usuarios

Pantalla `usuarios.html` (sólo admin, enlace “👥 Usuarios” en el panel): listar, crear, editar
nombre/rol/estado, desactivar/activar y resetear contraseñas. Cualquier usuario puede cambiar su
propia contraseña con el botón “🔑 Contraseña” del encabezado.

## Desarrollo local

```bash
npm install
DATABASE_URL=postgres://usuario:clave@localhost:5432/fumigacion MAPBOX_TOKEN=pk.xxx npm start
```

Abrí http://localhost:3000/login.html
