import { describe, expect, it } from "vite-plus/test";
import { t } from "@t3tools/shared/i18n";
import {
  formatNextScheduledTaskRun,
  formatScheduledTaskInterval,
} from "./scheduledTaskPresentation";

const MINUTE = 60_000;
const now = new Date(2026, 8, 17, 9).getTime();
const timeLabel = (date: Date) =>
  date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

describe("formatScheduledTaskInterval", () => {
  it.each([
    [1, "每分钟"],
    [15, "每 15 分钟"],
    [60, "每小时"],
    [90, "每 1 小时 30 分钟"],
    [120, "每 2 小时"],
    [1440, "每天"],
    [1500, "每 1 天 1 小时"],
    [2880, "每 2 天"],
    [10080, "每周"],
  ])("formats a %i-minute interval as %s", (minutes, expected) => {
    expect(formatScheduledTaskInterval(minutes * MINUTE)).toBe(expected);
  });

  it("retains precision for legacy sub-minute schedules", () => {
    expect(formatScheduledTaskInterval(30_000)).toBe("每 30 秒");
    expect(formatScheduledTaskInterval(90_000)).toBe("每 1 分钟 30 秒");
  });
});

describe("formatNextScheduledTaskRun", () => {
  it.each([
    [30_000, t("settings.scheduledTaskPresentation.nextRunInLessThanAMinute")],
    [
      MINUTE,
      t("settings.scheduledTaskPresentation.nextRunIn", {
        count: 1,
        unit: t("settings.scheduledTaskPresentation.minute"),
      }),
    ],
    [
      15 * MINUTE,
      t("settings.scheduledTaskPresentation.nextRunIn", {
        count: 15,
        unit: t("settings.scheduledTaskPresentation.minute"),
      }),
    ],
    [
      60 * MINUTE,
      t("settings.scheduledTaskPresentation.nextRunIn", {
        count: 1,
        unit: t("settings.scheduledTaskPresentation.hour"),
      }),
    ],
    [
      120 * MINUTE,
      t("settings.scheduledTaskPresentation.nextRunIn", {
        count: 2,
        unit: t("settings.scheduledTaskPresentation.hour"),
      }),
    ],
    [0, t("settings.scheduledTaskPresentation.nextRunDue")],
    [-MINUTE, t("settings.scheduledTaskPresentation.nextRunDue")],
  ])("formats a nearby run %i ms away", (offset, expected) => {
    expect(formatNextScheduledTaskRun(new Date(now + offset).toISOString(), now)).toBe(expected);
  });

  it("uses tomorrow by calendar date, including runs just across midnight", () => {
    const current = new Date(2026, 8, 17, 23, 50);
    const next = new Date(2026, 8, 18, 0, 10);
    expect(formatNextScheduledTaskRun(next.toISOString(), current.getTime())).toBe(
      t("settings.scheduledTaskPresentation.nextRunTomorrowAt", { time: timeLabel(next) }),
    );
  });

  it("uses the next weekday within a week", () => {
    const next = new Date(2026, 8, 21, 14, 30);
    expect(formatNextScheduledTaskRun(next.toISOString(), now)).toBe(
      t("settings.scheduledTaskPresentation.nextRunNextWeekdayAt", {
        weekday: next.toLocaleDateString([], { weekday: "long" }),
        time: timeLabel(next),
      }),
    );
  });

  it("includes the date for more distant runs and the year only when necessary", () => {
    for (const next of [new Date(2026, 9, 5, 9), new Date(2027, 0, 1, 9)]) {
      const date = next.toLocaleDateString([], {
        month: "short",
        day: "numeric",
        ...(next.getFullYear() === 2026 ? {} : { year: "numeric" as const }),
      });
      expect(formatNextScheduledTaskRun(next.toISOString(), now)).toBe(
        t("settings.scheduledTaskPresentation.nextRunOnDateAt", { date, time: timeLabel(next) }),
      );
    }
  });

  it("does not show an invalid date", () => {
    expect(formatNextScheduledTaskRun("invalid", now)).toBe(
      t("settings.scheduledTaskPresentation.nextRunUnavailable"),
    );
  });
});
