// Area B (B2) — Postgres availability repo.
// create/update run in a single transaction guarded by pg_advisory_xact_lock,
// so two concurrent writes for the same doctor serialise and the overlap check
// is race-free. The lock is released at COMMIT/ROLLBACK.
import { ConflictError } from "../../errors.js";
import { coded } from "../../booking/codes.js";

function mapRule(row) {
  return {
    id: row.id,
    doctorId: row.doctor_id,
    dayOfWeek: row.day_of_week,
    startMinute: row.start_minute,
    endMinute: row.end_minute,
  };
}

const RULE_COLS = "id, doctor_id, day_of_week, start_minute, end_minute";

export function pgAvailabilityRepo(pool) {
  return {
    async listByDoctor(doctorId) {
      const { rows } = await pool.query(
        `SELECT ${RULE_COLS} FROM availability WHERE doctor_id = $1 ORDER BY day_of_week, start_minute`,
        [doctorId],
      );
      return rows.map(mapRule);
    },

    async create({ doctorId, dayOfWeek, startMinute, endMinute }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock($1)", [doctorId]);

        const { rows: clash } = await client.query(
          `SELECT 1 FROM availability
            WHERE doctor_id = $1 AND day_of_week = $2
              AND start_minute < $4 AND end_minute > $3
            LIMIT 1`,
          [doctorId, dayOfWeek, startMinute, endMinute],
        );
        if (clash.length) throw coded(ConflictError, "availability_overlap");

        const { rows } = await client.query(
          `INSERT INTO availability (doctor_id, day_of_week, start_minute, end_minute)
           VALUES ($1, $2, $3, $4) RETURNING ${RULE_COLS}`,
          [doctorId, dayOfWeek, startMinute, endMinute],
        );
        await client.query("COMMIT");
        return mapRule(rows[0]);
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* connection already gone */
        }
        throw err;
      } finally {
        client.release();
      }
    },

    async update(id, doctorId, { dayOfWeek, startMinute, endMinute }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock($1)", [doctorId]);

        const { rows: own } = await client.query(
          "SELECT 1 FROM availability WHERE id = $1 AND doctor_id = $2",
          [id, doctorId],
        );
        if (!own.length) {
          await client.query("ROLLBACK");
          return null;
        }

        const { rows: clash } = await client.query(
          `SELECT 1 FROM availability
            WHERE doctor_id = $1 AND day_of_week = $2 AND id <> $3
              AND start_minute < $5 AND end_minute > $4
            LIMIT 1`,
          [doctorId, dayOfWeek, id, startMinute, endMinute],
        );
        if (clash.length) throw coded(ConflictError, "availability_overlap");

        const { rows } = await client.query(
          `UPDATE availability
              SET day_of_week = $1, start_minute = $2, end_minute = $3
            WHERE id = $4 AND doctor_id = $5
          RETURNING ${RULE_COLS}`,
          [dayOfWeek, startMinute, endMinute, id, doctorId],
        );
        await client.query("COMMIT");
        return rows.length ? mapRule(rows[0]) : null;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* connection already gone */
        }
        throw err;
      } finally {
        client.release();
      }
    },

    async delete(id, doctorId) {
      const { rowCount } = await pool.query("DELETE FROM availability WHERE id = $1 AND doctor_id = $2", [
        id,
        doctorId,
      ]);
      return rowCount > 0;
    },
  };
}
