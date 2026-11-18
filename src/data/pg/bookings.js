// Area B (B2) — Postgres bookings repo.
//
// create() is the section-5 transaction: it locks the covering availability
// rule FOR SHARE, inserts, and relies on the partial unique indexes
// (bookings_doctor_slot_active_uq / bookings_patient_slot_active_uq) as the
// double-booking arbiter. There is NO select-then-insert check for existing
// bookings; a SQLSTATE 23505 is mapped by err.constraint.
import { ValidationError, ConflictError } from "../../errors.js";
import { coded } from "../../booking/codes.js";

const SLOT_MS = 30 * 60 * 1000;

const BASE_SELECT = `
  SELECT b.id, b.doctor_id, b.patient_id, b.slot_start, b.status,
         b.created_at, b.cancelled_at, b.cancelled_by,
         du.name AS doctor_name,
         pu.name AS patient_name, pu.email AS patient_email
    FROM bookings b
    JOIN users du ON du.id = b.doctor_id
    JOIN users pu ON pu.id = b.patient_id`;

function mapBooking(row) {
  const start = new Date(row.slot_start);
  return {
    id: row.id,
    doctorId: row.doctor_id,
    doctorName: row.doctor_name,
    patientId: row.patient_id,
    patientName: row.patient_name,
    patientEmail: row.patient_email,
    start: start.toISOString(),
    end: new Date(start.getTime() + SLOT_MS).toISOString(),
    status: row.status,
    createdAt: row.created_at.toISOString(),
    cancelledAt: row.cancelled_at ? row.cancelled_at.toISOString() : null,
    cancelledBy: row.cancelled_by ?? null,
  };
}

/** Maps a pg unique-violation to the right ConflictError, or rethrows. */
function mapUniqueViolation(err) {
  if (err && err.code === "23505") {
    if (err.constraint === "bookings_doctor_slot_active_uq") {
      return coded(ConflictError, "slot_taken");
    }
    if (err.constraint === "bookings_patient_slot_active_uq") {
      return coded(ConflictError, "patient_busy");
    }
  }
  return null;
}

export function pgBookingsRepo(pool) {
  async function findById(id) {
    const { rows } = await pool.query(`${BASE_SELECT} WHERE b.id = $1`, [id]);
    return rows.length ? mapBooking(rows[0]) : null;
  }

  return {
    findById,

    async create({ doctorId, patientId, slotStart, dayOfWeek, startMinute }) {
      const client = await pool.connect();
      let committed = false;
      try {
        await client.query("BEGIN");

        const { rows: rule } = await client.query(
          `SELECT id FROM availability
            WHERE doctor_id = $1 AND day_of_week = $2
              AND start_minute <= $3 AND end_minute >= $3 + 30
            LIMIT 1 FOR SHARE`,
          [doctorId, dayOfWeek, startMinute],
        );
        if (!rule.length) throw coded(ValidationError, "outside_availability");

        const { rows } = await client.query(
          `INSERT INTO bookings (doctor_id, patient_id, slot_start)
           VALUES ($1, $2, $3) RETURNING id`,
          [doctorId, patientId, slotStart],
        );

        await client.query("COMMIT");
        committed = true;

        return findById(rows[0].id);
      } catch (err) {
        if (!committed) {
          try {
            await client.query("ROLLBACK");
          } catch {
            /* connection already gone */
          }
        }
        throw mapUniqueViolation(err) ?? err;
      } finally {
        client.release();
      }
    },

    async cancel(id, cancelledBy) {
      const { rows } = await pool.query(
        `UPDATE bookings
            SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2
          WHERE id = $1 AND status = 'booked'
        RETURNING id`,
        [id, cancelledBy],
      );
      if (!rows.length) return null;
      return findById(rows[0].id);
    },

    async listByPatient(patientId) {
      const { rows } = await pool.query(`${BASE_SELECT} WHERE b.patient_id = $1 ORDER BY b.slot_start ASC`, [
        patientId,
      ]);
      return rows.map(mapBooking);
    },

    async listByDoctor(doctorId, { from, to, status } = {}) {
      const conds = ["b.doctor_id = $1"];
      const params = [doctorId];
      if (from) {
        params.push(from);
        conds.push(`b.slot_start >= $${params.length}`);
      }
      if (to) {
        params.push(to);
        conds.push(`b.slot_start < $${params.length}`);
      }
      if (status) {
        params.push(status);
        conds.push(`b.status = $${params.length}`);
      }
      const { rows } = await pool.query(
        `${BASE_SELECT} WHERE ${conds.join(" AND ")} ORDER BY b.slot_start ASC`,
        params,
      );
      return rows.map(mapBooking);
    },

    async listBookedForDoctorBetween(doctorId, from, to) {
      const { rows } = await pool.query(
        `${BASE_SELECT} WHERE b.doctor_id = $1 AND b.status = 'booked' AND b.slot_start >= $2 AND b.slot_start < $3 ORDER BY b.slot_start ASC`,
        [doctorId, from, to],
      );
      return rows.map(mapBooking);
    },

    async listAll({ status, doctorId, from, to, limit = 200 } = {}) {
      const capped = Math.min(Number(limit) || 200, 500);
      const conds = [];
      const params = [];
      if (status) {
        params.push(status);
        conds.push(`b.status = $${params.length}`);
      }
      if (doctorId !== undefined && doctorId !== null) {
        params.push(doctorId);
        conds.push(`b.doctor_id = $${params.length}`);
      }
      if (from) {
        params.push(from);
        conds.push(`b.slot_start >= $${params.length}`);
      }
      if (to) {
        params.push(to);
        conds.push(`b.slot_start < $${params.length}`);
      }
      const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
      params.push(capped);
      const { rows } = await pool.query(
        `${BASE_SELECT} ${where} ORDER BY b.slot_start DESC LIMIT $${params.length}`,
        params,
      );
      return rows.map(mapBooking);
    },
  };
}
