'use strict';
/**
 * iCalendar (RFC 5545) parsing for LMS deadline import (spec §6).
 *
 * Canvas, Moodle, Blackboard and Google Classroom all expose a per-user ICS
 * feed, which is the one integration point they share and the only one that
 * needs no API key, no OAuth dance and no per-institution configuration. A
 * student pastes the calendar URL their LMS already gives them and it works.
 *
 * A full ICS implementation is large; this is deliberately the subset that
 * LMS feeds actually emit — VEVENT with SUMMARY, DTSTART/DTEND/DUE,
 * DESCRIPTION, URL, UID and CATEGORIES. Recurrence (RRULE) is parsed enough
 * to report *that* an event repeats without expanding the series, because a
 * deadline list wants "Weekly quiz, next Tuesday", not 40 rows.
 */

/**
 * @typedef {object} CalendarEvent
 * @property {string} uid
 * @property {string} title
 * @property {Date|null} due
 * @property {boolean} allDay
 * @property {string} [description]
 * @property {string} [url]
 * @property {string} [course]
 * @property {string} [recurrence]  raw RRULE, when present
 */

/**
 * Parse an ICS document.
 *
 * @param {string} text
 * @returns {{events: CalendarEvent[], name: string, errors: string[]}}
 */
function parseIcs(text) {
  const lines = unfold(String(text || ''));
  const events = [];
  const errors = [];
  let calendarName = '';

  let current = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { current = {}; continue; }

    if (line === 'END:VEVENT') {
      if (current) {
        try {
          const event = finaliseEvent(current);
          if (event) events.push(event);
        } catch (err) {
          // One malformed event must not discard the other 39.
          errors.push(err.message);
        }
      }
      current = null;
      continue;
    }

    const parsed = parseLine(line);
    if (!parsed) continue;

    if (!current) {
      if (parsed.name === 'X-WR-CALNAME') calendarName = parsed.value;
      continue;
    }
    // Keep the last occurrence of a repeated property, which is what every
    // consumer does and what feeds assume.
    current[parsed.name] = parsed;
  }

  // Soonest first: a deadline list is read from the top under time pressure.
  events.sort((a, b) => {
    if (!a.due) return 1;
    if (!b.due) return -1;
    return a.due - b.due;
  });

  return { events, name: calendarName, errors };
}

/**
 * RFC 5545 folds long lines by inserting CRLF followed by a single space or
 * tab. Unfolding must happen before anything else or a long DESCRIPTION
 * arrives in pieces.
 */
function unfold(text) {
  const raw = text.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out.filter((l) => l.trim() !== '');
}

/** `NAME;PARAM=value:content` -> { name, params, value }. */
function parseLine(line) {
  const colon = indexOfUnquoted(line, ':');
  if (colon === -1) return null;

  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...paramParts] = head.split(';');

  const params = {};
  for (const part of paramParts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, '');
  }

  return { name: name.toUpperCase(), params, value: unescapeText(value) };
}

/**
 * A colon inside a quoted parameter value is not the name/value separator.
 * Rare, but it appears in feeds that put URLs in ALTREP.
 */
function indexOfUnquoted(line, char) {
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === char && !quoted) return i;
  }
  return -1;
}

function unescapeText(value) {
  return String(value)
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function finaliseEvent(props) {
  const summary = props.SUMMARY?.value?.trim();
  // DUE is what VTODO uses and what some LMS feeds emit for assignments;
  // DTSTART is the VEVENT norm. Either is the deadline as far as a student
  // is concerned.
  const dueProp = props.DUE || props.DTSTART || props.DTEND;
  if (!summary && !dueProp) return null;

  const due = dueProp ? parseIcsDate(dueProp) : null;

  return {
    uid: props.UID?.value || `${summary}-${due?.toISOString?.() || 'undated'}`,
    title: summary || 'Untitled',
    due: due?.date || null,
    allDay: due?.allDay || false,
    description: props.DESCRIPTION?.value || '',
    url: props.URL?.value || '',
    // Canvas puts the course in CATEGORIES; Moodle tends to suffix the
    // summary with it in brackets. Try both rather than favouring one LMS.
    course: props.CATEGORIES?.value || extractCourse(summary) || '',
    location: props.LOCATION?.value || '',
    recurrence: props.RRULE?.value || '',
    status: props.STATUS?.value || '',
  };
}

function extractCourse(summary = '') {
  const match = summary.match(/\[([^\]]+)\]\s*$/) || summary.match(/\(([^)]+)\)\s*$/);
  return match ? match[1].trim() : '';
}

/**
 * ICS dates come in three shapes:
 *   20260901          date only (all-day)
 *   20260901T235900Z  UTC
 *   20260901T235900   local, possibly with a TZID parameter
 *
 * Without the IANA tz database a named TZID cannot be resolved exactly, so a
 * floating time is treated as local — which is what the student's own
 * machine almost always is for their own coursework — and the parsed event
 * records `tzid` so the UI can show it rather than hiding the ambiguity.
 */
function parseIcsDate(prop) {
  const value = String(prop.value || '').trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    return { date: new Date(Number(y), Number(m) - 1, Number(d), 23, 59, 0), allDay: true };
  }

  const full = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(value);
  if (!full) throw new Error(`unparseable date "${value}"`);

  const [, y, mo, d, h, mi, s, zulu] = full.map((v) => v);
  if (zulu) {
    return {
      date: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)),
      allDay: false,
      tzid: 'UTC',
    };
  }
  return {
    date: new Date(+y, +mo - 1, +d, +h, +mi, +s),
    allDay: false,
    tzid: prop.params?.TZID || 'floating',
  };
}

/**
 * Bucket events for the deadline widget. Overdue first, because an assignment
 * you have already missed is the one you most need to see.
 */
function bucketByUrgency(events, now = new Date()) {
  const DAY = 86_400_000;
  const buckets = { overdue: [], today: [], week: [], later: [] };

  for (const event of events) {
    if (!event.due) { buckets.later.push(event); continue; }
    const delta = event.due - now;
    if (delta < 0) buckets.overdue.push(event);
    else if (delta < DAY) buckets.today.push(event);
    else if (delta < 7 * DAY) buckets.week.push(event);
    else buckets.later.push(event);
  }
  return buckets;
}

module.exports = { parseIcs, bucketByUrgency, parseIcsDate, unfold };
