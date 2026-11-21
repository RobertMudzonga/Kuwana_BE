import { z } from 'zod';

/**
 * Weekly opening hours for store branches, in Africa/Harare local time (UTC+2, no DST).
 *
 * Shape: { mon: [["08:00","17:00"]], tue: [...], ..., sun: [] }
 * A day with no intervals (or a missing key) is closed. Intervals may not cross midnight;
 * use "00:00"–"24:00" style splits instead (e.g. fri ["18:00","24:00"] + sat ["00:00","02:00"]).
 */

export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Day = (typeof DAYS)[number];
export type OperatingHours = Partial<Record<Day, [string, string][]>>;

const HARARE_OFFSET_MINUTES = 120;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;

const toMinutes = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

const interval = z
  .tuple([z.string().regex(TIME_RE, 'Use HH:MM'), z.string().regex(TIME_RE, 'Use HH:MM')])
  .refine(([open, close]) => toMinutes(close) > toMinutes(open), { message: 'Closing time must be after opening time' });

export const operatingHoursSchema = z
  .object(Object.fromEntries(DAYS.map((d) => [d, z.array(interval).max(4).optional()])) as Record<Day, z.ZodOptional<z.ZodArray<typeof interval>>>)
  .strict();

/** Parse stored JSON defensively: anything malformed counts as closed rather than throwing */
export function parseHours(raw: unknown): OperatingHours {
  const parsed = operatingHoursSchema.safeParse(raw ?? {});
  return parsed.success ? (parsed.data as OperatingHours) : {};
}

/** Day index (0 = Sunday) and minute-of-day in Harare */
function harareClock(at: Date) {
  const local = new Date(at.getTime() + HARARE_OFFSET_MINUTES * 60_000);
  return { day: local.getUTCDay(), minute: local.getUTCHours() * 60 + local.getUTCMinutes(), local };
}

export function isOpenAt(raw: unknown, at: Date): boolean {
  const hours = parseHours(raw);
  const { day, minute } = harareClock(at);
  return (hours[DAYS[day]] ?? []).some(([o, c]) => minute >= toMinutes(o) && minute < toMinutes(c));
}

/** Next time the branch opens after `at` (within a week), or null if it never opens */
export function nextOpening(raw: unknown, at: Date): Date | null {
  const hours = parseHours(raw);
  const { day, minute, local } = harareClock(at);
  const midnightLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  for (let offset = 0; offset <= 7; offset++) {
    const d = (day + offset) % 7;
    const opens = (hours[DAYS[d]] ?? []).map(([o]) => toMinutes(o)).filter((m) => offset > 0 || m > minute).sort((a, b) => a - b);
    if (opens.length) {
      return new Date(midnightLocal + offset * 86_400_000 + opens[0] * 60_000 - HARARE_OFFSET_MINUTES * 60_000);
    }
  }
  return null;
}

/** "Opens 08:00", "Opens Mon 08:00" — for availability labels */
export function opensLabel(next: Date | null, at: Date): string {
  if (!next) return 'Closed';
  const n = harareClock(next);
  const hhmm = `${String(Math.floor(n.minute / 60)).padStart(2, '0')}:${String(n.minute % 60).padStart(2, '0')}`;
  const today = harareClock(at).day;
  if (n.day === today && next.getTime() - at.getTime() < 86_400_000) return `Opens ${hhmm}`;
  if (n.day === (today + 1) % 7) return `Opens tomorrow ${hhmm}`;
  return `Opens ${DAYS[n.day][0].toUpperCase()}${DAYS[n.day].slice(1)} ${hhmm}`;
}

/** Typical retail hours, used as the default for new branches */
export const DEFAULT_HOURS: OperatingHours = {
  mon: [['08:00', '17:30']],
  tue: [['08:00', '17:30']],
  wed: [['08:00', '17:30']],
  thu: [['08:00', '17:30']],
  fri: [['08:00', '17:30']],
  sat: [['08:00', '13:00']],
  sun: [],
};
