// Exportación de informes: PDF (pdfkit), Excel (exceljs) y CSV (uno por sección, en zip si son varios)
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const archiver = require('archiver');
const { PassThrough } = require('stream');
const R = require('./reports');

const NUM_TYPES = new Set(['int', 'n1', 'n2', 'n3', 'pct', 'money']);
const XLS_FMT = { int: '#,##0', n1: '#,##0.0', n2: '#,##0.00', n3: '#,##0.000', pct: '0.0" %"', money: '"US$" #,##0.00', date: 'dd/mm/yyyy', dt: 'dd/mm/yyyy hh:mm' };

function fileBase(report) {
  const { from, to } = report.meta.range;
  return `informe-fumigacion_${from}_a_${to}`;
}
function periodText(meta) { return `${R.fmtDate(meta.range.from)} al ${R.fmtDate(meta.range.to)}`; }
function filtersText(meta) { return meta.filterLabels.length ? meta.filterLabels.map(f => `${f.label}: ${f.value}`).join(' · ') : 'Sin filtros (todos los datos del período)'; }
function generatedText(meta) { return `${R.fmtDateTime(meta.generatedAt)} (hora Argentina) por ${meta.generatedBy || '–'}${meta.generatedByRole ? ' (' + meta.generatedByRole + ')' : ''}`; }
// Tablas que van al archivo (en el PDF el resumen va en tarjetas)
const exportTables = (report) => report.tables;

// ---------- CSV ----------
function csvValue(col, v) {
  if (v == null || v === '') return '';
  if (NUM_TYPES.has(col.t) && Number.isFinite(Number(v))) return String(Math.round(Number(v) * 1000) / 1000).replace('.', ',');
  if (col.t === 'date' || col.t === 'dt') return R.fmtCell(col, v);
  const s = String(v);
  return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function tableCsv(t) {
  const cols = R.colsFor(t, 'xls');
  const lines = [cols.map(c => csvValue({}, c.h)).join(';'), ...t.rows.map(r => cols.map(c => csvValue(c, r[c.key])).join(';'))];
  return '\ufeff' + lines.join('\r\n') + '\r\n';
}
function metaCsv(report) {
  const m = report.meta;
  const rows = [['Sistema de Fumigación', 'Informe de seguimiento'], ['Período', periodText(m)], ['Filtros', filtersText(m)],
    ['Secciones', m.sectionTitles.join(', ')], ['Generado', generatedText(m)], [], ['Indicador', 'Valor', 'Detalle'],
    ...report.kpis.map(k => [k.label, R.fmtCell({ t: k.t }, k.value) + (k.unit && k.value != null ? ' ' + k.unit : ''), k.sub || '']),
    ...(m.notes.length ? [[], ['Notas'], ...m.notes.map(n => [n])] : [])];
  return '\ufeff' + rows.map(r => r.map(v => csvValue({}, v)).join(';')).join('\r\n') + '\r\n';
}
// Devuelve { buffer, filename, type }
async function toCsv(report) {
  const tables = exportTables(report).filter(t => t.key !== 'resumen');
  const base = fileBase(report);
  if (tables.length === 1 && !report.meta.sections.includes('resumen')) {
    return { buffer: Buffer.from(tableCsv(tables[0]), 'utf8'), filename: `${base}_${tables[0].key}.csv`, type: 'text/csv; charset=utf-8' };
  }
  const zip = archiver('zip', { zlib: { level: 9 } });
  const out = new PassThrough(); const chunks = [];
  out.on('data', c => chunks.push(c));
  const done = new Promise((res, rej) => { out.on('end', res); zip.on('error', rej); });
  zip.pipe(out);
  zip.append(metaCsv(report), { name: '00_resumen.csv' });
  tables.forEach((t, i) => zip.append(tableCsv(t), { name: `${String(i + 1).padStart(2, '0')}_${t.key}.csv` }));
  await zip.finalize();
  await done;
  return { buffer: Buffer.concat(chunks), filename: `${base}_csv.zip`, type: 'application/zip' };
}

// ---------- Excel ----------
function xlsValue(col, v) {
  if (v == null || v === '') return null;
  if (NUM_TYPES.has(col.t)) { const n = Number(v); return Number.isFinite(n) ? n : null; }
  if (col.t === 'date' || col.t === 'dt') {
    if (col.t === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) { const [y, m, d] = v.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
    const p = R.localParts(v); if (!p) return null;
    return col.t === 'date' ? new Date(Date.UTC(p.y, p.m - 1, p.d)) : new Date(Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi));
  }
  return String(v);
}
function sheetName(title, used) {
  let n = title.replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Hoja';
  let k = 2; const base = n;
  while (used.has(n.toLowerCase())) n = `${base.slice(0, 28)} ${k++}`;
  used.add(n.toLowerCase());
  return n;
}
const SHEETS = { trabajos: 'Trabajos', etapas: 'Etapas', productos: 'Por producto', stock_saldos: 'Stock saldos', stock_movimientos: 'Stock movimientos',
  maquinaria: 'Maquinaria', alertas: 'Alertas', exposicion: 'Exposición', exposicion_detalle: 'Exposición por producto', rendimiento: 'Rendimiento', clima: 'Clima' };
const HEAD_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF18181B' } };
async function toXlsx(report) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sistema de Fumigación'; wb.created = new Date(); wb.title = 'Informe de seguimiento';
  const used = new Set();
  const m = report.meta;
  const ws = wb.addWorksheet(sheetName('Informe', used), { properties: { tabColor: { argb: 'FF10B981' } } });
  ws.columns = [{ width: 34 }, { width: 22 }, { width: 70 }];
  ws.addRow(['Sistema de Fumigación']).font = { bold: true, size: 16 };
  ws.addRow(['Informe de seguimiento']).font = { size: 12, color: { argb: 'FF52525B' } };
  ws.addRow([]);
  for (const [k, v] of [['Período', periodText(m)], ['Filtros', filtersText(m)], ['Secciones', m.sectionTitles.join(', ')], ['Generado', generatedText(m)]]) {
    const r = ws.addRow([k, v]); r.getCell(1).font = { bold: true }; ws.mergeCells(r.number, 2, r.number, 3);
  }
  ws.addRow([]);
  const h = ws.addRow(['Indicador', 'Valor', 'Detalle']);
  h.eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = HEAD_FILL; });
  for (const k of report.kpis) {
    const r = ws.addRow([k.label + (k.unit ? ` (${k.unit})` : ''), k.value, k.sub || '']);
    if (XLS_FMT[k.t]) r.getCell(2).numFmt = XLS_FMT[k.t];
    r.getCell(2).alignment = { horizontal: 'right' };
  }
  if (m.notes.length) { ws.addRow([]); ws.addRow(['Notas']).font = { bold: true }; for (const n of m.notes) { const r = ws.addRow([n]); ws.mergeCells(r.number, 1, r.number, 3); } }

  for (const t of exportTables(report)) {
    if (t.key === 'resumen') continue;
    const cols = R.colsFor(t, 'xls');
    const s = wb.addWorksheet(sheetName(SHEETS[t.key] || t.title, used), { views: [{ state: 'frozen', ySplit: 1 }] });
    s.columns = cols.map(c => {
      const longest = Math.max(c.h.length, ...t.rows.slice(0, 500).map(r => R.fmtCell(c, r[c.key]).length));
      return { header: c.h, key: c.key, width: Math.min(48, Math.max(8, longest + 2)), style: XLS_FMT[c.t] ? { numFmt: XLS_FMT[c.t] } : {} };
    });
    const hr = s.getRow(1);
    hr.eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = HEAD_FILL; c.alignment = { vertical: 'middle', wrapText: true };
      c.border = { bottom: { style: 'medium', color: { argb: 'FF10B981' } } }; });
    hr.height = 30;
    for (const r of t.rows) s.addRow(Object.fromEntries(cols.map(c => [c.key, xlsValue(c, r[c.key])])));
    if (t.rows.length) s.autoFilter = { from: { row: 1, column: 1 }, to: { row: t.rows.length + 1, column: cols.length } };
    else s.addRow([]).getCell(1).value = 'Sin datos para el período y los filtros elegidos';
  }
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, filename: `${fileBase(report)}.xlsx`, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
}

// ---------- PDF ----------
const WINANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
const REPL = { '→': '->', '←': '<-', '≥': '>=', '≤': '<=', '×': 'x', '÷': '/', '≈': '~', '\u00a0': ' ', '\u202f': ' ' };
function san(s) {
  return String(s == null ? '' : s).replace(/[^\u0000-\u00ff]/g, ch => REPL[ch] != null ? REPL[ch] : (WINANSI_EXTRA.includes(ch) ? ch : (ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\u0000-\u00ff]/g, '') || '?')));
}
const C = { ink: '#18181b', muted: '#52525b', soft: '#a1a1aa', line: '#e4e4e7', zebra: '#f4f4f5', head: '#27272a', accent: '#059669', accentFill: '#10b981' };

function toPdf(report) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margins: { top: 64, bottom: 42, left: 32, right: 32 }, bufferPages: true,
      info: { Title: 'Sistema de Fumigación - Informe de seguimiento', Author: 'Sistema de Fumigación', Subject: periodText(report.meta) } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve({ buffer: Buffer.concat(chunks), filename: `${fileBase(report)}.pdf`, type: 'application/pdf' }));
    doc.on('error', reject);
    try { drawReport(doc, report); doc.end(); } catch (e) { reject(e); }
  });
}

function drawReport(doc, report) {
  const m = report.meta;
  const L = doc.page.margins.left, W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const header = () => {
    const y = 24;
    doc.save();
    doc.rect(L, y - 2, 4, 26).fill(C.accentFill);
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(14).text(san('Sistema de Fumigación'), L + 12, y - 1, { lineBreak: false });
    doc.fillColor(C.muted).font('Helvetica').fontSize(8.5).text(san('Informe de seguimiento'), L + 12, y + 15, { lineBreak: false });
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(9).text(san('Período: ' + periodText(m)), L, y, { width: W, align: 'right', lineBreak: false });
    doc.fillColor(C.muted).font('Helvetica').fontSize(7.5).text(san(filtersText(m)), L + W / 2, y + 14, { width: W / 2, align: 'right', lineBreak: false, ellipsis: true, height: 10 });
    doc.moveTo(L, y + 30).lineTo(L + W, y + 30).lineWidth(0.6).strokeColor(C.line).stroke();
    doc.restore();
    doc.x = L; doc.y = doc.page.margins.top;
  };
  doc.on('pageAdded', header);
  header();
  const ensure = (h) => { if (doc.y + h > bottom()) doc.addPage(); };

  // Bloque de datos del informe
  const metaRows = [['Período', periodText(m)], ['Filtros', filtersText(m)], ['Secciones', m.sectionTitles.join(', ')], ['Generado', generatedText(m)]];
  doc.font('Helvetica-Bold').fontSize(16).fillColor(C.ink).text(san('Informe de seguimiento'), L, doc.y);
  doc.moveDown(0.3);
  for (const [k, v] of metaRows) {
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.muted).text(san(k), L, y, { width: 70 });
    doc.font('Helvetica').fontSize(8.5).fillColor(C.ink).text(san(v), L + 72, y, { width: W - 72 });
    doc.y = Math.max(doc.y, y + 12);
  }
  if (m.notes.length) {
    doc.moveDown(0.3);
    for (const n of m.notes) doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(C.muted).text(san('• ' + n), L, doc.y, { width: W });
  }
  doc.moveDown(0.8);

  // KPIs en tarjetas
  if (m.sections.includes('resumen')) {
    sectionTitle(doc, 'Resumen KPIs', L, W, ensure);
    const per = 4, gap = 8, bw = (W - gap * (per - 1)) / per, bh = 56;
    let rowY = doc.y;
    report.kpis.forEach((k, i) => {
      if (i % per === 0) { if (i) doc.y = rowY + bh + gap; ensure(bh); rowY = doc.y; }
      const x = L + (i % per) * (bw + gap), y = rowY;
      doc.roundedRect(x, y, bw, bh, 4).lineWidth(0.6).fillAndStroke('#fafafa', C.line);
      doc.fillColor(C.muted).font('Helvetica').fontSize(7).text(san(k.label.toUpperCase()), x + 8, y + 7, { width: bw - 16, height: 9, ellipsis: true });
      const val = k.value == null ? '–' : R.fmtCell({ t: k.t }, k.value) + (k.unit ? ' ' + k.unit : '');
      doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(15).text(san(val), x + 8, y + 18, { width: bw - 16, lineBreak: false });
      doc.fillColor(C.muted).font('Helvetica').fontSize(6.8).text(san(k.sub || ''), x + 8, y + 38, { width: bw - 16, height: 16, ellipsis: true });
    });
    doc.y = rowY + bh;
    doc.y += 14;
  }

  for (const t of report.tables) {
    if (t.key === 'resumen') continue;
    drawTable(doc, t, L, W, ensure, bottom);
    if (t.key === 'trabajos' && report.maps.length) drawMaps(doc, report.maps, L, W, ensure);
  }

  // Pie: fecha de generación y numeración
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const old = doc.page.margins.bottom; doc.page.margins.bottom = 0;
    const y = doc.page.height - 26;
    doc.moveTo(L, y - 6).lineTo(L + W, y - 6).lineWidth(0.5).strokeColor(C.line).stroke();
    doc.font('Helvetica').fontSize(7).fillColor(C.soft)
      .text(san(`Sistema de Fumigación · Generado el ${generatedText(m)}`), L, y, { width: W * 0.75, lineBreak: false })
      .text(san(`Página ${i - range.start + 1} de ${range.count}`), L, y, { width: W, align: 'right', lineBreak: false });
    doc.page.margins.bottom = old;
  }
}

function sectionTitle(doc, title, L, W, ensure, extra) {
  ensure(60);
  doc.font('Helvetica-Bold').fontSize(11.5).fillColor(C.ink).text(san(title), L, doc.y, { continued: !!extra });
  if (extra) doc.font('Helvetica').fontSize(8).fillColor(C.muted).text(san('  ' + extra));
  doc.moveTo(L, doc.y + 1).lineTo(L + 40, doc.y + 1).lineWidth(1.5).strokeColor(C.accentFill).stroke();
  doc.y += 6;
}

const PDF_MAX_ROWS = 1500;
function drawTable(doc, t, L, W, ensure, bottom) {
  const cols = R.colsFor(t, 'pdf');
  const total = cols.reduce((s, c) => s + (c.w || 1), 0);
  const widths = cols.map(c => W * (c.w || 1) / total);
  const fs = cols.length > 12 ? 6.6 : 7.4, pad = 3;
  sectionTitle(doc, t.title, L, W, ensure, `${t.rows.length} ${t.rows.length === 1 ? 'fila' : 'filas'}`);
  const rowH = (cells, font) => {
    doc.font(font).fontSize(fs);
    return Math.max(...cells.map((s, i) => doc.heightOfString(s || ' ', { width: widths[i] - pad * 2 }))) + pad * 2;
  };
  const head = cols.map(c => san(c.h));
  const drawHead = () => {
    const h = rowH(head, 'Helvetica-Bold');
    const y = doc.y;
    doc.rect(L, y, W, h).fill(C.head);
    let x = L;
    doc.font('Helvetica-Bold').fontSize(fs).fillColor('#ffffff');
    cols.forEach((c, i) => { doc.text(head[i], x + pad, y + pad, { width: widths[i] - pad * 2, align: NUM_TYPES.has(c.t) ? 'right' : 'left' }); x += widths[i]; });
    doc.y = y + h;
  };
  if (!t.rows.length) {
    doc.font('Helvetica-Oblique').fontSize(8).fillColor(C.muted).text(san('Sin datos para el período y los filtros elegidos.'), L, doc.y);
    doc.y += 14; return;
  }
  ensure(40);
  drawHead();
  const rows = t.rows.slice(0, PDF_MAX_ROWS);
  rows.forEach((r, ri) => {
    const cells = cols.map(c => san(R.fmtCell(c, r[c.key])));
    const h = rowH(cells, 'Helvetica');
    if (doc.y + h > bottom()) {
      doc.addPage();
      doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(C.muted).text(san(`${t.title} (continuación)`), L, doc.y);
      doc.y += 3; drawHead();
    }
    const y = doc.y;
    if (ri % 2 === 1) doc.rect(L, y, W, h).fill(C.zebra);
    doc.moveTo(L, y + h).lineTo(L + W, y + h).lineWidth(0.3).strokeColor(C.line).stroke();
    let x = L;
    doc.font('Helvetica').fontSize(fs).fillColor(C.ink);
    cols.forEach((c, i) => { doc.text(cells[i], x + pad, y + pad, { width: widths[i] - pad * 2, align: NUM_TYPES.has(c.t) ? 'right' : 'left' }); x += widths[i]; });
    doc.y = y + h;
  });
  if (t.rows.length > PDF_MAX_ROWS) doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(C.muted).text(san(`Se muestran ${PDF_MAX_ROWS} de ${t.rows.length} filas; el Excel y el CSV tienen todas.`), L, doc.y + 2);
  doc.y += 16;
}

// Miniaturas vectoriales: lote (gris), zona cubierta (verde) y recorrido GPS (línea oscura)
function drawMaps(doc, maps, L, W, ensure) {
  sectionTitle(doc, 'Mapas de cobertura', L, W, ensure, 'lote en gris · zona cubierta en verde · recorrido GPS en negro');
  const per = 5, gap = 10, bw = (W - gap * (per - 1)) / per, mh = 92, ch = 26, bh = mh + ch;
  let rowY = doc.y;
  maps.forEach((mp, i) => {
    if (i % per === 0) { if (i) doc.y = rowY + bh + gap; ensure(bh); rowY = doc.y; }
    const x = L + (i % per) * (bw + gap), y = rowY;
    doc.roundedRect(x, y, bw, bh, 3).lineWidth(0.5).fillAndStroke('#ffffff', C.line);
    drawGeoThumb(doc, mp, x + 5, y + 5, bw - 10, mh - 8);
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(7.2).text(san(`#${mp.id} ${mp.lot}`), x + 6, y + mh, { width: bw - 12, height: 9, ellipsis: true });
    const cov = mp.coveragePct != null ? `${R.fmtNum(mp.coveragePct, 1)} % zona · ${R.fmtNum(mp.coveredHa, 2)} de ${R.fmtNum(mp.areaHa, 2)} ha` : `Sin cobertura · ${R.fmtNum(mp.areaHa, 2)} ha`;
    doc.fillColor(C.muted).font('Helvetica').fontSize(6.6).text(san(cov), x + 6, y + mh + 10, { width: bw - 12, height: 9, ellipsis: true });
  });
  doc.y = rowY + bh;
  doc.y += 16;
}
function projector(bbox, x, y, w, h) {
  const [minX, minY, maxX, maxY] = bbox;
  const k = Math.cos(((minY + maxY) / 2) * Math.PI / 180) || 1;
  const gw = Math.max((maxX - minX) * k, 1e-9), gh = Math.max(maxY - minY, 1e-9);
  const s = Math.min(w / gw, h / gh) * 0.92;
  const ox = x + (w - gw * s) / 2, oy = y + (h - gh * s) / 2;
  return ([lng, lat]) => [ox + (lng - minX) * k * s, oy + (maxY - lat) * s];
}
function polys(g) { if (!g) return []; if (g.type === 'Polygon') return [g.coordinates]; if (g.type === 'MultiPolygon') return g.coordinates; return []; }
function lines(g) { if (!g) return []; if (g.type === 'LineString') return [g.coordinates]; if (g.type === 'MultiLineString') return g.coordinates; return []; }
function drawGeoThumb(doc, mp, x, y, w, h) {
  if (!mp.bbox) { doc.fillColor(C.soft).fontSize(7).text('Sin geometría', x, y + h / 2 - 4, { width: w, align: 'center' }); return; }
  const P = projector(mp.bbox, x, y, w, h);
  const pathPolys = (g) => { for (const poly of polys(g)) for (const ring of poly) ring.forEach((c, i) => { const [px, py] = P(c); if (i) doc.lineTo(px, py); else doc.moveTo(px, py); }), doc.closePath(); };
  doc.save();
  pathPolys(mp.zone); doc.lineWidth(0.6).fillOpacity(1).fillColor('#f4f4f5').strokeColor('#71717a').fillAndStroke('#f4f4f5', '#71717a', 'even-odd');
  if (polys(mp.covered).length) { pathPolys(mp.covered); doc.fillColor(C.accentFill).fillOpacity(0.6).fill('even-odd'); doc.fillOpacity(1); }
  for (const ln of lines(mp.track)) {
    ln.forEach((c, i) => { const [px, py] = P(c); if (i) doc.lineTo(px, py); else doc.moveTo(px, py); });
    doc.lineWidth(0.45).strokeOpacity(0.85).strokeColor(C.ink).stroke();
  }
  doc.restore();
}

module.exports = { toPdf, toXlsx, toCsv, fileBase };
