import express from "express";
import { wrap } from "../errors.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { createBookingService } from "../booking/service.js";

function metaOf(req) {
  return { ip: req.ip ?? null, userAgent: req.get("user-agent") ?? null };
}

/**
 * Booking + availability domain router (PLAN §3.2). Mounted at /api.
 * Guards are per-route: this router must not blanket-401 other routers' paths.
 */
export function bookingRouter({ repos, config }) {
  repos.bookings.attach?.({ users: repos.users, availability: repos.availability });

  const service = createBookingService({ repos, config });
  const router = express.Router();

  const patientOnly = requireRole("patient");
  const doctorOnly = requireRole("doctor");

  router.get(
    "/doctors",
    requireAuth,
    wrap(async (_req, res) => {
      const doctors = await service.listDoctors();
      res.json({ doctors });
    }),
  );

  router.get(
    "/doctors/:id/slots",
    requireAuth,
    wrap(async (req, res) => {
      const result = await service.listSlots(req.params.id, {
        from: req.query.from,
        days: req.query.days,
      });
      res.json(result);
    }),
  );

  // Declared before any /bookings/:id route.
  router.get(
    "/bookings/mine",
    patientOnly,
    wrap(async (req, res) => {
      const bookings = await service.listMine(req.user.id);
      res.json({ bookings });
    }),
  );

  router.post(
    "/bookings",
    patientOnly,
    wrap(async (req, res) => {
      const { doctorId, start } = req.body ?? {};
      const booking = await service.createBooking(req.user, { doctorId, start }, metaOf(req));
      res.status(201).json({ booking });
    }),
  );

  router.post(
    "/bookings/:id/cancel",
    requireAuth,
    wrap(async (req, res) => {
      const booking = await service.cancelBooking(req.user, req.params.id, metaOf(req));
      res.json({ booking });
    }),
  );

  router.get(
    "/doctor/availability",
    doctorOnly,
    wrap(async (req, res) => {
      const rules = await service.listAvailability(req.user.id);
      res.json({ rules });
    }),
  );

  router.post(
    "/doctor/availability",
    doctorOnly,
    wrap(async (req, res) => {
      const rule = await service.createAvailability(req.user.id, req.body ?? {});
      res.status(201).json({ rule });
    }),
  );

  router.put(
    "/doctor/availability/:id",
    doctorOnly,
    wrap(async (req, res) => {
      const rule = await service.updateAvailability(req.user.id, req.params.id, req.body ?? {});
      res.json({ rule });
    }),
  );

  router.delete(
    "/doctor/availability/:id",
    doctorOnly,
    wrap(async (req, res) => {
      await service.deleteAvailability(req.user.id, req.params.id);
      res.status(204).end();
    }),
  );

  router.get(
    "/doctor/bookings",
    doctorOnly,
    wrap(async (req, res) => {
      const bookings = await service.listDoctorBookings(req.user.id, {
        from: req.query.from,
        to: req.query.to,
        status: req.query.status,
      });
      res.json({ bookings });
    }),
  );

  return router;
}