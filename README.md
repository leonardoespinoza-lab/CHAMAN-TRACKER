# Sistema de Fumigación

Login por roles + mapa + GPS compartido entre PC y celular, con usuarios, zonas,
trabajos y recorridos GPS guardados en PostgreSQL (no se pierde nada al redeployar).

## Arquitectura

- **`server.js`** – Express. Sirve las páginas (inyecta `MAPBOX_TOKEN` en `index.html` y
  `tracker.html`), la API y las sesiones.
- **`lib/auth.js`** – Sesión, permisos por rol y política de contraseñas (mínimo 8 caracteres).
- **`routes/jobs.js`** – Trabajos de aplicación (ruta + zona + fórmula + aplicador) y su recorrido GPS.
- **`zone-geo.js`** – Geometría compartida por servidor y navegador (con `@turf/turf`): zona derivada
  de la ruta, zona cubierta por el GPS, paralelas y largos.
- **`lib/coverage.js`** – Calcula y guarda la cobertura final (ruta % y zona cubierta %) de un trabajo.
- **`route-editor.js`** – Editor de pasadas sobre Mapbox (tocar para agregar puntos, deshacer,
  arrastrar vértices, paralelas). **`route-layers.js`** – Capas del mapa (ruta planificada/hecha,
  zona, zona cubierta, recorrido GPS). **`route-progress.js`** – Avance de la ruta.
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
| `jobs` | Trabajos de aplicación: zona + aplicador + máquina + equipo GPS + fórmula (producto, dosis, litros/ha, fecha, lote), `status`: pendiente / en_curso / finalizado / cancelado, `started_at` / `finished_at`, `route` (ruta planificada, GeoJSON MultiLineString en `jsonb`), `route_tolerance_m` (tolerancia GPS), `pass_width_m` (ancho de pasada), `zone_source` (`ruta` = zona derivada de la ruta; vacío = polígono dibujado en versiones anteriores), `covered_geometry` / `coverage_pct` / `route_pct` / `covered_at` (cobertura final), `deleted_at` / `deleted_by` (eliminado) |
| `track_points` | Puntos GPS (`job_id`, `zone_id`, `user_id`, lat, lng, precisión, velocidad, `recorded_at`, `source`) |
| `session` | Sesiones de login |
| `schema_migrations` | Control de migraciones aplicadas |

Nada se borra físicamente: al reemplazar o borrar una zona queda "reemplazada"/"cerrada" (y su
trabajo finalizado/cancelado), "limpiar trayectoria" marca los puntos con `cleared_at` y
**🗑️ Eliminar trabajo** sólo marca `deleted_at` (los puntos GPS se conservan).
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
| `POST /api/jobs` | supervisor, admin | `{ lotName, route, passWidthM?, routeToleranceM?, product, dose, doseUnit, litersPerHa, scheduledDate, notes, applicatorId, machine?, deviceId? }` → la zona se calcula en el servidor a partir de la ruta (`geometry` sin `route` se sigue aceptando por compatibilidad) |
| `GET /api/jobs/:id` | según permiso | Trabajo + ruta + zona + cobertura final (`coveredGeometry`, `coveragePct`, `routePct`) |
| `PATCH /api/jobs/:id` | supervisor, admin | Edita el trabajo. Pendiente: todo (`lotName`, `route`, `passWidthM`, `routeToleranceM`, fórmula, `applicatorId`, `machine`, `deviceId`); si cambia la ruta o el ancho se recalcula la zona. En curso: fórmula, fecha, notas, máquina, equipo y tolerancia (no ruta, ancho ni aplicador). Finalizado/cancelado: nada |
| `DELETE /api/jobs/:id` | supervisor, admin | Elimina el trabajo (borrado lógico: `deleted_at`). Si estaba en curso, el tracker deja de grabar y avisa. Un trabajo eliminado responde 410 |
| `POST /api/jobs/:id/start` | aplicador asignado, admin | Pasa a “en curso” (un aplicador no puede tener dos en curso) |
| `POST /api/jobs/:id/finish` | aplicador asignado, supervisor, admin | Finaliza |
| `POST /api/jobs/:id/cancel` | supervisor, admin | Cancela |
| `POST /api/jobs/:id/track` | aplicador asignado, admin | `{ points }` → puntos GPS del trabajo |
| `GET /api/jobs/:id/track?since=ID` | según permiso | Puntos nuevos desde un id |
| `GET /api/jobs/:id/stream` | según permiso | Seguimiento en vivo (Server-Sent Events): eventos `points`, `status`, `coverage` y `deleted` |

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

1. El supervisor entra a **📋 Trabajos** → **➕ Nuevo trabajo**: dibuja la ruta (ver abajo), le pone nombre, carga la
   fórmula (producto, dosis y unidad, caldo l/ha, fecha, notas), elige el aplicador y opcionalmente
   máquina / equipo GPS.
2. El aplicador ve en su celular (**tracker.html**) los trabajos asignados, toca uno y **▶ Iniciar trabajo**.
   El GPS envía los puntos ligados a ese trabajo. Puede pausar/reanudar y **■ Finalizar**.
3. El supervisor filtra la lista por estado/aplicador y abre el detalle: **avance de la ruta %** (el dato
   principal), ruta pintada, zona, zona cubierta %, distancia, tiempo y velocidad promedio.

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

## Ruta primero (pasadas)

Pensado para chacras de pera y manzana del Alto Valle, donde la pulverizadora (turbina) pasa por
cada entrefila.

- **El trabajo se crea dibujando la ruta**: una o varias pasadas (líneas). En el mapa:
  tocar/clic para agregar puntos, **↶ Deshacer**, **✔ Terminar** (o tocar el último punto),
  **＋ Otra pasada**, tocar una pasada para seleccionarla, arrastrar sus puntos (los celestes agregan
  un punto), **Paralela ← / →** (copia a un ancho de distancia), **📏 Enderezar**, **🗑️ Borrar**.
  En el panel: largo de cada pasada y total, borrar pasadas y **Duplicar la pasada N veces** hacia
  un lado (en zigzag). Atajos: Ctrl+Z, Enter/Esc, Supr. Las indicaciones aparecen arriba del mapa.
- **Ancho de pasada** = distancia entre filas de la chacra. **3,5 m por defecto** (INTA: 3,5 m en
  plantaciones nuevas, 4 m en las de 2000, 6–8 m en las antiguas), editable por trabajo (2–10 m).
  Se usa para las paralelas y para calcular la zona.
- **Tolerancia GPS**: campo aparte, **5 m por defecto** (3–10 m). No depende del ancho porque el
  error del GPS del celular (~5 m) es mayor que la entrefila.
- Opción avanzada **⚡ Generar pasadas desde un contorno**: se dibuja el contorno del cuadro, se generan
  las pasadas en zigzag a la distancia del ancho y el contorno se descarta.
- **Zona derivada**: el servidor la calcula y la guarda (`zone_source = 'ruta'`): cada pasada con un
  buffer de medio ancho y un “cierre” morfológico de medio ancho, que rellena los huecos menores a un
  ancho entre pasadas vecinas. Pasadas separadas por más de dos anchos quedan como zonas aparte.
- **Avance de la ruta %** (largo hecho / largo total) es el dato principal. Un tramo cuenta como hecho
  cuando pasó un punto GPS a la tolerancia o menos; si hay varias pasadas dentro de la tolerancia se marca
  sólo la **más cercana** (así no se pintan las filas vecinas). Los saltos de GPS de más de 60 m no cuentan.
- **Zona cubierta %**: recorrido GPS con un buffer de medio ancho, intersectado con la zona. En vivo es
  aproximado (se calcula en el navegador); al finalizar el servidor calcula el valor final, lo guarda y
  lo manda por SSE (`coverage`). Si llegan puntos atrasados de la cola sin conexión, se recalcula.
- En el mapa la ruta es la protagonista: planificada en amarillo punteado, lo hecho pintado de verde
  (con el ancho real según el zoom), marcador de la posición actual; la zona se ve tenue.
  Lo mismo en el tracker del aplicador, con el próximo tramo pendiente más cercano.
- **Trabajos anteriores**: siguen funcionando con su polígono y tolerancia guardados (10 m si no tenían).
  Mientras estén pendientes se les puede dibujar una ruta y la zona pasa a calcularse de la ruta.

## Eliminar trabajos

- Supervisor/admin: **🗑️** en cada tarjeta de la lista o **🗑️ Eliminar trabajo** en el detalle. Pide
  confirmación mostrando el nombre del trabajo.
- Si está **en curso**, avisa que el aplicador deja de grabar: el tracker se entera (≈3 s mientras graba,
  15 s si no), corta el GPS y muestra un aviso. Los puntos ya tomados se guardan.
- Es un borrado lógico (`deleted_at`, `deleted_by`): desaparece de las listas y del tracker. No hay
  pantalla para restaurarlo (habría que limpiar `deleted_at` en la base).

## Editar trabajos

- En el detalle, **✏️ Editar trabajo** abre el mismo formulario del alta con todo cargado.
- **Pendiente**: se puede cambiar todo (nombre, ruta, ancho de pasada, tolerancia, fórmula, fecha,
  notas, aplicador, máquina y equipo GPS).
- **En curso**: la ruta, el ancho y el aplicador quedan bloqueados (🔒, con el motivo en pantalla)
  porque el GPS ya registra sobre ellos; el resto (incluida la tolerancia) se puede corregir.
- **Finalizado / cancelado**: sólo lectura.
- El tracker del aplicador toma los cambios solo (revisa el trabajo cada 15 s).

## Celulares y tablets

- Funciona en iPhone (Safari) y Android (Chrome). En el celular vertical la página scrollea normalmente:
  el mapa queda fijo arriba y el panel pasa por debajo (se desliza sobre el panel para bajar y sobre el
  mapa para moverlo). En horizontal, mapa a la izquierda y panel con scroll a la derecha.
- Botones y campos de al menos 44 px, campos de 16 px (Safari no hace zoom al enfocar), alto real de
  pantalla con `dvh` y márgenes para la muesca/barra del iPhone (`safe-area`). Estilos en `responsive.css`.
- Para dibujar con el dedo: tocar cada vértice y **✔ Terminar dibujo** (botón sobre el mapa).

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
