import { t } from "@t3tools/shared/i18n";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatScheduledTaskInterval(everyMs: number): string {
  const units = [
    [7 * DAY, t("settings.scheduledTaskPresentation.week")],
    [DAY, t("settings.scheduledTaskPresentation.day")],
    [HOUR, t("settings.scheduledTaskPresentation.hour")],
    [MINUTE, t("settings.scheduledTaskPresentation.minute")],
    [1_000, t("settings.scheduledTaskPresentation.second")],
    [1, t("settings.scheduledTaskPresentation.millisecond")],
  ] as const;
  let remaining = everyMs;
  const parts: string[] = [];
  for (const [size, unit] of units) {
    const count = Math.floor(remaining / size);
    if (count === 0) continue;
    if (count === 1 && remaining === everyMs && remaining === size) {
      return t("settings.scheduledTaskPresentation.everySingleUnit", { unit });
    }
    parts.push(t("settings.scheduledTaskPresentation.unitCount", { count, unit }));
    remaining %= size;
  }
  return t("settings.scheduledTaskPresentation.everyUnits", { units: parts.join(" ") });
}

function localCalendarDay(date: Date): number {
  // Compare calendar days, not 24-hour spans: DST days can have 23 or 25 hours.
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY;
}

export function formatNextScheduledTaskRun(nextRunAt: string, now: number): string {
  const next = new Date(nextRunAt);
  const current = new Date(now);
  const remaining = next.getTime() - now;
  if (!Number.isFinite(remaining)) {
    return t("settings.scheduledTaskPresentation.nextRunUnavailable");
  }
  if (remaining <= 0) return t("settings.scheduledTaskPresentation.nextRunDue");

  const days = localCalendarDay(next) - localCalendarDay(current);
  if (days === 0) {
    if (remaining < MINUTE) {
      return t("settings.scheduledTaskPresentation.nextRunInLessThanAMinute");
    }
    const unit =
      remaining < HOUR
        ? t("settings.scheduledTaskPresentation.minute")
        : t("settings.scheduledTaskPresentation.hour");
    const count = Math.round(remaining / (remaining < HOUR ? MINUTE : HOUR));
    return t("settings.scheduledTaskPresentation.nextRunIn", { count, unit });
  }

  const time = next.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 1) return t("settings.scheduledTaskPresentation.nextRunTomorrowAt", { time });
  if (days <= 7) {
    return t("settings.scheduledTaskPresentation.nextRunNextWeekdayAt", {
      weekday: next.toLocaleDateString([], { weekday: "long" }),
      time,
    });
  }
  const date = next.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(next.getFullYear() !== current.getFullYear() ? { year: "numeric" as const } : {}),
  });
  return t("settings.scheduledTaskPresentation.nextRunOnDateAt", { date, time });
}
