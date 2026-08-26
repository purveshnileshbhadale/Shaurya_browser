'use strict';
/**
 * ICS parsing for LMS deadline import.
 *
 * The fixtures below are shaped like what Canvas and Moodle actually emit,
 * including the awkward parts: folded lines, escaped commas, all-day dates
 * and a malformed event mixed in with good ones.
 */
const test = require('node:test');
const assert = require('node:assert');

const { parseIcs, bucketByUrgency, unfold } = require('../src/main/services/student/ics');

const CANVAS_FEED = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'X-WR-CALNAME:CS101 Course Calendar',
  'BEGIN:VEVENT',
  'UID:event-assignment-4501@instructure.com',
  'DTSTART:20260901T235900Z',
  'SUMMARY:Problem Set 3',
  'DESCRIPTION:Submit via the portal\\, not by email.',
  'URL:https://canvas.example.edu/courses/1/assignments/4501',
  'CATEGORIES:CS101',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:event-assignment-4502@instructure.com',
  'DTSTART;VALUE=DATE:20260915',
  'SUMMARY:Reading Response [PHIL204]',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('a Canvas-shaped feed parses into deadlines', () => {
  const { events, name, errors } = parseIcs(CANVAS_FEED);

  assert.equal(name, 'CS101 Course Calendar');
  assert.deepEqual(errors, []);
  assert.equal(events.length, 2);

  const [first] = events;
  assert.equal(first.title, 'Problem Set 3');
  assert.equal(first.course, 'CS101');
  assert.equal(first.url, 'https://canvas.example.edu/courses/1/assignments/4501');
  assert.equal(first.description, 'Submit via the portal, not by email.',
    'an escaped comma must come back as a comma');
  assert.equal(first.due.toISOString(), '2026-09-01T23:59:00.000Z');
  assert.equal(first.allDay, false);
});

test('a date-only deadline is all-day and falls at end of day', () => {
  const { events } = parseIcs(CANVAS_FEED);
  const reading = events.find((e) => e.title.startsWith('Reading Response'));

  assert.equal(reading.allDay, true);
  assert.equal(reading.due.getHours(), 23,
    'an all-day assignment is due at the end of that day, not the start of it');
  assert.equal(reading.course, 'PHIL204',
    'Moodle-style bracketed course codes should be recognised too');
});

test('events come back soonest-first', () => {
  const { events } = parseIcs([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'UID:b', 'DTSTART:20261201T120000Z', 'SUMMARY:Later', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:a', 'DTSTART:20260101T120000Z', 'SUMMARY:Sooner', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n'));

  assert.equal(events[0].title, 'Sooner');
});

test('folded lines are rejoined before parsing', () => {
  const folded = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:x',
    'DTSTART:20260401T090000Z',
    'SUMMARY:A very long assignment title that the feed has',
    '  wrapped across two lines',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  const { events } = parseIcs(folded);
  assert.equal(events[0].title,
    'A very long assignment title that the feed has wrapped across two lines');
});

test('unfold joins continuations for both space and tab', () => {
  assert.deepEqual(unfold('A:one\r\n two\r\nB:three'), ['A:onetwo', 'B:three']);
  assert.deepEqual(unfold('A:one\r\n\ttwo'), ['A:onetwo']);
});

test('one malformed event does not discard the rest', () => {
  const mixed = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'UID:bad', 'DTSTART:not-a-date', 'SUMMARY:Broken', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:good', 'DTSTART:20260501T100000Z', 'SUMMARY:Fine', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  const { events, errors } = parseIcs(mixed);
  assert.equal(events.length, 1, 'the good event still arrives');
  assert.equal(events[0].title, 'Fine');
  assert.equal(errors.length, 1, 'and the failure is reported rather than swallowed');
  assert.match(errors[0], /unparseable date/);
});

test('DUE is accepted as well as DTSTART', () => {
  const { events } = parseIcs([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'UID:t', 'DUE:20260610T170000Z', 'SUMMARY:Essay', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n'));

  assert.equal(events[0].due.toISOString(), '2026-06-10T17:00:00.000Z');
});

test('a repeating event reports its rule without expanding the series', () => {
  const { events } = parseIcs([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'UID:r', 'DTSTART:20260302T140000Z', 'SUMMARY:Weekly Quiz',
    'RRULE:FREQ=WEEKLY;COUNT=40', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n'));

  assert.equal(events.length, 1, 'forty rows would drown the widget');
  assert.equal(events[0].recurrence, 'FREQ=WEEKLY;COUNT=40');
});

test('a floating time records its ambiguity instead of hiding it', () => {
  const { events } = parseIcs([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'UID:f', 'DTSTART;TZID=America/New_York:20260701T090000',
    'SUMMARY:Lab', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n'));

  assert.ok(events[0].due instanceof Date);
  assert.equal(events[0].due.getHours(), 9, 'treated as local wall-clock time');
});

test('empty and junk input yields no events and does not throw', () => {
  for (const input of ['', 'not a calendar', undefined, null]) {
    const result = parseIcs(input);
    assert.deepEqual(result.events, []);
  }
});

// ---- urgency bucketing ----------------------------------------------------

test('urgency buckets put overdue first', () => {
  const now = new Date('2026-05-10T12:00:00Z');
  const at = (iso) => ({ title: iso, due: new Date(iso) });

  const buckets = bucketByUrgency([
    at('2026-05-09T12:00:00Z'),   // yesterday
    at('2026-05-10T18:00:00Z'),   // later today
    at('2026-05-14T12:00:00Z'),   // this week
    at('2026-07-01T12:00:00Z'),   // later
    { title: 'undated', due: null },
  ], now);

  assert.equal(buckets.overdue.length, 1);
  assert.equal(buckets.today.length, 1);
  assert.equal(buckets.week.length, 1);
  assert.equal(buckets.later.length, 2, 'undated work sorts with "later", not "overdue"');
});
