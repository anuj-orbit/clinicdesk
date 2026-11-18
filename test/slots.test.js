import { test, suite, describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHHMM,
  formatHHMM,
  localParts,
  todayLocalDateStr,
  generateSlots
} from '../src/booking/slots.js';
import { ValidationError } from '../src/errors.js';

const isValidationError = (err) => err instanceof ValidationError && err.code === 'validation';

// Helper: a fixed Monday for testing
// 2027-01-04 is a Monday (verified via Date)
const MONDAY = '2027-01-04';
const TUESDAY = '2027-01-05';

suite('parseHHMM', () => {
  test('valid times return minutes', () => {
    assert.equal(parseHHMM('09:00'), 540);
    assert.equal(parseHHMM('09:30'), 570);
    assert.equal(parseHHMM('23:30'), 1410);
    assert.equal(parseHHMM('00:00'), 0);
  });

  test('rejects invalid format', () => {
    assert.throws(() => parseHHMM('9:00'), isValidationError);
    assert.throws(() => parseHHMM('09:0'), isValidationError);
    assert.throws(() => parseHHMM('09-00'), isValidationError);
    assert.throws(() => parseHHMM('abc'), isValidationError);
  });

  test('rejects non-30-aligned minutes', () => {
    assert.throws(() => parseHHMM('09:15'), isValidationError);
    assert.throws(() => parseHHMM('09:45'), isValidationError);
  });

  test('rejects hour out of range 0-23', () => {
    assert.throws(() => parseHHMM('24:00'), isValidationError);
    assert.throws(() => parseHHMM('25:00'), isValidationError);
    assert.throws(() => parseHHMM('-1:00'), isValidationError);
  });

  test('allows 24:00 as end when allowEnd24=true', () => {
    assert.equal(parseHHMM('24:00', { allowEnd24: true }), 1440);
  });

  test('rejects 24:00 without allowEnd24 flag', () => {
    assert.throws(() => parseHHMM('24:00'), isValidationError);
  });

  test('rejects 24:30 even with allowEnd24', () => {
    assert.throws(() => parseHHMM('24:30', { allowEnd24: true }), isValidationError);
  });
});

suite('formatHHMM', () => {
  test('formats minutes to HH:MM', () => {
    assert.equal(formatHHMM(0), '00:00');
    assert.equal(formatHHMM(540), '09:00');
    assert.equal(formatHHMM(570), '09:30');
    assert.equal(formatHHMM(1410), '23:30');
  });

  test('formats 1440 as 24:00', () => {
    assert.equal(formatHHMM(1440), '24:00');
  });

  test('roundtrip with parseHHMM', () => {
    const times = ['00:00', '09:00', '09:30', '23:30'];
    for (const t of times) {
      assert.equal(formatHHMM(parseHHMM(t)), t);
    }
  });
});

suite('localParts', () => {
  test('no offset returns correct local parts for UTC midnight', () => {
    const d = new Date('2027-01-04T00:00:00.000Z'); // Monday UTC midnight
    const parts = localParts(d, 0);
    assert.equal(parts.dayOfWeek, 1); // Monday
    assert.equal(parts.minuteOfDay, 0);
    assert.equal(parts.dateStr, '2027-01-04');
  });

  test('positive offset shifts forward in local time', () => {
    const d = new Date('2027-01-04T00:00:00.000Z'); // Monday UTC midnight
    // offset +60 = 1 hour forward → 01:00 local
    const parts = localParts(d, 60);
    assert.equal(parts.dayOfWeek, 1);
    assert.equal(parts.minuteOfDay, 60);
    assert.equal(parts.dateStr, '2027-01-04');
  });

  test('negative offset shifts backward in local time', () => {
    const d = new Date('2027-01-04T00:00:00.000Z'); // Monday UTC midnight
    // offset -60 = 1 hour back → 23:00 previous day (Sunday)
    const parts = localParts(d, -60);
    assert.equal(parts.dayOfWeek, 0); // Sunday
    assert.equal(parts.minuteOfDay, 1380); // 23:00 = 23*60
    assert.equal(parts.dateStr, '2027-01-03');
  });

  test('offset crossing midnight forward to next day', () => {
    // 2027-01-04T23:30:00Z + 60 min = 2027-01-05T00:30:00Z
    const d = new Date('2027-01-04T23:30:00.000Z');
    const parts = localParts(d, 60);
    assert.equal(parts.dayOfWeek, 2); // Tuesday
    assert.equal(parts.minuteOfDay, 30);
    assert.equal(parts.dateStr, '2027-01-05');
  });

  test('offset crossing midnight backward to previous day', () => {
    // 2027-01-04T00:30:00Z - 60 min = 2027-01-03T23:30:00Z
    const d = new Date('2027-01-04T00:30:00.000Z');
    const parts = localParts(d, -60);
    assert.equal(parts.dayOfWeek, 0); // Sunday
    assert.equal(parts.minuteOfDay, 1410); // 23:30
    assert.equal(parts.dateStr, '2027-01-03');
  });
});

suite('todayLocalDateStr', () => {
  test('returns local date string for given now and offset', () => {
    const now = new Date('2027-01-04T00:00:00.000Z');
    assert.equal(todayLocalDateStr(now, 0), '2027-01-04');
    assert.equal(todayLocalDateStr(now, 60), '2027-01-04');
    assert.equal(todayLocalDateStr(now, -60), '2027-01-03');
  });
});

suite('generateSlots', () => {
  // Fixed reference time: Monday 2027-01-04 08:00 UTC
  // With offsetMinutes=0, clinic time = UTC
  const REF_NOW = new Date('2027-01-04T08:00:00.000Z');
  const RULE_MON_09_10_30 = { dayOfWeek: 1, startMinute: 540, endMinute: 630 }; // Mon 09:00-10:30

  test('Monday 09:00-10:30 rule produces 3 slots on Monday', () => {
    const slots = generateSlots({
      rules: [RULE_MON_09_10_30],
      from: MONDAY,
      days: 7,
      offsetMinutes: 0,
      now: REF_NOW,
      bookedStartMs: new Set()
    });
    assert.equal(slots.length, 3);
    assert.equal(slots[0].start, '2027-01-04T09:00:00.000Z');
    assert.equal(slots[0].end, '2027-01-04T09:30:00.000Z');
    assert.equal(slots[1].start, '2027-01-04T09:30:00.000Z');
    assert.equal(slots[1].end, '2027-01-04T10:00:00.000Z');
    assert.equal(slots[2].start, '2027-01-04T10:00:00.000Z');
    assert.equal(slots[2].end, '2027-01-04T10:30:00.000Z');
  });

  test('same rule produces 0 slots on Tuesday', () => {
    const slots = generateSlots({
      rules: [RULE_MON_09_10_30],
      from: TUESDAY,
      days: 1,
      offsetMinutes: 0,
      now: REF_NOW,
      bookedStartMs: new Set()
    });
    assert.equal(slots.length, 0);
  });

  test('booked starts are excluded', () => {
    const booked = new Set([Date.UTC(2027, 0, 4, 9, 0, 0)]); // 09:00 booked
    const slots = generateSlots({
      rules: [RULE_MON_09_10_30],
      from: MONDAY,
      days: 1,
      offsetMinutes: 0,
      now: REF_NOW,
      bookedStartMs: booked
    });
    assert.equal(slots.length, 2);
    assert.equal(slots[0].start, '2027-01-04T09:30:00.000Z');
    assert.equal(slots[1].start, '2027-01-04T10:00:00.000Z');
  });

  test('past slots excluded with injected now', () => {
    // now is 10:15, so 09:00, 09:30, 10:00 are in the past
    const laterNow = new Date('2027-01-04T10:15:00.000Z');
    const slots = generateSlots({
      rules: [RULE_MON_09_10_30],
      from: MONDAY,
      days: 1,
      offsetMinutes: 0,
      now: laterNow,
      bookedStartMs: new Set()
    });
    assert.equal(slots.length, 0);
  });

  test('offsetMinutes=60 shifts UTC starts by -60 min', () => {
    // offsetMinutes=60 means clinic is UTC+1, so UTC start is 1 hour earlier
    // Use now=07:59 UTC so 08:00 UTC (09:00 local) is in the future
    const now = new Date('2027-01-04T07:59:00.000Z');
    const slots = generateSlots({
      rules: [RULE_MON_09_10_30],
      from: MONDAY,
      days: 1,
      offsetMinutes: 60,
      now,
      bookedStartMs: new Set()
    });
    assert.equal(slots.length, 3);
    assert.equal(slots[0].start, '2027-01-04T08:00:00.000Z'); // 09:00 local = 08:00 UTC
    assert.equal(slots[1].start, '2027-01-04T08:30:00.000Z');
    assert.equal(slots[2].start, '2027-01-04T09:00:00.000Z');
  });

  test('overlapping rules produce no duplicates', () => {
    const rule1 = { dayOfWeek: 1, startMinute: 540, endMinute: 600 }; // 09:00-10:00
    const rule2 = { dayOfWeek: 1, startMinute: 570, endMinute: 630 }; // 09:30-10:30 (overlaps)
    const slots = generateSlots({
      rules: [rule1, rule2],
      from: MONDAY,
      days: 1,
      offsetMinutes: 0,
      now: REF_NOW,
      bookedStartMs: new Set()
    });
    // Should be 09:00, 09:30, 10:00 only (3 unique slots, not 4)
    assert.equal(slots.length, 3);
    const starts = slots.map(s => s.start);
    assert.deepEqual(starts, [
      '2027-01-04T09:00:00.000Z',
      '2027-01-04T09:30:00.000Z',
      '2027-01-04T10:00:00.000Z'
    ]);
  });

  test('slots sorted ascending by start time', () => {
    const rule1 = { dayOfWeek: 1, startMinute: 540, endMinute: 600 }; // 09:00-10:00
    const rule2 = { dayOfWeek: 2, startMinute: 480, endMinute: 540 }; // Tue 08:00-09:00
    const slots = generateSlots({
      rules: [rule2, rule1], // reversed order
      from: MONDAY,
      days: 2,
      offsetMinutes: 0,
      now: REF_NOW,
      bookedStartMs: new Set()
    });
    // Monday slots should come before Tuesday slots
    assert.equal(slots.length, 4);
    assert(slots[0].start < slots[1].start);
    assert(slots[1].start < slots[2].start);
    assert(slots[2].start < slots[3].start);
  });

  test('endMinute of 1440 (24:00) is allowed as end boundary', () => {
    const rule = { dayOfWeek: 1, startMinute: 1380, endMinute: 1440 }; // 23:00-24:00
    const slots = generateSlots({
      rules: [rule],
      from: MONDAY,
      days: 1,
      offsetMinutes: 0,
      now: new Date('2027-01-04T20:00:00.000Z'),
      bookedStartMs: new Set()
    });
    assert.equal(slots.length, 2);
    assert.equal(slots[0].start, '2027-01-04T23:00:00.000Z');
    assert.equal(slots[1].start, '2027-01-04T23:30:00.000Z');
  });

  test('spans multiple days with day-specific rules', () => {
    const ruleMon = { dayOfWeek: 1, startMinute: 540, endMinute: 600 }; // Mon 09-10
    const ruleTue = { dayOfWeek: 2, startMinute: 480, endMinute: 540 }; // Tue 08-09
    const slots = generateSlots({
      rules: [ruleMon, ruleTue],
      from: MONDAY,
      days: 3, // Mon, Tue, Wed
      offsetMinutes: 0,
      now: REF_NOW,
      bookedStartMs: new Set()
    });
    assert.equal(slots.length, 4); // 2 Mon + 2 Tue
    assert.equal(slots[0].start, '2027-01-04T09:00:00.000Z');
    assert.equal(slots[1].start, '2027-01-04T09:30:00.000Z');
    assert.equal(slots[2].start, '2027-01-05T08:00:00.000Z');
    assert.equal(slots[3].start, '2027-01-05T08:30:00.000Z');
  });
});