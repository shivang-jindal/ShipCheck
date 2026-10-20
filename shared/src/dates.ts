/**
 * Date helpers.
 *
 * Everything persisted is a UTC ISO-8601 timestamp or a calendar `YYYY-MM-DD`
 * date. Timezone-sensitive scheduling (reminders) uses the organization's
 * configured IANA timezone via `Intl.DateTimeFormat`, so daylight-saving
 * transitions are handled by the platform rather than by hand-rolled offsets.
 */

export function todayIso(timezone = 'UTC'): string {
  return formatDateInTimeZone(new Date(), timezone);
}

export function formatDateInTimeZone(date: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(date);
}

/** `YYYY-MM-DD` -> `YYYY-MM-DDTHH:MM:SSZ` (start of that UTC day). */
export function dateToUtcIsoStart(date: string): string {
  return `${date}T00:00:00.000Z`;
}

/** `YYYY-MM-DD` -> next day start, exclusive range end. */
export function dateToUtcIsoEndExclusive(date: string): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString();
}

export function addDaysIso(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Whole days between two ISO dates (`to - from`). Positive when `to` is later. */
export function daysBetweenIso(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((b - a) / 86_400_000);
}

export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Convert a wall-clock time in `timezone` to a UTC instant.
 * Returns `null` for a local time that does not exist (spring-forward gap).
 */
export function zonedWallClockToUtc(
  date: string,
  time: string,
  timezone: string,
): Date | null {
  const target = Date.parse(`${date}T${time}:00.000Z`);
  if (Number.isNaN(target)) return null;

  for (let offsetMinutes = -14 * 60; offsetMinutes <= 14 * 60; offsetMinutes += 15) {
    const candidate = new Date(target - offsetMinutes * 60_000);
    if (formatDateInTimeZone(candidate, timezone) === date) {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(candidate);
      if (parts === time) return candidate;
    }
  }
  return null;
}

/** Minutes since midnight in `timezone` for an instant. */
export function minutesSinceMidnightInZone(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(instant);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

export function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function formatIsoTimestamp(date: Date | string | null): string | null {
  if (date === null) return null;
  const value = typeof date === 'string' ? new Date(date) : date;
  return Number.isNaN(value.getTime()) ? null : value.toISOString();
}