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
- **`alerts-core.js`** – Análisis de alertas operativas compartido por servidor y tracker (velocidad,
  paradas, huecos de señal, inicio tarde, tramos salteados). **`lib/alerts.js`** – Evaluador (cada 30 s,
  al recibir puntos y al finalizar), umbrales y avisos en vivo. **`routes/alerts.js`** – API de alertas.
- **`lib/gestion.js`** – Consumo de producto por trabajo (stock), km/horas de máquinas, stock estimado,
  exposición de aplicadores y datos del tablero. **`routes/gestion.js`** – API de catálogo, máquinas,
  stock, exposición, tablero, CSV y datos de ejemplo. **`lib/catalog-data.json`** – Catálogo de
  referencia (SENASA + INTA, maquinaria y EPP) que se carga solo al migrar.
- **`lib/db.js`** – Conexión a PostgreSQL (`pg`), migraciones automáticas al arrancar
  (tabla `schema_migrations`, idempotentes) y creación de los usuarios demo si la tabla
  `users` está vacía.
- **Sesiones** – `express-session` + `connect-pg-simple` (tabla `session` en Postgres).
  Cookie `chaman.sid` httpOnly, `SameSite=Lax` y `Secure` detrás del HTTPS de Railway.
  Contraseñas con `bcryptjs`. Límite de intentos fallidos de login por IP.
- **Front-end** – `login.html`, `trabajos.html` (supervisor/admin, pantalla principal),
  `index.html` (panel simple de una zona), `usuarios.html` (admin), `alertas.html` (supervisor/admin), `tablero.html` (admin: tablero ejecutivo, pantalla de inicio del admin), `gestion.html` (supervisor/admin: catálogo, maquinaria, stock y exposición; usa `gestion-core.js` y `gestion.css`), `informes.html` (supervisor/admin: informes PDF, Excel y CSV), `tracker.html` (aplicador), `nav.js` (menú lateral) y `auth.js`. El login lo valida el servidor; `localStorage` es sólo una caché para pintar la
  pantalla. Si la API responde 401 se vuelve al login.
- **Tema visual** – `theme.css` (se carga último en todas las páginas): variables CSS de la paleta
  (neutros zinc casi negros + acento esmeralda `#10b981`; rojo / ámbar / verde sólo para estados),
  encabezado, menú, botones, campos y tarjetas. Los estilos de cada página usan esas variables
  (`var(--surface)`, `var(--border)`, `var(--accent)`…). Íconos de línea en `icons.svg` (sprite local de
  [Lucide](https://lucide.dev), licencia ISC; sin CDN): `<svg class="i"><use href="icons.svg#i-bell"/></svg>`
  o `chIcon('bell')` desde JS. Los colores del mapa (ruta amarilla, hecho en verde) no cambian.
- **Menú lateral** – `nav.js` (componente compartido; se incluye con `<script src="nav.js"></script>` justo después de
  `<body>` en tablero, trabajos, alertas, gestión, panel simple, usuarios e informes). Arma la barra lateral desde una
  lista de ítems y el rol de la sesión (Tablero y Usuarios sólo admin; Informes supervisor/admin): logo, ítems con ícono,
  activo resaltado, usuario con rol, Contraseña, Salir y botón para contraer (riel de 64 px con tooltips; se recuerda en
  `localStorage` `chaman.sidebar.collapsed`). Expandida mide 232 px. En pantallas de menos de 900 px queda oculta: barra
  superior con ☰ que la abre como cajón con fondo oscuro (cierra al tocar un ítem, tocar afuera o Esc), por encima del
  mapa. Al contraer/expandir se llama `map.resize()` en los mapas de Mapbox. El tracker del aplicador mantiene su pantalla
  completa propia. Al salir de una página se cierran los streams en vivo (alertas y trabajo) para no agotar conexiones.
- Si falta `DATABASE_URL`, el servidor arranca igual (el healthcheck `/login.html` pasa),
  lo informa en el log y la API responde 503.

### Tablas

| Tabla | Para qué |
|-------|----------|
| `users` | Usuarios (`username` único, `password_hash`, `name`, `role`: admin / supervisor / aplicador, `active`) |
| `zones` | Lotes dibujados (`geometry` GeoJSON en `jsonb`, `assigned_to`, `created_by`, `status`: activa / reemplazada / cerrada) |
| `jobs` | Trabajos de aplicación: zona + aplicador + máquina + equipo GPS + fórmula (producto, dosis, litros/ha, fecha, lote), `status`: pendiente / en_curso / finalizado / cancelado, `started_at` / `finished_at`, `route` (ruta planificada, GeoJSON MultiLineString en `jsonb`), `route_tolerance_m` (tolerancia GPS), `pass_width_m` (ancho de pasada), `zone_source` (`ruta` = zona derivada de la ruta; vacío = polígono dibujado en versiones anteriores), `covered_geometry` / `coverage_pct` / `route_pct` / `covered_at` (cobertura final), `planned_start_at` (inicio programado, opcional), `application_method` (tractor / mochila / otro) y `speed_limit_kmh` (velocidad máxima propia; vacío = la general), `product_id` (producto del catálogo, opcional: el texto `product` se mantiene), `machine_id` (tractor/mochila) e `implement_id` (pulverizadora), `reopened_at`, `deleted_at` / `deleted_by` (eliminado) |
| `job_stages` | Etapas (jornadas) de un trabajo: `seq`, `applicator_id`, `started_at`, `ended_at` (vacío = abierta; una sola abierta por trabajo), `ended_by` (aplicador / finalizado / finalizado_supervisor / auto / otro_trabajo / cancelado / eliminado), `distance_m`, `point_count`, `route_pct_start` / `route_pct_end` (avance de ruta acumulado antes y después) |
| `track_points` | Puntos GPS (`job_id`, `zone_id`, `user_id`, `stage_id`, lat, lng, precisión, velocidad, `recorded_at`, `source`) |
| `job_pauses` | Pausas del GPS pedidas por el aplicador (`paused_at`, `resumed_at`); `jobs.paused_at` = pausa en curso |
| `alerts` | Alertas operativas (`job_id`, `type`, `severity` alta/media/info, `started_at`, `resolved_at`, `details` jsonb, `acknowledged_by` / `acknowledged_at`). Índice único parcial: una sola abierta por tipo y trabajo |
| `products` | Catálogo de productos fitosanitarios: principio activo, marcas, empresa, categoría, formulación, clase toxicológica (Ia/Ib/II/III/IV), plagas, dosis (texto + `dose_value`/`dose_unit` para calcular), carencia, reingreso, unidad de stock (L/kg), fuente y enlace, n° de registro SENASA, usos por cultivo (`uses` jsonb), `low_stock_threshold`, `active`, `seed_key` (productos de referencia) |
| `machine_types` | Tipos genéricos de maquinaria y EPP (tractor frutero, pulverizadora axial / torre, mochilas, malla antigranizo, elementos de protección) con fuentes |
| `machines` | Máquinas reales: tipo, marca/modelo, dominio, año, tanque, km y horas iniciales, plan de service (`service_every_h`, `last_service_h`), `example` (datos de ejemplo) |
| `stock_movements` | Movimientos de stock: `compra` (+, proveedor, partida, costo), `consumo` (−, uno por trabajo, calculado solo) y `ajuste` (±, con motivo); `example` |
| `settings` | Configuración global (clave `alerts` = umbrales de alertas y calidad del GPS; `gestion` = umbrales de exposición; `catalog_seed` = versión del catálogo cargado; en jsonb) |
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
| `GET /api/jobs/:id` | según permiso | Trabajo + ruta + zona + cobertura (`coveredGeometry`, `coveragePct`, `routePct`) + `stages` (etapas con duración, distancia y % aportado) + puntos (cada uno con `stage`) |
| `PATCH /api/jobs/:id` | supervisor, admin | Edita el trabajo. Pendiente: todo (`lotName`, `route`, `passWidthM`, `routeToleranceM`, fórmula, `applicatorId`, `machine`, `deviceId`); si cambia la ruta o el ancho se recalcula la zona. En curso: fórmula, fecha, notas, máquina, equipo y tolerancia (no ruta, ancho ni aplicador). Finalizado/cancelado: nada |
| `DELETE /api/jobs/:id` | supervisor, admin | Elimina el trabajo (borrado lógico: `deleted_at`). Si estaba en curso, el tracker deja de grabar y avisa. Un trabajo eliminado responde 410 |
| `POST /api/jobs/:id/start` | aplicador asignado, admin | `{ at?, newStage? }` → inicia el trabajo (etapa 1) o una etapa nueva. Si ya hay una etapa abierta, no hace nada (`newStage: true` la cierra y abre otra). Una sola etapa abierta por aplicador: si dejó otra abierta sin grabar se cierra sola; si está grabando otro trabajo → 409 |
| `POST /api/jobs/:id/stage-end` | aplicador asignado, admin | `{ at? }` → “Terminar etapa por hoy”: cierra la etapa (y la pausa) sin finalizar el trabajo |
| `POST /api/jobs/:id/finish` | aplicador asignado, supervisor, admin | Finaliza (cierra la etapa abierta) |
| `POST /api/jobs/:id/reopen` | supervisor, admin | Reabre un trabajo finalizado: vuelve a “en curso” y se sigue en una etapa nueva |
| `POST /api/jobs/:id/cancel` | supervisor, admin | Cancela |
| `POST /api/jobs/:id/track` | aplicador asignado, admin | `{ points }` → puntos GPS del trabajo |
| `GET /api/jobs/:id/track?since=ID` | según permiso | Puntos nuevos desde un id |
| `GET /api/jobs/:id/stream` | según permiso | Seguimiento en vivo (Server-Sent Events): eventos `points`, `status`, `coverage`, `deleted`, `pause`, `stage` (etapas y avance en vivo) y `alert` |
| `POST /api/jobs/:id/pause` · `/resume` | aplicador asignado, admin | `{ at? }` → pausa / reanuda el GPS (`at` = hora real en el celular, si llega tarde por falta de conexión) |
| `GET /api/alerts` | supervisor, admin | Alertas (filtros `status=open\|resolved\|all`, `type`, `severity`, `jobId`, `applicatorId`, `unseen=1`) + resumen |
| `GET /api/alerts/summary` | supervisor, admin | `{ open, openHigh, unseen }` |
| `POST /api/alerts/:id/ack` · `POST /api/alerts/ack` | supervisor, admin | Marcar como vista una alerta, una lista (`ids`) o todas (`all`, opcional `jobId`) |
| `GET /api/alerts/stream` | supervisor, admin | Avisos en vivo (SSE): `summary` y `alert` (`created` / `updated` / `resolved` / `ack`) |
| `GET /api/alerts/settings` · `PUT` | logueado · admin | Umbrales de alertas (el tracker los usa para avisar al aplicador) |
| `GET /api/catalog/products` · `/:id` | supervisor, admin | Catálogo (filtros `q`, `category`, `source`, `active=all`); el detalle trae los usos por cultivo |
| `POST` · `PATCH` · `DELETE /api/catalog/products/:id` | admin | Alta / edición / baja (los de referencia o con movimientos se desactivan) |
| `GET /api/catalog/machine-types` · `POST` · `PATCH` | supervisor, admin · admin | Tipos de maquinaria y EPP |
| `GET /api/machines` · `POST` · `PATCH /:id` | supervisor, admin | Máquinas con km/horas (iniciales + GPS); `PATCH { serviceDone: true }` registra el service |
| `DELETE /api/machines/:id` | admin | Borra (si tiene trabajos, la desactiva) |
| `GET /api/stock` · `GET /api/stock/movements` | supervisor, admin | Stock estimado por producto y movimientos |
| `POST /api/stock/purchases` · `/adjustments` | supervisor, admin | Compra `{ productId, quantity, date, supplier, lot, costTotal }` · ajuste `{ productId, quantity (±), reason }` |
| `PUT /api/stock/threshold/:productId` | supervisor, admin | Stock mínimo (alerta de stock bajo) |
| `DELETE /api/stock/movements/:id` | admin | Borra una compra o ajuste (los consumos se calculan solos) |
| `GET /api/exposure` | supervisor, admin | Horas de aplicación por aplicador, producto, clase toxicológica y mes, con avisos |
| `GET /api/gestion/settings` · `PUT` | supervisor, admin · admin | Umbrales de exposición (horas de alta toxicidad por mes / año) |
| `GET /api/dashboard?from&to` | admin | KPIs y series del tablero ejecutivo |
| `GET /api/dashboard/export?kind=…` | admin | CSV (`;`, UTF-8 con BOM): `trabajos`, `aplicadores`, `stock`, `movimientos`, `maquinaria`, `exposicion` |
| `GET /api/demo` · `POST` · `DELETE` | admin | Estado / cargar / borrar los datos de ejemplo (marcados EJEMPLO) |
| `GET /api/reports/options` | supervisor, admin | Listas para los filtros de Informes (aplicadores, máquinas, productos, trabajos, estados, secciones) |
| `GET /api/reports?from&to&sections&applicatorId&machineId&productId&status&jobId` | supervisor, admin | Vista previa del informe (JSON: datos, KPIs, tablas y geometría simplificada para miniaturas) |
| `GET /api/reports/export?format=pdf\|xlsx\|csv&…` | supervisor, admin | Mismo informe para descargar: PDF (A4 apaisado), Excel (una hoja por sección) o CSV (uno por sección; zip si son varios) |

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

## Posición del celular al abrir el GPS

- **Aplicador (tracker):** apenas se abre la página (y al abrir un trabajo) se pide la ubicación con
  alta precisión **sólo para mostrarla**: punto “estás acá”, círculo de precisión y un indicador arriba a la
  izquierda (“📡 Buscando señal GPS…” hasta la primera lectura, después “📍 Estás acá · precisión ±N m”).
  El mapa encuadra la ruta y la posición juntas; si el lote está a más de 3 km, centra en la posición y avisa
  “el lote está a X km”. Botones (≥ 44 px): **📍 Centrar en mi posición** y **〰️ Ver ruta**.
- **▶ Iniciar** centra el mapa en la posición actual y recién ahí empieza a grabar puntos
  (antes de Iniciar no se guarda ni se envía nada; en pausa la posición se sigue mostrando sin grabar).
- Sin permiso de ubicación (o sin https, o si el GPS tarda) aparece un aviso con los pasos para
  **iPhone (Safari)** y **Android (Chrome)** y un botón **🔄 Reintentar**; con el permiso negado Iniciar no
  arranca el trabajo. La ubicación del navegador sólo funciona con **https://** (Railway ya lo usa).
- **Supervisor:** los mapas de Trabajos (crear, editar, detalle) y el Panel simple tienen el botón
  **Mi ubicación** (control de Mapbox). Al crear un **trabajo nuevo** el mapa intenta arrancar en la
  ubicación del dispositivo (marca azul); si no hay permiso queda la vista de siempre.

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

## Trabajo en etapas e historial del aplicador

Un trabajo se puede hacer en **varias jornadas**. Estados: pendiente → en curso (con etapas) → finalizado,
y sólo se finaliza cuando el aplicador o el supervisor lo deciden.

- **Aplicador**: “▶ Iniciar trabajo” abre la etapa 1. Al irse: **⏹ Terminar etapa por hoy** (el trabajo queda
  en curso). Otro día: **▶ Iniciar etapa N** y sigue desde donde dejó; el aviso “🧭 Seguís desde donde dejaste”
  muestra cuánto falta (y “👁 Ver lo que falta” encuadra los tramos pendientes). El avance de ruta y la zona
  cubierta se acumulan entre etapas. **■ Finalizar trabajo** lo cierra del todo. Iniciar y terminar etapas
  funciona también sin conexión (se avisa al volver la señal, antes de mandar los puntos).
- **Mis trabajos** tiene pestañas **Pendientes / En curso / Finalizados**. Cada finalizado muestra ruta %,
  zona %, fecha, duración (suma de las etapas) y cantidad de etapas; al tocarlo se ve el mapa de ruta vs
  recorrido en sólo lectura.
- **Supervisor**: el detalle muestra la lista de **🧩 Etapas** (fecha, duración, distancia, puntos y % de ruta
  aportado) y con 👁 se prende el recorrido de cada etapa en el mapa (un color por etapa). Las etapas
  aparecen en la línea de tiempo. **↩ Reabrir trabajo** vuelve un finalizado a “en curso” para seguir en
  una etapa nueva (la alerta de tramos salteados se cierra como “reabierto” y se vuelve a controlar al finalizar).
- Entre etapas no hay alertas de “sin señal” ni de “parada” (cuenta como una pausa larga).
- Los puntos grabados fuera de una etapa (antes de empezarla o entre etapas) se descartan.
- Mientras un trabajo está en curso el servidor recalcula el avance de ruta y la zona cubierta cada ~1 min,
  así las listas y la API muestran los % en vivo.

**Calidad del GPS** (admin, en Alertas → Umbrales → 🎯 Calidad del GPS): se descartan los puntos con
precisión peor que ±15 m y, para empezar a grabar, el tracker espera una primera posición de ±10 m o
mejor (“Esperando mejor señal GPS… ±N m”). El seguimiento de grabación pide siempre una lectura nueva
(`maximumAge: 0`) y no graba posiciones anteriores al inicio de la etapa.

**Método de aplicación y velocidad máxima** (por trabajo): Tractor / turbo (4,5 km/h, la general),
Mochila / a pie (6 km/h) u Otro; el límite se puede ajustar, también con el trabajo en curso. La alerta de
exceso de velocidad y el aviso en el celular usan el límite del trabajo.

## Alertas operativas

El servidor revisa los trabajos cada 30 s (también al recibir puntos GPS y al finalizar), así detecta
problemas aunque el celular esté apagado. Una sola alerta abierta por tipo y trabajo; se cierra sola
cuando termina la condición. Los supervisores ven un contador en el encabezado (**🔔 Alertas**, en rojo
si hay alguna grave), un aviso emergente cuando aparece una nueva, la página **Alertas** (filtros
abiertas/resueltas, tipo, aplicador, trabajo, sin ver; “Marcar visto”), chips en las tarjetas de los
trabajos y la línea de tiempo en el detalle (inicio, pausas, alertas, fin; tocar una alerta la ubica en el mapa).

| Alerta | Valor por defecto | Detalle |
|--------|-------------------|---------|
| ⏩ Exceso de velocidad | > 4,5 km/h durante 30 s y 3 puntos seguidos | Velocidad del GPS o calculada en ~15 s; se descartan saltos (> 40 km/h, precisión > 30 m) y se suaviza (mediana de 3). Grave si llega a 1,5× el límite |
| 🛑 Parada larga | < 10 m durante > 10 min | Con el trabajo en curso y sin pausar el GPS. Se cierra al moverse o al pausar |
| 📡 Sin señal GPS | > 5 min sin puntos | “Sin datos” (grave) mientras no llega nada; si después llegan puntos grabados sin conexión se cierra como “sin conexión pero grabando” (info); si los puntos tienen el hueco, queda como “hueco de GPS” |
| 〰️ Tramos de ruta salteados | al finalizar: ruta < 90 % o algún tramo ≥ 20 m | Lista los tramos con su largo. Se cierra al marcarla vista |
| ⏰ No arrancó a tiempo | pendiente 30 min después del **inicio programado** | Campo opcional del trabajo. Se cierra al iniciar (con la demora) o al reprogramar |

Los umbrales los cambia un admin en **Alertas → ⚙️ Umbrales de alertas** (se guardan en la base y valen
para todos los trabajos). El tracker avisa al aplicador sin tapar nada: “🐢 Bajá la velocidad: 5,2 km/h,
máximo 4,5” (a los 10 s) y “🛑 Llevás 11 min detenido. Si es una pausa, tocá ⏸ Pausar GPS”. Pausar el
GPS (también al volver a la lista o salir) se informa al servidor, con cola sin conexión.

## Celulares y tablets

- Funciona en iPhone (Safari) y Android (Chrome). En el celular vertical la página scrollea normalmente:
  el mapa queda fijo arriba y el panel pasa por debajo (se desliza sobre el panel para bajar y sobre el
  mapa para moverlo). En horizontal, mapa a la izquierda y panel con scroll a la derecha.
- Botones y campos de al menos 44 px, campos de 16 px (Safari no hace zoom al enfocar), alto real de
  pantalla con `dvh` y márgenes para la muesca/barra del iPhone (`safe-area`). Estilos en `responsive.css`.
- Para dibujar con el dedo: tocar cada vértice y **✔ Terminar dibujo** (botón sobre el mapa).

## Catálogo, maquinaria, stock y tablero ejecutivo

- **Catálogo de referencia** (📦 Gestión → Catálogo): se carga solo al migrar (no pisa lo que edite el admin).
  - **SENASA**: productos activos con uso registrado en **peral** y **manzano** según la consulta pública del
    [Vademécum de SENASA](https://aps2.senasa.gov.ar/vademecum/app/publico/formulados) (dosis y carencia por cultivo,
    clase toxicológica, n° de registro). SENASA no publica un dataset abierto: se tomó de la consulta pública.
  - **INTA Alto Valle**: principios activos de las guías regionales (insecticidas, fungicidas, aceites, raleadores) con
    dosis orientativas por hL y carencias cuando la guía las trae.
  - Todos dicen **“Catálogo de referencia — verificar etiqueta y registro vigente”**. El reingreso no figura en esas
    fuentes: se completa a mano desde el marbete. Clorpirifos queda desactivado (prohibido, Res. SENASA 414/2021).
  - Para dosis/carencias actualizadas de la región: [PISEF (INTA Alto Valle)](https://pisef-inta.com.ar/) (requiere cuenta).
- **Trabajos**: el producto se puede vincular al catálogo (completa nombre y dosis de referencia y muestra clase
  toxicológica, carencia y reingreso); el texto libre sigue funcionando. Se asigna tractor/mochila y pulverizadora.
- **Consumo y stock**: al cerrar una etapa o finalizar, consumo = dosis × ha cubiertas por el GPS
  (por hL: dosis × caldo L/ha × ha ÷ 100). Queda un movimiento `consumo` por trabajo (se recalcula si cambia la fórmula).
  Stock estimado = compras + ajustes − consumos; alerta con stock mínimo.
- **Máquinas**: km y horas = iniciales + etapas GPS (sin pausas) de los trabajos con la máquina asignada; service opcional
  cada N horas (vencido / próximo / al día).
- **Exposición**: horas de etapas por aplicador, producto y clase; aviso si supera los umbrales de horas de alta
  toxicidad (Ia, Ib, II) por mes o por año (configurables; por defecto 40 h/mes y 300 h/año, valores internos, no legales).
  El detalle del trabajo muestra “reingreso desde” y “cosecha desde”.
- **Tablero ejecutivo** (admin): KPIs, gráficos (Chart.js), filtro de fechas y exportación CSV.
  **Cargar datos de ejemplo** crea máquinas y compras marcadas EJEMPLO; **Borrar datos de ejemplo** las quita
  (también restaura los stocks mínimos de ejemplo). En producción no se carga nada solo.

## Informes

Pantalla `informes.html` (supervisor y admin, ítem **Informes** del menú lateral) para armar un informe de seguimiento:

- **Período**: este mes, mes anterior, últimos 30/90 días, este año o fechas a mano (hora Argentina). Entran los trabajos
  creados, programados, con etapas o finalizados en el período.
- **Filtros opcionales**: aplicador, máquina (tractor o implemento), producto, estado y lote/trabajo.
- **Secciones**: Resumen KPIs · Trabajos (% de zona, ha, producto, dosis, consumo estimado, carencia/“cosecha desde”,
  reingreso, etapas y miniaturas de cobertura) · Aplicaciones por producto y consumo (con compras del período y stock) ·
  Stock (saldos y movimientos) · Maquinaria (km/horas del período, totales y service) · Alertas · Exposición por
  aplicador · Rendimiento por aplicador.
- **Vista previa** en pantalla y exportación: **PDF** generado en el servidor con `pdfkit` (encabezado “Sistema de
  Fumigación”, período, filtros, fecha y usuario, tarjetas de KPIs, tablas paginadas con encabezado repetido y mapas
  vectoriales de cobertura: lote, zona cubierta y recorrido GPS); **Excel** con `exceljs` (hoja *Informe* con los datos del
  informe y KPIs + una hoja por tabla, con números y fechas reales, encabezado fijo y autofiltro); **CSV** (`;`, UTF-8 con
  BOM, uno por tabla; si hay más de una van en un zip con `archiver`).
- Reutiliza los cálculos de Gestión/Tablero (`lib/gestion.js`): consumo por fórmula, etapas sin pausas, stock,
  máquinas, exposición y rendimiento. Código: `lib/reports.js` (datos), `lib/report-export.js` (archivos) y
  `routes/reports.js`. Maquinaria, exposición, rendimiento y stock aplican sólo los filtros que les corresponden (el
  informe lo aclara en *Notas*). El PDF usa columnas compactas; el Excel/CSV agregan las de detalle.

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
