// Helpers de trabajos de aplicación (formato JSON y validación de la fórmula).

function jobToJson(j) {
  if (!j) return null;
  const out = {
    id: Number(j.id),
    zoneId: Number(j.zone_id),
    applicatorId: j.applicator_id != null ? Number(j.applicator_id) : null,
    machine: j.machine, deviceId: j.device_id, lotName: j.lot_name,
    product: j.product, dose: j.dose != null ? Number(j.dose) : null, doseUnit: j.dose_unit,
    litersPerHa: j.liters_per_ha != null ? Number(j.liters_per_ha) : null,
    scheduledDate: j.scheduled_date, notes: j.notes,
    status: j.status,
    createdAt: j.created_at, startedAt: j.started_at, finishedAt: j.finished_at
  };
  // Campos opcionales que vienen de JOINs
  if (j.applicator_username !== undefined) {
    out.applicator = j.applicator_id != null
      ? { id: Number(j.applicator_id), username: j.applicator_username, name: j.applicator_name }
      : null;
  }
  if (j.geometry !== undefined) out.geometry = j.geometry;
  if (j.point_count !== undefined) out.pointCount = j.point_count;
  if (j.last_point_at !== undefined) out.lastPointAt = j.last_point_at;
  return out;
}

// Datos del trabajo (fórmula, máquina, etc.). Los campos vacíos quedan en null.
function parseJobInput(input) {
  const j = (input && typeof input === 'object') ? input : {};
  const text = (v) => (v == null || v === '') ? null : String(v).trim().slice(0, 500) || null;
  const number = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const date = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) ? v : null;
  return {
    machine: text(j.machine), deviceId: text(j.deviceId), lotName: text(j.lotName),
    product: text(j.product), dose: number(j.dose), doseUnit: text(j.doseUnit),
    litersPerHa: number(j.litersPerHa), scheduledDate: date(j.scheduledDate), notes: text(j.notes)
  };
}

const JOB_STATUSES = ['pendiente', 'en_curso', 'finalizado', 'cancelado'];

module.exports = { jobToJson, parseJobInput, JOB_STATUSES };
