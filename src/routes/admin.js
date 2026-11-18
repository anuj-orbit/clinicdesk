import express from "express";
import { wrap, ValidationError } from "../errors.js";
import { requireRole } from "../auth/middleware.js";

const VALID_STATUSES = ["booked", "cancelled"];

function parseLimit(raw, fallback) {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new ValidationError("validation");
  return Math.min(n, 500);
}

function parseOptionalInt(raw) {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new ValidationError("validation");
  return n;
}

function parseOptionalDate(raw) {
  if (raw === undefined || raw === "") return undefined;
  const d = new Date(raw);
  if (isNaN(d.getTime())) throw new ValidationError("validation");
  return d;
}

export function adminRouter({ repos, config }) {
  const router = express.Router();

  router.get(
    "/bookings",
    requireRole("admin"),
    wrap(async (req, res) => {
      const { status, doctorId, from, to, limit } = req.query;

      if (status !== undefined && status !== "" && !VALID_STATUSES.includes(status)) {
        throw new ValidationError("validation");
      }

      const doctorIdNum = parseOptionalInt(doctorId);
      const fromDate = parseOptionalDate(from);
      const toDate = parseOptionalDate(to);
      const limitNum = parseLimit(limit, 200);

      const bookings = await repos.bookings.listAll({
        status: status || undefined,
        doctorId: doctorIdNum,
        from: fromDate,
        to: toDate,
        limit: limitNum,
      });

      bookings.sort((a, b) => new Date(b.start).getTime() - new Date(a.start).getTime());

      res.json({ bookings });
    }),
  );

  router.get(
    "/audit",
    requireRole("admin"),
    wrap(async (req, res) => {
      const { bookingId, limit } = req.query;

      const bookingIdNum = parseOptionalInt(bookingId);
      const limitNum = parseLimit(limit, 100);

      const entries = await repos.audit.list({
        bookingId: bookingIdNum,
        limit: limitNum,
      });

      entries.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

      res.json({ entries });
    }),
  );

  return router;
}