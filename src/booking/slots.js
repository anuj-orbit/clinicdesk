// Helper to validate and parse HH:MM times (clinic-local format)
import { coded } from './codes.js';
import { ValidationError } from '../errors.js';

/**
 * Parses a "HH:MM" string into minutes since midnight.
 * Valid format: exactly two digits for hour and minute (e.g., "09:30" or "24:00")
 * - Minutes must be 0 or 30 (clinic uses 30-min slots)
 * - Hours: 0-23, with special allowance for "24:00" as an end time (only when allowEnd24=true)
 * Throws ValidationError for violations.
 */
export function parseHHMM(str, { allowEnd24 = false } = {}) {
  const match = /^\d{2}:\d{2}$/.exec(str);
  if (!match) throw coded(ValidationError, 'validation', `Invalid HH:MM format: ${str}`);

  const [h, m] = str.split(':').map(Number);
  if (m !== 0 && m !== 30) {
    throw coded(ValidationError, 'validation', `Minutes must be 00 or 30, got ${str}`);
  }
  if (h === 24) {
    if (allowEnd24 && m === 0) return 1440; // 24:00 is 1440 minutes
    throw coded(ValidationError, 'validation', `Hour must be 0-23, got ${str}`);
  }
  if (h < 0 || h > 23) {
    throw coded(ValidationError, 'validation', `Hour must be 0-23, got ${str}`);
  }
  return h * 60 + m;
}

/**
 * Converts minutes since midnight to "HH:MM" clinic-local format.
 * Returns "24:00" for 1440 (i.e., midnight after 24-hour day).
 */
export function formatHHMM(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 24 && m === 0) return '24:00';
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

/**
 * Calculates local date parts for a given clinic-local offset.
 * Input `offsetMin` adds minutes to the provided Date (UTC), then extracts
 * local day-of-week, minuteOfDay, and ISO date string in clinic time.
 */
export function localParts(date, offsetMin) {
  const shifted = new Date(date.getTime() + offsetMin * 60000);
  const y = shifted.getUTCFullYear();
  const mo = shifted.getUTCMonth() + 1; // 1-indexed month
  const d = shifted.getUTCDate();
  const dayOfWeek = shifted.getUTCDay(); // 0 = Sunday
  const minuteOfDay = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  const dateStr = `${y}-${mo.toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}`;
  return { dayOfWeek, minuteOfDay, dateStr };
}

/**
 * Returns today's clinic-local date string (YYYY-MM-DD) given a reference now.
 * Uses localParts internally with provided offset.
 */
export function todayLocalDateStr(now, offsetMin) {
  const { dateStr } = localParts(now, offsetMin);
  return dateStr;
}

/**
 * Generates free 30-minute slots for a doctor across consecutive local days.
 * Rules: each {dayOfWeek, startMinute, endMinute} in clinic time.
 * Exclude past slots (relative to `now`) and already booked starts.
 * Returns sorted, deduplicated array of {start: ISO string, end: ISO string}.
 */
export function generateSlots({ rules, from, days, offsetMinutes, now, bookedStartMs }) {
  const bookedSet = bookedStartMs || new Set();
  const nowMs = now.getTime();
  const slotMsSet = new Set();
  const result = [];

  // Parse the 'from' local date string (YYYY-MM-DD)
  const [y0, mo0, d0] = from.split('-').map(Number);
  const startDate = Date.UTC(y0, mo0 - 1, d0); // UTC midnight at start of local day

  for (let dayOffset = 0; dayOffset < days; dayOffset++) {
    const dayMs = startDate + dayOffset * 86400000; // add dayOffset days in ms
    const dayDate = new Date(dayMs);
    const dayOfWeek = dayDate.getUTCDay(); // 0 = Sunday

    // Find matching rules for this day of week
    for (const rule of rules) {
      if (rule.dayOfWeek !== dayOfWeek) continue;

      // Generate 30-min slots from startMinute to endMinute
      for (let m = rule.startMinute; m + 30 <= rule.endMinute; m += 30) {
        const startMs = dayMs + m * 60000 - offsetMinutes * 60000;
        const endMs = startMs + 30 * 60000;

        // Exclude past slots
        if (startMs <= nowMs) continue;

        // Exclude booked slots
        if (bookedSet.has(startMs)) continue;

        // Deduplicate by startMs
        if (slotMsSet.has(startMs)) continue;
        slotMsSet.add(startMs);

        result.push({
          start: new Date(startMs).toISOString(),
          end: new Date(endMs).toISOString()
        });
      }
    }
  }

  // Sort by start time ascending
  result.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  return result;
}