/**
 * Minimal cron expression support.
 *
 * Implements the five standard fields (minute hour day-of-month month
 * day-of-week) with `*`, numbers, ranges (`1-5`), steps (`*​/10`, `1-30/5`) and
 * comma lists. Enough for scheduling a backup; deliberately not a full
 * implementation of cron's extensions (`L`, `W`, `#`, `@reboot`), because
 * silently mis-reading an unsupported token would be worse than rejecting it.
 *
 * Field semantics follow POSIX: when both day-of-month and day-of-week are
 * restricted, a day matches if *either* matches.
 */

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 6 },
];

/** Month and weekday names, mapped to their numeric value. */
const NAMES = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

/**
 * Parse one field into a set of allowed values.
 *
 * @param {string} raw
 * @param {{ min: number, max: number, name: string }} spec
 * @returns {Set<number> | null}
 */
function parseField(raw, spec) {
  const text = raw.trim().toLowerCase();
  if (!text) return null;

  const values = new Set();

  for (const part of text.split(',')) {
    const token = part.trim();
    if (!token) return null;

    // step: `*/n`, `a-b/n`, or a bare `n` (cron treats a bare number as `n/n`
    // only in the step position, which we do not support)
    const [rangePart, stepPart] = token.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) return null;

    let start;
    let end;
    if (rangePart === '*') {
      start = spec.min;
      end = spec.max;
    } else if (rangePart.includes('-')) {
      const [left, right] = rangePart.split('-');
      start = resolveValue(left, spec);
      end = resolveValue(right, spec);
    } else {
      start = resolveValue(rangePart, spec);
      end = start;
    }

    if (start === null || end === null) return null;
    if (start < spec.min || end > spec.max || start > end) return null;

    for (let value = start; value <= end; value += step) values.add(value);
  }

  return values.size > 0 ? values : null;
}

/** Turn a token into a number, honouring month/weekday names. */
function resolveValue(token, spec) {
  const cleaned = String(token).trim();
  if (/^\d{1,2}$/.test(cleaned)) {
    const value = Number(cleaned);
    return Number.isInteger(value) ? value : null;
  }
  const named = NAMES[cleaned];
  if (named === undefined) return null;
  // Names are only valid in the month and weekday fields.
  if (spec.name === 'month' && named >= 1) return named;
  if (spec.name === 'dayOfWeek') return named;
  return null;
}

/**
 * Parse a complete expression.
 *
 * @param {string} expression
 * @returns {{ minute: Set<number>, hour: Set<number>, dayOfMonth: Set<number>, month: Set<number>, dayOfWeek: Set<number>, dayOfMonthRestricted: boolean, dayOfWeekRestricted: boolean } | null}
 */
export function parseCron(expression) {
  const parts = String(expression ?? '').trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const parsed = {};
  for (let index = 0; index < FIELDS.length; index += 1) {
    const spec = FIELDS[index];
    const values = parseField(parts[index], spec);
    if (!values) return null;
    parsed[spec.name] = values;
  }

  // POSIX quirk: `*` in day-of-month/day-of-week means "no restriction", and when
  // one is restricted the other is ignored. Precomputing this keeps matchesCron
  // readable and avoids re-checking `*` every tick.
  parsed.dayOfMonthRestricted = !parts[2].startsWith('*');
  parsed.dayOfWeekRestricted = !parts[4].startsWith('*');

  return parsed;
}

/**
 * Does the expression match this instant?
 *
 * @param {ReturnType<typeof parseCron>} parsed
 * @param {Date} date
 */
export function matchesCron(parsed, date) {
  if (!parsed) return false;
  if (!parsed.minute.has(date.getMinutes())) return false;
  if (!parsed.hour.has(date.getHours())) return false;
  if (!parsed.month.has(date.getMonth() + 1)) return false;

  const domMatch = parsed.dayOfMonth.has(date.getDate());
  const dowMatch = parsed.dayOfWeek.has(date.getDay());

  // Both restricted → either may match (POSIX OR semantics).
  if (parsed.dayOfMonthRestricted && parsed.dayOfWeekRestricted) return domMatch || dowMatch;
  if (parsed.dayOfMonthRestricted) return domMatch;
  if (parsed.dayOfWeekRestricted) return dowMatch;
  return true;
}

/** Human-readable summary, used in the job list. */
export function describeCron(expression) {
  const parsed = parseCron(expression);
  if (!parsed) return String(expression);

  const parts = String(expression).trim().split(/\s+/);
  if (parts[0].startsWith('*/') && parts[1] === '*' && parts[2] === '*' && parts[3] === '*' && parts[4] === '*') {
    return `每 ${parts[0].slice(2)} 分钟`;
  }
  if (parts[0] !== '*' && parts[1] === '*' && parts[2] === '*' && parts[3] === '*' && parts[4] === '*') {
    return `每小时第 ${parts[0]} 分`;
  }
  if (parts[0] !== '*' && parts[1] !== '*' && parts[2] === '*' && parts[3] === '*' && parts[4] === '*') {
    return `每天 ${parts[1].padStart(2, '0')}:${parts[0].padStart(2, '0')}`;
  }
  return String(expression);
}
