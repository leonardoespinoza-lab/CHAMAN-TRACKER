// Bus de eventos en memoria para el seguimiento en vivo (SSE).
// Con una sola instancia alcanza; además el stream consulta la base periódicamente,
// así que si hubiera varias instancias igual se ponen al día.
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(0);

function emitJob(jobId, type, data) {
  bus.emit('job:' + jobId, { type, data });
}

module.exports = { bus, emitJob };
