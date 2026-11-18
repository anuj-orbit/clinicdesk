// Area B (B2) — in-memory bookings repo.
//
// Mirrors the Postgres double-booking guard with two active-key maps:
//   Map<"doctorId|startMs",  bookingId>   → slot_taken
//   Map<"patientId|startMs", bookingId>   → patient_busy
// The check and the insert run synchronously (no await between them), so they
// are atomic on the JS event loop.
//
// `attach({users, availability})` is called once by the service at startup:
//   - availability: create() verifies a rule covers the slot (outside_availability)
//   - users:        bookings carry doctorName / patientName / patientEmail
import { ValidationError, ConflictError } from "../../errors.js";
import { coded } from "../../booking/codes.js";

const SLOT_MS = 30 * 60 * 1000;

function clone(booking) {
  return {
    id: booking.id,
    doctorId: booking.doctorId,
    doctorName: booking.doctorName,
    patientId: booking.patientId,
    patientName: booking.patientName,
    patientEmail: booking.patientEmail,
    start: booking.start,
    end: booking.end,
    status: booking.status,
    createdAt: booking.createdAt,
    cancelledAt: booking.cancelledAt,
    cancelledBy: booking.cancelledBy,
  };
}

export function memoryBookingsRepo() {
  const bookings = [];
  const activeByDoctor = new Map();
  const activeByPatient = new Map();
  let nextId = 1;

  let usersRef = null;
  let availabilityRef = null;

  function ruleCovers(doctorId, dayOfWeek, startMinute) {
    if (!availabilityRef) return true; // no coverage info attached → do not enforce
    const rules = availabilityRef._rulesFor ? availabilityRef._rulesFor(doctorId) : [];
    return rules.some(
      (r) => r.dayOfWeek === dayOfWeek && r.startMinute <= startMinute && r.endMinute >= startMinute + 30,
    );
  }

  // Async (users.findById) — runs BEFORE the synchronous check+insert section.
  async function resolveNames(doctorId, patientId) {
    if (!usersRef) return { doctorName: null, patientName: null, patientEmail: null };
    const [doctor, patient] = await Promise.all([usersRef.findById(doctorId), usersRef.findById(patientId)]);
    return {
      doctorName: doctor ? doctor.name : null,
      patientName: patient ? patient.name : null,
      patientEmail: patient ? patient.email : null,
    };
  }

  function startMsOf(booking) {
    return new Date(booking.start).getTime();
  }

  return {
    attach({ users, availability } = {}) {
      if (users !== undefined) usersRef = users;
      if (availability !== undefined) availabilityRef = availability;
      return this;
    },

    async create({ doctorId, patientId, slotStart, dayOfWeek, startMinute }) {
      if (!ruleCovers(doctorId, dayOfWeek, startMinute)) {
        throw coded(ValidationError, "outside_availability");
      }

      // Async lookups happen before the atomic section below.
      const names = await resolveNames(doctorId, patientId);

      // ---- atomic section: no await between check and insert ----
      const startMs = slotStart.getTime();
      const dkey = `${doctorId}|${startMs}`;
      if (activeByDoctor.has(dkey)) throw coded(ConflictError, "slot_taken");
      const pkey = `${patientId}|${startMs}`;
      if (activeByPatient.has(pkey)) throw coded(ConflictError, "patient_busy");

      const booking = {
        id: nextId++,
        doctorId,
        doctorName: names.doctorName,
        patientId,
        patientName: names.patientName,
        patientEmail: names.patientEmail,
        start: new Date(startMs).toISOString(),
        end: new Date(startMs + SLOT_MS).toISOString(),
        status: "booked",
        createdAt: new Date().toISOString(),
        cancelledAt: null,
        cancelledBy: null,
      };
      activeByDoctor.set(dkey, booking.id);
      activeByPatient.set(pkey, booking.id);
      bookings.push(booking);
      return clone(booking);
    },

    async findById(id) {
      const booking = bookings.find((b) => b.id === Number(id));
      return booking ? clone(booking) : null;
    },

    async cancel(id, cancelledBy) {
      const booking = bookings.find((b) => b.id === Number(id));
      if (!booking || booking.status !== "booked") return null;
      booking.status = "cancelled";
      booking.cancelledAt = new Date().toISOString();
      booking.cancelledBy = cancelledBy;
      const startMs = startMsOf(booking);
      activeByDoctor.delete(`${booking.doctorId}|${startMs}`);
      activeByPatient.delete(`${booking.patientId}|${startMs}`);
      return clone(booking);
    },

    async listByPatient(patientId) {
      return bookings
        .filter((b) => b.patientId === patientId)
        .sort((a, b) => new Date(a.start) - new Date(b.start))
        .map(clone);
    },

    async listByDoctor(doctorId, { from, to, status } = {}) {
      return bookings
        .filter((b) => b.doctorId === doctorId)
        .filter((b) => !status || b.status === status)
        .filter((b) => !from || new Date(b.start) >= from)
        .filter((b) => !to || new Date(b.start) < to)
        .sort((a, b) => new Date(a.start) - new Date(b.start))
        .map(clone);
    },

    async listBookedForDoctorBetween(doctorId, from, to) {
      return bookings
        .filter((b) => b.doctorId === doctorId && b.status === "booked")
        .filter((b) => new Date(b.start) >= from && new Date(b.start) < to)
        .sort((a, b) => new Date(a.start) - new Date(b.start))
        .map(clone);
    },

    async listAll({ status, doctorId, from, to, limit = 200 } = {}) {
      const capped = Math.min(Number(limit) || 200, 500);
      return bookings
        .filter((b) => !status || b.status === status)
        .filter((b) => doctorId === undefined || b.doctorId === doctorId)
        .filter((b) => !from || new Date(b.start) >= from)
        .filter((b) => !to || new Date(b.start) < to)
        .sort((a, b) => new Date(b.start) - new Date(a.start))
        .slice(0, capped)
        .map(clone);
    },
  };
}
