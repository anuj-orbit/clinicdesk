// MongoDB booking audit log (append-only). See PLAN.md §4.2.

function clampLimit(limit) {
  if (limit === undefined || limit === null || limit === "") return 100;
  const n = Math.floor(Number(limit));
  if (!Number.isFinite(n)) return 100;
  return Math.min(Math.max(n, 1), 500);
}

function toIso(value) {
  if (value === undefined || value === null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
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

function toEntry(doc) {
  return {
    id: doc._id.toHexString(),
    action: doc.action,
    bookingId: doc.bookingId ?? null,
    at: toIso(doc.at),
    actor: doc.actor ?? null,
    doctorId: doc.doctorId ?? null,
    patientId: doc.patientId ?? null,
    slotStart: toIso(doc.slotStart),
    before: doc.before ?? null,
    after: doc.after ?? null,
    meta: doc.meta ?? null,
  };
}

/**
 * @param {() => Promise<import('mongodb').Db|null>} getMongoDb
 * @param {string} collectionName
 */
export function mongoAuditRepo(getMongoDb, collectionName = "booking_audit") {
  // Per-instance and lazy: nothing touches Mongo until the first record/list call.
  let ready = null;

  function collection() {
    if (!ready) {
      const p = (async () => {
        const db = await getMongoDb();
        if (!db) throw new Error("MongoDB is not configured");
        const coll = db.collection(collectionName);
        await coll.createIndexes([{ key: { bookingId: 1, at: -1 } }, { key: { at: -1 } }]);
        return coll;
      })();
      ready = p;
      // Reset on failure so a later call retries (callers still see the rejection).
      p.catch(() => {
        if (ready === p) ready = null;
      });
    }
    return ready;
  }

  return {
    async record(event = {}) {
      const coll = await collection();
      const doc = {
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
      const { insertedId } = await coll.insertOne(doc);
      return toEntry({ ...doc, _id: insertedId });
    },

    async list({ bookingId, limit } = {}) {
      const filter = {};
      if (bookingId !== undefined && bookingId !== null && bookingId !== "") {
        const n = Number(bookingId);
        if (!Number.isFinite(n)) return [];
        filter.bookingId = n;
      }
      const coll = await collection();
      const docs = await coll
        .find(filter)
        .sort({ at: -1, _id: -1 })
        .limit(clampLimit(limit))
        .toArray();
      return docs.map(toEntry);
    },
  };
}
