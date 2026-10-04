// Importación de establecimientos y cuadros desde CSV / Excel con las columnas de la declaración SENASA
// (establecimiento, RENSPA, UP, cuadro, especie, variedad, año, distancias, plantas, ha) y plantilla descargable.
const ExcelJS = require('exceljs');
const db = require('./db');
const C = require('../chacras-core');
const Ch = require('./chacras');

// Columnas: clave → títulos aceptados (normalizados). Las primeras 11 son las de la declaración SENASA.
const COLUMNS = [
  { key: 'establecimiento', h: 'Establecimiento', alias: ['establecimiento', 'chacra', 'finca', 'nombre establecimiento', 'establecimiento chacra'], req: true },
  { key: 'renspa', h: 'RENSPA', alias: ['renspa', 'n renspa', 'nro renspa'] },
  { key: 'up', h: 'UP', alias: ['up', 'codigo up', 'cod up', 'unidad productiva', 'up sigtraza'] },
  { key: 'cuadro', h: 'Cuadro', alias: ['cuadro', 'lote', 'bloque', 'cuadro lote', 'nombre cuadro'], req: true },
  { key: 'especie', h: 'Especie', alias: ['especie', 'cultivo'] },
  { key: 'variedad', h: 'Variedad', alias: ['variedad'] },
  { key: 'anio', h: 'Año', alias: ['ano', 'anio', 'ano plantacion', 'ano de plantacion', 'anio plantacion', 'año'] },
  { key: 'distFilas', h: 'Distancia filas (m)', alias: ['distancia filas', 'distancia filas m', 'dist filas', 'distancia entre filas', 'entre filas', 'distancia entre filas m'] },
  { key: 'distPlantas', h: 'Distancia plantas (m)', alias: ['distancia plantas', 'distancia plantas m', 'dist plantas', 'distancia entre plantas', 'entre plantas', 'distancia entre plantas m'] },
  { key: 'plantas', h: 'Plantas', alias: ['plantas', 'n plantas', 'nro plantas', 'numero de plantas', 'cantidad de plantas', 'cantidad plantas'] },
  { key: 'ha', h: 'Ha', alias: ['ha', 'has', 'hectareas', 'superficie', 'superficie ha', 'sup ha', 'sup'] },
  { key: 'empresa', h: 'Empresa', alias: ['empresa', 'cliente', 'razon social'] },
  { key: 'productor', h: 'Productor', alias: ['productor', 'titular'] },
  { key: 'localidad', h: 'Localidad', alias: ['localidad'] },
  { key: 'provincia', h: 'Provincia', alias: ['provincia'] },
  { key: 'clon', h: 'Clon / selección', alias: ['clon', 'seleccion', 'clon seleccion'] },
  { key: 'portainjerto', h: 'Portainjerto', alias: ['portainjerto', 'pie', 'porta injerto'] },
  { key: 'conduccion', h: 'Sistema de conducción', alias: ['sistema de conduccion', 'conduccion', 'sistema conduccion'] },
  { key: 'altura', h: 'Altura de copa (m)', alias: ['altura de copa', 'altura copa', 'altura de copa m', 'altura'] },
  { key: 'ancho', h: 'Ancho de copa (m)', alias: ['ancho de copa', 'ancho copa', 'ancho de copa m', 'ancho'] },
  { key: 'riego', h: 'Riego', alias: ['riego', 'sistema de riego'] },
  { key: 'malla', h: 'Malla antigranizo', alias: ['malla', 'malla antigranizo', 'antigranizo'] },
  { key: 'orientacion', h: 'Orientación filas', alias: ['orientacion', 'orientacion filas', 'orientacion de filas'] },
  { key: 'notas', h: 'Notas', alias: ['notas', 'observaciones', 'obs'] }
];
const ALIAS = new Map();
for (const c of COLUMNS) for (const a of c.alias) ALIAS.set(C.norm(a), c.key);

const EXAMPLE_ROWS = [
  ['EJEMPLO – Chacra La Esperanza', '00.000.0.00000/00', 'UP-0001', 'Cuadro 1', 'Pera', 'Williams', 2008, 4, 2, 2500, 2, 'EJEMPLO S.A.', '', 'Cipolletti', 'Río Negro', '', 'Franco de peral', 'Eje central', 3.5, 2, 'Gravitacional', 'No', 'E-O', 'Fila de ejemplo: borrala o reemplazala'],
  ['EJEMPLO – Chacra La Esperanza', '00.000.0.00000/00', 'UP-0002', 'Cuadro 2', 'Manzana', 'Red Delicious', 2012, 4, 1.5, 4000, 2.4, 'EJEMPLO S.A.', '', 'Cipolletti', 'Río Negro', 'Red Chief', 'MM111', 'Espaldera', 3.2, 1.8, 'Aspersión', 'Sí', 'N-S', 'Fila de ejemplo: borrala o reemplazala']
];

async function templateXlsx() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sistema de Fumigación';
  const ws = wb.addWorksheet('Cuadros', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = COLUMNS.map(c => ({ header: c.h, key: c.key, width: Math.max(12, c.h.length + 4) }));
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF047857' } };
  for (const r of EXAMPLE_ROWS) ws.addRow(r);
  for (let i = 2; i <= 1 + EXAMPLE_ROWS.length; i++) ws.getRow(i).font = { italic: true, color: { argb: 'FF6B7280' } };
  const help = wb.addWorksheet('Instrucciones');
  help.columns = [{ header: 'Columna', key: 'c', width: 26 }, { header: 'Obligatoria', key: 'r', width: 12 }, { header: 'Qué poner', key: 'd', width: 100 }];
  help.getRow(1).font = { bold: true };
  const desc = {
    establecimiento: 'Nombre de la chacra / establecimiento. Las filas con el mismo nombre (o el mismo RENSPA) van al mismo establecimiento.',
    renspa: 'N° de RENSPA del establecimiento (SENASA).', up: 'Código de Unidad Productiva de SIGTraza (por cuadro / variedad).',
    cuadro: 'Nombre o número del cuadro. Si ya existe en ese establecimiento se actualiza; si no, se crea.',
    especie: 'Pera, Manzana, Cereza, Durazno, Pelón/Nectarina, Ciruela, Damasco, Membrillo, Nogal, Almendro, Vid.',
    variedad: 'Como figura en la declaración (Williams, Packham\'s Triumph, Red Delicious, Gala…). Se busca también por sinónimos.',
    anio: 'Año de plantación (4 cifras).', distFilas: 'Distancia entre filas en metros (ej. 4).', distPlantas: 'Distancia entre plantas en metros (ej. 1,5).',
    plantas: 'Número de plantas del cuadro (si falta, se calcula con el marco y la superficie).',
    ha: 'Superficie del cuadro en hectáreas. Si después se dibuja el polígono, este valor declarado sigue mandando.',
    empresa: 'Empresa / cliente dueño (opcional, ej. Kleppe).', malla: 'Sí / No.', orientacion: 'N-S, E-O, NE-SO o NO-SE.',
    altura: 'Altura de copa (m): con el ancho y la distancia entre filas se calcula el TRV y el caldo sugerido.', ancho: 'Ancho de copa (m).'
  };
  for (const c of COLUMNS) help.addRow({ c: c.h, r: c.req ? 'Sí' : '', d: desc[c.key] || '' });
  help.addRow({});
  help.addRow({ c: 'Notas', d: 'Se importa la hoja "Cuadros" (o la primera). Los encabezados pueden estar en otro orden y con otros nombres parecidos (ej. "Distancia entre filas").' });
  help.addRow({ c: '', d: 'Los polígonos de los cuadros no se importan: se dibujan después en el mapa (Chacras → establecimiento → cuadro → Dibujar).' });
  help.addRow({ c: '', d: 'Las filas de ejemplo (establecimiento que empieza con "EJEMPLO") se importan marcadas como ejemplo y se borran con "Borrar datos de ejemplo".' });
  return wb.xlsx.writeBuffer();
}
function templateCsv() {
  const esc = (v) => { const s = v == null ? '' : String(v); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [COLUMNS.map(c => c.h), ...EXAMPLE_ROWS.map(r => r.map(v => typeof v === 'number' ? String(v).replace('.', ',') : v))];
  return '\uFEFF' + lines.map(l => l.map(esc).join(';')).join('\r\n') + '\r\n';
}

// ---------- lectura ----------
function parseCsv(textIn) {
  const text = String(textIn || '').replace(/^\uFEFF/, '');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const delim = [';', '\t', ','].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}
async function parseXlsx(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.getWorksheet('Cuadros') || wb.worksheets[0];
  if (!ws) return [];
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (r) => {
    const vals = [];
    for (let i = 1; i <= Math.max(r.cellCount, COLUMNS.length + 6); i++) {
      let v = r.getCell(i).value;
      if (v && typeof v === 'object') v = v.result != null ? v.result : (v.text != null ? v.text : (v.richText ? v.richText.map(t => t.text).join('') : (v instanceof Date ? v.toISOString().slice(0, 10) : String(v))));
      vals.push(v == null ? '' : v);
    }
    rows.push(vals);
  });
  return rows;
}
// Encabezado = primera fila (de las primeras 10) con al menos 3 columnas reconocidas
function mapHeader(rows) {
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const map = {};
    rows[i].forEach((h, k) => { const key = ALIAS.get(C.norm(h)); if (key && map[key] === undefined) map[key] = k; });
    if (Object.keys(map).length >= 3) return { index: i, map };
  }
  return null;
}
const numAr = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  let s = String(v).trim().replace(/\s/g, '');
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); // 1.250,5
  else s = s.replace(',', '.');
  const x = Number(s); return Number.isFinite(x) ? x : NaN;
};

// Arma el plan de importación (sin escribir) y, si apply, lo ejecuta en una transacción
async function importRows(rows, { apply, userId } = {}) {
  const head = mapHeader(rows);
  if (!head) return { error: 'No se encontró la fila de encabezados (Establecimiento, Cuadro, Especie, Variedad, …). Usá la plantilla.' };
  const missing = COLUMNS.filter(c => c.req && head.map[c.key] === undefined).map(c => c.h);
  if (missing.length) return { error: 'Faltan columnas obligatorias: ' + missing.join(', ') };
  const cat = await Ch.catalog();
  const cultByName = new Map(cat.cultivos.map(c => [c.nombre, c]));
  const findVar = (cultivoId, name) => {
    const k = C.norm(name); if (!k) return null;
    return cat.variedades.find(v => v.cultivoId === cultivoId && (C.norm(v.nombre) === k || (v.sinonimos || []).some(s => C.norm(s) === k))) || null;
  };
  const findPi = (cultivo, name) => {
    const k = C.norm(name); if (!k) return null;
    const list = cat.portainjertos.filter(p => C.norm(p.nombre) === k || (p.sinonimos || []).some(s => C.norm(s) === k) || C.norm(p.nombre).split(' ').includes(k));
    return list.find(p => cultivo && p.especie.split('/').some(e => cultivo.startsWith(e))) || list[0] || null;
  };
  const { rows: ests } = await db.query('SELECT id, nombre, renspa FROM establecimientos');
  const estKey = new Map();
  for (const e of ests) { estKey.set('n:' + C.norm(e.nombre), Number(e.id)); if (e.renspa) estKey.set('r:' + C.norm(e.renspa), Number(e.id)); }
  const { rows: cus } = await db.query('SELECT id, establecimiento_id, nombre FROM cuadros WHERE deleted_at IS NULL');
  const cuadKey = new Map(cus.map(c => [Number(c.establecimiento_id) + '|' + C.norm(c.nombre), Number(c.id)]));

  const plan = [];
  const newEsts = new Map(); // clave → datos del establecimiento nuevo
  const newAlias = new Map();
  for (let i = head.index + 1; i < rows.length; i++) {
    const r = rows[i];
    const g = (k) => head.map[k] === undefined ? '' : String(r[head.map[k]] == null ? '' : r[head.map[k]]).trim();
    const raw = (k) => head.map[k] === undefined ? null : r[head.map[k]];
    const estName = g('establecimiento'), cuadro = g('cuadro');
    if (!estName && !cuadro && !g('variedad')) continue;
    const item = { line: i + 1, establecimiento: estName, renspa: g('renspa') || null, cuadro, warnings: [], errors: [] };
    if (!estName) item.errors.push('Falta el establecimiento');
    if (!cuadro) item.errors.push('Falta el cuadro');
    const keyR = item.renspa ? 'r:' + C.norm(item.renspa) : null, keyN = 'n:' + C.norm(estName);
    let estId = (keyR && estKey.get(keyR)) || estKey.get(keyN) || null;
    item.estAction = estId ? 'existente' : 'crear';
    item.estId = estId;
    // Un establecimiento nuevo se reconoce por RENSPA o por nombre (filas sin RENSPA del mismo establecimiento)
    item.estKey = estId ? 'id:' + estId : ((keyR && newAlias.get(keyR)) || newAlias.get(keyN) || keyR || keyN);
    if (!estId && estName) { if (keyR) newAlias.set(keyR, item.estKey); newAlias.set(keyN, item.estKey); }
    if (!estId && estName && !newEsts.has(item.estKey)) {
      newEsts.set(item.estKey, { nombre: estName, renspa: item.renspa, localidad: g('localidad') || null, provincia: g('provincia') || null,
        productor: g('productor') || null, empresa: g('empresa') || null, example: /^ejemplo\b/i.test(C.norm(estName)) });
    }
    // Cultivo / variedad
    const esp = g('especie');
    const cultName = esp ? (C.especieToCultivo(esp) || (cultByName.has(esp) ? esp : null)) : null;
    const cult = cultName ? cultByName.get(cultName) : null;
    if (esp && !cult) item.warnings.push(`Especie "${esp}" no reconocida: queda sin cultivo`);
    item.cultivoId = cult ? cult.id : null; item.cultivo = cult ? cult.nombre : null;
    const vName = g('variedad');
    const v = cult && vName ? findVar(cult.id, vName) : null;
    item.variedadId = v ? v.id : null; item.variedad = v ? v.nombre : (vName || null);
    if (vName && !v) item.warnings.push(`Variedad "${vName}" no está en el catálogo: se guarda como texto`);
    const piName = g('portainjerto');
    const pi = piName ? findPi(cult ? cult.nombre : null, piName) : null;
    item.portainjertoId = pi ? pi.id : null; item.portainjerto = pi ? pi.nombre : (piName || null);
    // Números
    const fields = { anio: [1900, new Date().getFullYear() + 1, 'Año'], distFilas: [0.5, 15, 'Distancia filas'], distPlantas: [0.2, 15, 'Distancia plantas'],
      plantas: [1, 10000000, 'Plantas'], ha: [0.001, 5000, 'Ha'], altura: [0.3, 12, 'Altura de copa'], ancho: [0.2, 12, 'Ancho de copa'] };
    item.values = {};
    for (const [k, [min, max, label]] of Object.entries(fields)) {
      const x = numAr(raw(k));
      if (x == null) continue;
      if (Number.isNaN(x) || x < min || x > max) { item.warnings.push(`${label} "${g(k)}" fuera de rango: no se carga`); continue; }
      item.values[k] = k === 'anio' || k === 'plantas' ? Math.round(x) : x;
    }
    const pha = C.plantsPerHa(item.values.distFilas, item.values.distPlantas);
    if (pha && item.values.ha && item.values.plantas) {
      const calc = pha * item.values.ha, diff = Math.abs(calc - item.values.plantas) / item.values.plantas;
      if (diff > 0.25) item.warnings.push(`Plantas declaradas (${item.values.plantas}) muy distintas de las calculadas por marco y superficie (${Math.round(calc)})`);
    }
    item.text = { up: g('up') || null, clon: g('clon') || null, conduccion: g('conduccion') || null, riego: g('riego') || null,
      orientacion: g('orientacion') || null, notas: g('notas') || null };
    item.malla = g('malla') ? /^(s|si|sí|x|1|true|yes)$/i.test(g('malla')) : null;
    item.cuadroId = estId ? (cuadKey.get(estId + '|' + C.norm(cuadro)) || null) : null;
    item.action = item.errors.length ? 'error' : (item.cuadroId ? 'actualizar' : 'crear');
    plan.push(item);
  }
  // Cuadros repetidos en el archivo
  const seen = new Map();
  for (const it of plan) {
    if (it.action === 'error') continue;
    const k = it.estKey + '|' + C.norm(it.cuadro);
    if (seen.has(k)) { it.errors.push(`Cuadro repetido (ya está en la fila ${seen.get(k)})`); it.action = 'error'; } else seen.set(k, it.line);
  }
  const summary = {
    filas: plan.length, establecimientosNuevos: newEsts.size,
    establecimientosExistentes: new Set(plan.filter(p => p.estAction === 'existente').map(p => p.estId)).size,
    cuadrosNuevos: plan.filter(p => p.action === 'crear').length, cuadrosActualizados: plan.filter(p => p.action === 'actualizar').length,
    errores: plan.filter(p => p.action === 'error').length, avisos: plan.reduce((s, p) => s + p.warnings.length, 0)
  };
  const preview = plan.map(p => ({ line: p.line, establecimiento: p.establecimiento, estAction: p.estAction, cuadro: p.cuadro, action: p.action,
    cultivo: p.cultivo, variedad: p.variedad, portainjerto: p.portainjerto, ha: p.values.ha ?? null, anio: p.values.anio ?? null,
    marco: p.values.distFilas && p.values.distPlantas ? `${p.values.distFilas} × ${p.values.distPlantas} m` : null, warnings: p.warnings, errors: p.errors }));
  if (!apply) return { ok: true, applied: false, summary, rows: preview };
  if (summary.errores) return { error: `Hay ${summary.errores} fila(s) con errores: corregilas antes de importar`, summary, rows: preview };

  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    const estIds = new Map();
    for (const [k, e] of newEsts) {
      const empresaId = e.empresa ? await Ch.ensureEmpresa(client, e.empresa, e.example) : null;
      const { rows: [r] } = await client.query(
        `INSERT INTO establecimientos (nombre, renspa, localidad, provincia, productor, empresa_id, example, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [e.nombre, e.renspa, e.localidad, e.provincia, e.productor, empresaId, e.example, userId]);
      estIds.set(k, Number(r.id));
    }
    for (const it of plan) {
      const estId = it.estId || estIds.get(it.estKey);
      const v = it.values, t = it.text;
      const cols = {
        nombre: it.cuadro, codigo_up: t.up, cultivo_id: it.cultivoId, variedad_id: it.variedadId, variedad_texto: it.variedadId ? null : it.variedad,
        clon: t.clon, portainjerto_id: it.portainjertoId, portainjerto_texto: it.portainjertoId ? null : it.portainjerto,
        anio_plantacion: v.anio ?? null, dist_filas_m: v.distFilas ?? null, dist_plantas_m: v.distPlantas ?? null, plantas_manual: v.plantas ?? null,
        ha_manual: v.ha ?? null, sistema_conduccion: t.conduccion, altura_copa_m: v.altura ?? null, ancho_copa_m: v.ancho ?? null,
        riego: t.riego, malla_antigranizo: it.malla, orientacion_filas: t.orientacion, notas: t.notas
      };
      if (it.cuadroId) {
        // Actualizar: sólo pisa lo que vino en el archivo
        const sets = [], params = [];
        for (const [c, val] of Object.entries(cols)) { if (val == null || c === 'nombre') continue; params.push(val); sets.push(`${c} = $${params.length}`); }
        if (sets.length) { params.push(it.cuadroId); await client.query(`UPDATE cuadros SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`, params); }
      } else {
        const keys = Object.keys(cols);
        const ex = /^ejemplo\b/i.test(C.norm(it.establecimiento));
        await client.query(
          `INSERT INTO cuadros (establecimiento_id, ${keys.join(', ')}, example, created_by) VALUES ($1, ${keys.map((_, i) => '$' + (i + 2)).join(', ')}, $${keys.length + 2}, $${keys.length + 3})`,
          [estId, ...keys.map(k => cols[k]), ex, userId]);
      }
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  return { ok: true, applied: true, summary, rows: preview };
}

async function parseUpload(body) {
  const b = body || {};
  const name = String(b.filename || '').toLowerCase();
  if (b.text != null && !/\.xlsx$/.test(name)) return parseCsv(b.text);
  if (!b.base64) throw Object.assign(new Error('Elegí un archivo CSV o Excel (.xlsx)'), { status: 400 });
  const buf = Buffer.from(String(b.base64), 'base64');
  if (/\.xlsx$/.test(name) || buf.slice(0, 2).toString() === 'PK') return parseXlsx(buf);
  return parseCsv(buf.toString('utf8'));
}

module.exports = { COLUMNS, templateXlsx, templateCsv, parseCsv, parseXlsx, parseUpload, importRows };
