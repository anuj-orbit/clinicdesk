// In-memory booking audit log (dev/test). Mirrors src/data/mongo/audit.js output exactly.

function clampLimit(limit) {
  if (limit === undefined || limit === null || limit === "") return 100;
  const n = Math.floor(Number(limit));
  if (!Number.isFinite(n)) return 100;
  return Math.min(Math.max(n, 1), 500);
}

function toDate(value) {
  if (value === undefined || value === null || value === "") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toNumberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clone(value) {
  return value === undefined || value === null ? null : structuredClone(value);
}

export function memoryAuditRepo() {
  const entries = [];
  let seq = 0;

  function toEntry(e) {
    return {
      id: e.id,
      action: e.action,
      bookingId: e.bookingId,
      at: e.at.toISOString(),
      actor: clone(e.actor),
      doctorId: e.doctorId,
      patientId: e.patientId,
      slotStart: e.slotStart ? e.slotStart.toISOString() : null,
      before: clone(e.before),
      after: clone(e.after),
      meta: clone(e.meta),
    };
  }

  return {
    async record(event = {}) {
      seq += 1;
      const entry = {
        id: String(seq),
        seq,
        action: event.action,
        bookingId: toNumberOrNull(event.bookingId),
        at: toDate(event.at) ?? new Date(),
        actor: clone(event.actor),
        doctorId: toNumberOrNull(event.doctorId),
        patientId: toNumberOrNull(event.patientId),
        slotStart: toDate(event.slotStart),
        before: clone(event.before),
        after: clone(event.after),
        meta: clone(event.meta),
      };
      entries.push(entry);
      return toEntry(entry);
    },

    async list({ bookingId, limit } = {}) {
      let filtered = entries;
      if (bookingId !== undefined && bookingId !== null && bookingId !== "") {
        const n = Number(bookingId);
        if (!Number.isFinite(n)) return [];
        filtered = filtered.filter((e) => e.bookingId === n);
      }
      return [...filtered]
        .sort((a, b) => b.at.getTime() - a.at.getTime() || b.seq - a.seq)
        .slice(0, clampLimit(limit))
        .map(toEntry);
    },
  };
}
