const minute = 60_000;
const hour = 60 * minute;
export const day = 24 * hour;

const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const clockPattern = "(?:noon|midnight|eod|\\d{1,2}:\\d{2}(?:\\s*[ap]m)?|\\d{1,2}\\s*[ap]m)";
const weekdayPattern = weekdays.map((name) => `${name.slice(0, 3)}(?:${name.slice(3)})?`).join("|");
const datePattern = `(?:today|tomorrow|(?:next\\s+)?(?:${weekdayPattern})|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2}/\\d{4})`;
const timeExpression = new RegExp(
  `^(?:(${datePattern})(?:\\s+(?:at\\s+)?(${clockPattern}))?|(?:at\\s+)?(${clockPattern})(?:\\s+(?:on\\s+)?(${datePattern}))?)$`,
  "i",
);
const relativeExpression =
  /^(?:(?:in|extend(?:\s+by)?)\s+|\+\s*)?(\d+(?:\.\d+)?)\s*(m(?:in(?:ute)?s?)?|h(?:rs?|ours?)?|d(?:ays?)?|w(?:ks?|eeks?)?)$/i;

type LocalTime = { year: number; month: number; day: number; hour: number; minute: number };

function formatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hourCycle: "h23",
    hour: "numeric",
    minute: "numeric",
  });
}

function localTime(timestamp: number, format: Intl.DateTimeFormat): LocalTime {
  const parts = format.formatToParts(timestamp);
  const number = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: number("year"),
    month: number("month"),
    day: number("day"),
    hour: number("hour"),
    minute: number("minute"),
  };
}

function wallTime({ year, month, day, hour, minute }: LocalTime): number {
  return Date.UTC(year, month - 1, day, hour, minute);
}

function toTimestamp(value: LocalTime, format: Intl.DateTimeFormat): number | undefined {
  const wall = wallTime(value);
  const date = new Date(wall);
  if (
    date.getUTCFullYear() !== value.year ||
    date.getUTCMonth() + 1 !== value.month ||
    date.getUTCDate() !== value.day
  )
    return;

  const guess = wall - (wallTime(localTime(wall, format)) - wall);
  const timestamp = wall - (wallTime(localTime(guess, format)) - guess);
  // Reject local times that do not exist on the daylight-saving transition.
  if (wallTime(localTime(timestamp, format)) === wall) return timestamp;
}

function parseClock(clock: string | undefined): [number, number] | undefined {
  if (clock === "midnight") return [0, 0];
  if (clock === "noon") return [12, 0];
  if (clock === "eod" || !clock) return [17, 0];
  const match = /^(\d{1,2})(?::(\d{2}))?\s*([ap]m)?$/.exec(clock);
  if (!match) return;
  let hours = Number(match[1]);
  const minutes = Number(match[2] ?? 0);
  const period = match[3];
  if (minutes > 59 || hours > 23 || (period && (hours < 1 || hours > 12))) return;
  if (period) hours = (hours % 12) + (period === "pm" ? 12 : 0);
  return [hours, minutes];
}

function dateAfter(clock: LocalTime, days: number): LocalTime {
  const date = new Date(wallTime(clock) + days * day);
  return {
    ...clock,
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

export function weeklyDigestWindow(now: number, timeZone: string): { start: number; end: number } {
  const format = formatter(timeZone);
  const cutoff = { ...localTime(now, format), hour: 17, minute: 0 };
  const daysSinceFriday = (new Date(wallTime(cutoff)).getUTCDay() + 2) % 7;
  const friday = dateAfter(cutoff, -daysSinceFriday);
  const fridayEnd = toTimestamp(friday, format);
  if (fridayEnd === undefined) throw new Error("Could not determine the Friday digest cutoff");

  const endDate = fridayEnd <= now ? friday : dateAfter(friday, -7);
  const start = toTimestamp(dateAfter(endDate, -7), format);
  const end = toTimestamp(endDate, format);
  if (start === undefined || end === undefined) throw new Error("Could not determine the digest week");
  return { start, end };
}

export function parseDeadline(
  value: string,
  reference: number,
  timeZone: string,
  relativeTo = reference,
): number | undefined {
  const input = value.trim().toLowerCase();
  const relative = relativeExpression.exec(input);
  if (relative) {
    const unit = relative[2]?.[0];
    const factor = unit === "m" ? minute : unit === "h" ? hour : unit === "d" ? day : 7 * day;
    const timestamp = Math.round(relativeTo + Number(relative[1]) * factor);
    if (timestamp > relativeTo && timestamp <= 8.64e15) return timestamp;
    return;
  }

  const expression = timeExpression.exec(input);
  if (!expression) return;
  const date = expression[1] ?? expression[4];
  const clock = parseClock(expression[2] ?? expression[3]);
  if (!clock) return;

  const format = formatter(timeZone);
  const [hours, minutes] = clock;
  let local = { ...localTime(reference, format), hour: hours, minute: minutes };
  if (date?.includes("/")) {
    const [dateDay, month, year] = date.split("/").map(Number);
    local = { ...local, day: dateDay!, month: month!, year: year! };
  } else if (date?.includes("-")) {
    const [year, month, dateDay] = date.split("-").map(Number);
    local = { ...local, year: year!, month: month!, day: dateDay! };
  } else if (date === "tomorrow") {
    local = dateAfter(local, 1);
  } else if (date && date !== "today") {
    const next = date.startsWith("next ");
    const name = date.slice(next ? 5 : 0, next ? 8 : 3);
    const weekday = weekdays.findIndex((day) => day.startsWith(name));
    const current = new Date(wallTime(local)).getUTCDay();
    const offset = (weekday - current + 7) % 7;
    const sameDayHasPassed = (toTimestamp(local, format) ?? -Infinity) <= reference;
    local = dateAfter(local, offset || (next || sameDayHasPassed ? 7 : 0));
  }

  const timestamp = toTimestamp(local, format);
  if (timestamp !== undefined && timestamp > reference) return timestamp;
  if (!date && timestamp !== undefined) return toTimestamp(dateAfter(local, 1), format);
}

const deadlineSuffix = new RegExp(
  `(?:^|\\s)(?:(?:${datePattern})(?:\\s+(?:at\\s+)?${clockPattern})?|(?:at\\s+)?${clockPattern}(?:\\s+(?:on\\s+)?${datePattern})?|(?:in\\s+\\d+(?:\\.\\d+)?\\s*[a-z]+))$`,
  "i",
);
const dateLike = new RegExp(
  `^(?:${datePattern}\\b|${clockPattern}\\b|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\s+\\d|end\\s+of\\b|next\\s+(?:week|month|year)\\b|in\\s+\\d|\\d)`,
  "i",
);

export function taskDeadline(
  description: string,
  reference: number,
  timeZone: string,
): number | undefined {
  const input = description.trim().replace(/[.!?]+$/, "");
  const labelled = /\s+due:\s*(.+)$/i.exec(input)?.[1];
  if (labelled) return parseDeadline(labelled, reference, timeZone);
  const deadline = /\s+(?:by|before|due(?:\s+(?:by|at|on))?)\s+(.+)$/i.exec(input)?.[1];
  if (deadline && (dateLike.test(deadline) || relativeExpression.test(deadline))) {
    return parseDeadline(deadline, reference, timeZone);
  }
  const trailing = deadlineSuffix.exec(input);
  return trailing ? parseDeadline(trailing[0], reference, timeZone) : reference + day;
}

export function displayDeadline(timestamp: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(timestamp);
}
