import { ValidationError, ForbiddenError, NotFoundError, ConflictError } from "../errors.js";
import { coded } from "./codes.js";
import { parseHHMM, formatHHMM, localParts, todayLocalDateStr, generateSlots } from "./slots.js";

const SLOT_MS = 1_800_000; // 30 minutes
const MAX_AHEAD_MS = 90 * 24 * 60 * 60 * 1000;

/** Builds the booking domain service. All repos are async (see PLAN §6). */
export function createBookingService({ repos, config, now = () => new Date() }) {
  function toIso(value) {
    if (value === null || value === undefined) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }

  function toRule(rule) {
    return {
      id: rule.id,
      doctorId: rule.doctorId,
      dayOfWeek: rule.dayOfWeek,
      startTime: formatHHMM(rule.startMinute),
      endTime: formatHHMM(rule.endMinute),
    };
  }

  function toBooking(b) {
    if (!b) return null;
    return {
      id: b.id,
      doctorId: b.doctorId,
      doctorName: b.doctorName ?? null,
      patientId: b.patientId,
      patientName: b.patientName ?? null,
      patientEmail: b.patientEmail ?? null,
      start: toIso(b.start),
      end: toIso(b.end),
      status: b.status,
      createdAt: toIso(b.createdAt),
      cancelledAt: toIso(b.cancelledAt),
      cancelledBy: b.cancelledBy ?? null,
    };
  }

  /** Writes the audit entry; retries once; never fails the request. */
  async function emitAudit(event) {
    try {
      await repos.audit.record(event);
    } catch {
      try {
        await repos.audit.record(event);
      } catch {
        console.error("AUDIT_WRITE_FAILED", JSON.stringify(event));
      }
    }
  }

  function auditEvent(action, booking, actor, meta, before, after) {
    return {
      action,
      bookingId: booking.id,
      at: new Date(),
      actor: { id: actor.id, role: actor.role, email: actor.email },
      doctorId: booking.doctorId,
      patientId: booking.patientId,
      slotStart: new Date(booking.start),
      before: before ?? null,
      after: after ?? null,
      meta: { ip: meta?.ip ?? null, userAgent: meta?.userAgent ?? null },
    };
  }

  async function listDoctors() {
    const doctors = await repos.users.listByRole("doctor");
    return doctors.map((u) => ({ id: u.id, name: u.name, specialty: u.specialty ?? null }));
  }

  async function listSlots(doctorId, { from, days } = {}) {
    const id = Number(doctorId);
    const doctor = Number.isInteger(id) ? await repos.users.findById(id) : null;
    if (!doctor || doctor.role !== "doctor") {
      throw coded(NotFoundError, "doctor_not_found");
    }

    let dayCount = days === undefined || days === null || days === "" ? 7 : Number(days);
    if (!Number.isInteger(dayCount) || dayCount < 1 || dayCount > 28) {
      throw coded(ValidationError, "validation", "days must be an integer between 1 and 28");
    }

    const nowDate = now();
    let fromStr = from;
    if (fromStr === undefined || fromStr === null || fromStr === "") {
      fromStr = todayLocalDateStr(nowDate, config.clinicOffsetMinutes);
    } else if (
      typeof fromStr !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(fromStr) ||
      Number.isNaN(new Date(`${fromStr}T00:00:00.000Z`).getTime())
    ) {
      throw coded(ValidationError, "validation", "from must be a YYYY-MM-DD date");
    }

    const offsetMs = config.clinicOffsetMinutes * 60 * 1000;
    const fromMs = new Date(`${fromStr}T00:00:00.000Z`).getTime();
    const toMs = fromMs + dayCount * 24 * 60 * 60 * 1000;
    const rangeFrom = new Date(fromMs - offsetMs);
    const rangeTo = new Date(toMs - offsetMs);

    const rules = await repos.availability.listByDoctor(id);
    const booked = await repos.bookings.listBookedForDoctorBetween(id, rangeFrom, rangeTo);
    const bookedStartMs = new Set(booked.map((b) => new Date(b.start).getTime()));

    const slots = generateSlots({
      rules,
      from: fromStr,
      days: dayCount,
      offsetMinutes: config.clinicOffsetMinutes,
      now: nowDate,
      bookedStartMs,
    });

    return {
      doctorId: id,
      slots: slots.map((s) => ({ start: toIso(s.start), end: toIso(s.end) })),
    };
  }

  async function createBooking(actor, { doctorId, start } = {}, meta = {}) {
    if (!actor || actor.role !== "patient") {
      throw coded(ForbiddenError, "forbidden");
    }
    if (!Number.isInteger(doctorId)) {
      throw coded(ValidationError, "validation", "doctorId must be an integer");
    }
    if (typeof start !== "string") {
      throw coded(ValidationError, "validation", "start must be an ISO date string");
    }
    const startDate = new Date(start);
    const ms = startDate.getTime();
    if (Number.isNaN(ms)) {
      throw coded(ValidationError, "validation", "start is not a valid date");
    }
    if (ms % SLOT_MS !== 0) {
      throw coded(ValidationError, "misaligned_slot");
    }
    const nowMs = now().getTime();
    if (ms <= nowMs) {
      throw coded(ValidationError, "slot_in_past");
    }
    if (ms > nowMs + MAX_AHEAD_MS) {
      throw coded(ValidationError, "too_far_ahead");
    }

    const doctor = await repos.users.findById(doctorId);
    if (!doctor || doctor.role !== "doctor") {
      throw coded(NotFoundError, "doctor_not_found");
    }

    const { dayOfWeek, minuteOfDay } = localParts(startDate, config.clinicOffsetMinutes);

    const booking = await repos.bookings.create({
      doctorId,
      patientId: actor.id,
      slotStart: startDate,
      dayOfWeek,
      startMinute: minuteOfDay,
    });

    await emitAudit(
      auditEvent("booking.created", booking, actor, meta, null, { status: "booked" }),
    );

    return toBooking(booking);
  }

  async function cancelBooking(actor, id, meta = {}) {
    const bookingId = Number(id);
    const existing = Number.isInteger(bookingId) ? await repos.bookings.findById(bookingId) : null;
    if (!existing) {
      throw coded(NotFoundError, "not_found");
    }

    const visible =
      actor.role === "admin" ||
      (actor.role === "doctor" && existing.doctorId === actor.id) ||
      (actor.role === "patient" && existing.patientId === actor.id);
    if (!visible) {
      throw coded(NotFoundError, "not_found");
    }

    if (new Date(existing.start).getTime() <= now().getTime()) {
      throw coded(ValidationError, "booking_in_past");
    }

    const cancelled = await repos.bookings.cancel(bookingId, actor.id);
    if (!cancelled) {
      const again = await repos.bookings.findById(bookingId);
      if (!again) {
        throw coded(NotFoundError, "not_found");
      }
      throw coded(ConflictError, "already_cancelled");
    }

    await emitAudit(
      auditEvent("booking.cancelled", cancelled, actor, meta, { status: "booked" }, { status: "cancelled" }),
    );

    return toBooking(cancelled);
  }

  async function listMine(patientId) {
    const bookings = await repos.bookings.listByPatient(patientId);
    return bookings
      .map(toBooking)
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  }

  async function listDoctorBookings(doctorId, { from, to, status } = {}) {
    if (status !== undefined && status !== null && status !== "" && status !== "booked" && status !== "cancelled") {
      throw coded(ValidationError, "validation", "status must be booked or cancelled");
    }
    const filter = {};
    if (from) filter.from = new Date(from);
    if (to) filter.to = new Date(to);
    if (status) filter.status = status;
    const bookings = await repos.bookings.listByDoctor(doctorId, filter);
    return bookings.map(toBooking);
  }

  async function listAvailability(doctorId) {
    const rules = await repos.availability.listByDoctor(doctorId);
    return rules.map(toRule);
  }

  function parseRuleInput({ dayOfWeek, startTime, endTime }) {
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
      throw coded(ValidationError, "validation", "dayOfWeek must be an integer between 0 and 6");
    }
    let startMinute;
    let endMinute;
    try {
      startMinute = parseHHMM(startTime);
    } catch {
      throw coded(ValidationError, "validation", "startTime must be HH:MM on a 30-minute boundary");
    }
    try {
      endMinute = parseHHMM(endTime, { allowEnd24: true });
    } catch {
      throw coded(ValidationError, "validation", "endTime must be HH:MM on a 30-minute boundary");
    }
    if (startMinute >= endMinute) {
      throw coded(ValidationError, "validation", "startTime must be before endTime");
    }
    return { dayOfWeek, startMinute, endMinute };
  }

  async function createAvailability(doctorId, input) {
    const { dayOfWeek, startMinute, endMinute } = parseRuleInput(input ?? {});
    const rule = await repos.availability.create({ doctorId, dayOfWeek, startMinute, endMinute });
    return toRule(rule);
  }

  async function updateAvailability(doctorId, id, input) {
    const { dayOfWeek, startMinute, endMinute } = parseRuleInput(input ?? {});
    const rule = await repos.availability.update(Number(id), doctorId, { dayOfWeek, startMinute, endMinute });
    if (!rule) {
      throw coded(NotFoundError, "not_found");
    }
    return toRule(rule);
  }

  async function deleteAvailability(doctorId, id) {
    const ok = await repos.availability.delete(Number(id), doctorId);
    if (!ok) {
      throw coded(NotFoundError, "not_found");
    }
  }

  return {
    listDoctors,
    listSlots,
    createBooking,
    cancelBooking,
    listMine,
    listDoctorBookings,
    listAvailability,
    createAvailability,
    updateAvailability,
    deleteAvailability,
  };
}