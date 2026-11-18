// Area B (B2) — in-memory availability repo.
// Rules use minutes; the HH:MM conversion happens in src/booking/slots.js.
import { ConflictError } from "../../errors.js";
import { coded } from "../../booking/codes.js";

function clone(rule) {
  return {
    id: rule.id,
    doctorId: rule.doctorId,
    dayOfWeek: rule.dayOfWeek,
    startMinute: rule.startMinute,
    endMinute: rule.endMinute,
  };
}

export function memoryAvailabilityRepo() {
  const rules = [];
  let nextId = 1;

  function overlaps(doctorId, dayOfWeek, startMinute, endMinute, excludeId) {
    return rules.some(
      (r) =>
        r.doctorId === doctorId &&
        r.dayOfWeek === dayOfWeek &&
        r.id !== excludeId &&
        r.startMinute < endMinute &&
        r.endMinute > startMinute,
    );
  }

  return {
    // Non-async helper so the memory bookings repo can check coverage while it
    // is inside its synchronous check+insert section.
    _rulesFor(doctorId) {
      return rules.filter((r) => r.doctorId === doctorId);
    },

    async listByDoctor(doctorId) {
      return rules
        .filter((r) => r.doctorId === doctorId)
        .sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startMinute - b.startMinute)
        .map(clone);
    },

    async create({ doctorId, dayOfWeek, startMinute, endMinute }) {
      if (overlaps(doctorId, dayOfWeek, startMinute, endMinute, null)) {
        throw coded(ConflictError, "availability_overlap");
      }
      const rule = { id: nextId++, doctorId, dayOfWeek, startMinute, endMinute };
      rules.push(rule);
      return clone(rule);
    },

    async update(id, doctorId, { dayOfWeek, startMinute, endMinute }) {
      const rule = rules.find((r) => r.id === id && r.doctorId === doctorId);
      if (!rule) return null;
      if (overlaps(doctorId, dayOfWeek, startMinute, endMinute, id)) {
        throw coded(ConflictError, "availability_overlap");
      }
      rule.dayOfWeek = dayOfWeek;
      rule.startMinute = startMinute;
      rule.endMinute = endMinute;
      return clone(rule);
    },

    async delete(id, doctorId) {
      const idx = rules.findIndex((r) => r.id === id && r.doctorId === doctorId);
      if (idx === -1) return false;
      rules.splice(idx, 1);
      return true;
    },
  };
}
