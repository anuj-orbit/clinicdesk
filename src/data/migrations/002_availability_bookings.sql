CREATE TABLE availability (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doctor_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_of_week  SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),        -- clinic-local, 0 = Sunday
  start_minute SMALLINT NOT NULL CHECK (start_minute BETWEEN 0 AND 1410 AND start_minute % 30 = 0),
  end_minute   SMALLINT NOT NULL CHECK (end_minute BETWEEN 30 AND 1440 AND end_minute % 30 = 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_minute > start_minute)
);
CREATE INDEX availability_doctor_day_idx ON availability (doctor_id, day_of_week);

CREATE TABLE bookings (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doctor_id    INTEGER NOT NULL REFERENCES users(id),
  patient_id   INTEGER NOT NULL REFERENCES users(id),
  slot_start   TIMESTAMPTZ NOT NULL,          -- slot end = slot_start + 30 min (computed in app; a
                                              -- generated column is not allowed: timestamptz+interval is not IMMUTABLE)
  status       TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','cancelled')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at TIMESTAMPTZ,
  cancelled_by INTEGER REFERENCES users(id),
  CHECK (doctor_id <> patient_id),
  CHECK (EXTRACT(EPOCH FROM slot_start)::bigint % 1800 = 0)   -- exactly on a :00/:30 boundary
);
-- THE double-booking guard: at most one ACTIVE booking per doctor per slot.
CREATE UNIQUE INDEX bookings_doctor_slot_active_uq  ON bookings (doctor_id,  slot_start) WHERE status = 'booked';
-- A patient cannot be in two places at once.
CREATE UNIQUE INDEX bookings_patient_slot_active_uq ON bookings (patient_id, slot_start) WHERE status = 'booked';
CREATE INDEX bookings_slot_start_idx ON bookings (slot_start);
