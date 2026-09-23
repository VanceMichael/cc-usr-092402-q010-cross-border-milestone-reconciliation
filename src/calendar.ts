
// 工作日历：周工作模式 + 假日表（含调休上班日），提供假日顺延规则。

import { addDays, dayOfWeek, zonedDateString, zonedStartOfDay } from "./time.js";
import type { CalendarRow, HolidayRow } from "./types.js";

export type { CalendarRow, HolidayRow } from "./types.js";

export interface HolidayAdjustment {
  original_date: string;
  adjusted_date: string;
  shifted_days: number;
  skipped: Array<{ date: string; reason: string }>;
}

function workFlag(row: CalendarRow, dow: number): number {
  switch (dow) {
    case 1: return row.work_mon;
    case 2: return row.work_tue;
    case 3: return row.work_wed;
    case 4: return row.work_thu;
    case 5: return row.work_fri;
    case 6: return row.work_sat;
    default: return row.work_sun;
  }
}

/** 某日是否为工作日：调休上班日 > 假日 > 周工作模式 */
export function isWorkday(row: CalendarRow, holidays: HolidayRow[], date: string): boolean {
  const holiday = holidays.find((h) => h.holiday_date === date);
  if (holiday) return holiday.workday_override === 1;
  return workFlag(row, dayOfWeek(date)) === 1;
}

/**
 * 假日调整规则：若截止日落在非工作日，顺延到下一个工作日。
 * 返回完整跳过轨迹，供结论 details 解释“差异从何产生”。
 */
export function adjustToWorkday(
  row: CalendarRow,
  holidays: HolidayRow[],
  date: string,
): HolidayAdjustment {
  const skipped: HolidayAdjustment["skipped"] = [];
  let current = date;
  for (let guard = 0; guard < 370 && !isWorkday(row, holidays, current); guard += 1) {
    const holiday = holidays.find((h) => h.holiday_date === current);
    skipped.push({
      date: current,
      reason: holiday ? `假日：${holiday.name}` : "非工作日（周模式）",
    });
    current = addDays(current, 1);
  }
  return {
    original_date: date,
    adjusted_date: current,
    shifted_days: skipped.length,
    skipped,
  };
}

/** 约定日期（带偏移 ISO）在该日历下的截止瞬时：本地日终 23:59:59.999 之后即逾期 */
export function deadlineInstant(row: CalendarRow, holidays: HolidayRow[], plannedIso: string): {
  local_date: string;
  adjustment: HolidayAdjustment;
  deadline_ms: number;
} {
  const plannedMs = Date.parse(plannedIso);
  const localDate = zonedDateString(plannedMs, row.iana_timezone);
  const adjustment = adjustToWorkday(row, holidays, localDate);
  const deadlineMs = zonedStartOfDay(adjustment.adjusted_date, row.iana_timezone) + 86_400_000 - 1;
  return { local_date: localDate, adjustment, deadline_ms: deadlineMs };
}

/** 完成瞬时在该日历下落在哪个本地日期 */
export function completionLocalDate(row: CalendarRow, instantMs: number): string {
  return zonedDateString(instantMs, row.iana_timezone);
}
