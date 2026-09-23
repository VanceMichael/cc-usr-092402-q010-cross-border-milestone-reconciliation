// 时区与本地日历换算。
// 全部时间对外使用带偏移量的 ISO 8601；内部以 epoch 毫秒比较；
// 日历调整只依赖各方登记的周末与假日/补班覆盖，不读取任何外部日历服务。

const INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type Side = "A" | "B";
export type DayKind = "holiday" | "workday";

export interface PartyCalendar {
  side: Side;
  ianaTimezone: string;
  weekendDays: number[]; // 0=周日 … 6=周六
  // local_date -> 当日覆盖类型，优先于周末规则（补班 workday / 假日 holiday）
  overrides: Record<string, DayKind>;
}

/** 严格解析带偏移 ISO 8601；返回 epoch 毫秒。 */
export function parseInstant(value: string): number {
  if (typeof value !== "string" || !INSTANT_PATTERN.test(value)) {
    throw new Error(`时间必须为带偏移量的 ISO 8601 字符串：${value}`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`无法解析的时间：${value}`);
  }
  return ms;
}

export function isValidInstant(value: unknown): value is string {
  return typeof value === "string" && INSTANT_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

export function isValidLocalDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== "string" || !value.includes("/")) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

interface TimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function timeParts(epochMs: number, timeZone: string): TimeParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(epochMs));
  const get = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`时区 ${timeZone} 缺少时间分量 ${type}`);
    return Number(part.value);
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** epoch 毫秒在指定时区下的本地日历日 YYYY-MM-DD。 */
export function toLocalDate(epochMs: number, timeZone: string): string {
  const p = timeParts(epochMs, timeZone);
  return formatDate(p.year, p.month, p.day);
}

export function formatDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return formatDate(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}

export function localDayOfWeek(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * 本地日历日 00:00 对应的 epoch 毫秒。
 * 若该墙上时刻因夏令时跳转不存在，返回当日第一个实际存在的分钟；
 * 回拨重叠时取第一次经过午夜的瞬间。
 */
export function localDateStartInstant(date: string, timeZone: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const naiveUtc = Date.UTC(y, m - 1, d); // 把本地墙上时间先当 UTC
  const p0 = timeParts(naiveUtc, timeZone);
  const localAsUtc = Date.UTC(p0.year, p0.month - 1, p0.day, p0.hour, p0.minute, p0.second);
  let instant = naiveUtc - (localAsUtc - naiveUtc);

  const p = timeParts(instant, timeZone);
  const exact = p.year === y && p.month === m && p.day === d && p.hour === 0 && p.minute === 0;
  if (!exact) {
    // 极少数在午夜发生跳转的时区：在 ±6 小时窗口内按分钟找当日第一刻
    for (let t = instant - 6 * 3_600_000; t <= instant + 6 * 3_600_000; t += 60_000) {
      if (toLocalDate(t, timeZone) === date) {
        instant = t;
        break;
      }
    }
  }
  return instant;
}

/** 某日本地是否工作日：显式登记（假日/补班）优先，其次周末规则。 */
export function isWorkday(date: string, calendar: PartyCalendar): boolean {
  const override = calendar.overrides[date];
  if (override === "workday") return true;
  if (override === "holiday") return false;
  return !calendar.weekendDays.includes(localDayOfWeek(date));
}

/** 假日调整策略：as_is 保持当日；next_workday 顺延到最近的工作日。 */
export function adjustDueDate(date: string, calendar: PartyCalendar, policy: "as_is" | "next_workday"): string {
  if (policy === "as_is" || isWorkday(date, calendar)) return date;
  let cursor = date;
  for (let i = 0; i < 366; i += 1) {
    cursor = addDays(cursor, 1);
    if (isWorkday(cursor, calendar)) return cursor;
  }
  throw new Error(`假日顺延超过 366 天，日历数据可能异常：${calendar.side}`);
}

/**
 * 到期判定上界：经假日调整后的到期日“当天结束”，
 * 用次日本地 00:00 作为排他瞬间，完成时刻 >= 该值即逾期。
 */
export function deadlineInstant(
  dueLocalDate: string,
  calendar: PartyCalendar,
  policy: "as_is" | "next_workday",
): number {
  const adjusted = adjustDueDate(dueLocalDate, calendar, policy);
  return localDateStartInstant(addDays(adjusted, 1), calendar.ianaTimezone);
}

export interface DueView {
  declaredDueDate: string;
  adjustedDueDate: string;
  deadline: string; // ISO instant（排他上界）
  completedAt: string | null;
  overdue: boolean | null; // 未完成时为 null
  pendingOverdue: boolean; // 未完成且当前时点已越过截止
}

/** 生成单方视角的到期/逾期视图。 */
export function buildDueView(input: {
  declaredDueDate: string;
  holidayPolicy: "as_is" | "next_workday";
  calendar: PartyCalendar;
  completedAt: number | null;
  now: number;
}): DueView {
  const adjusted = adjustDueDate(input.declaredDueDate, input.calendar, input.holidayPolicy);
  const cutoff = localDateStartInstant(addDays(adjusted, 1), input.calendar.ianaTimezone);
  return {
    declaredDueDate: input.declaredDueDate,
    adjustedDueDate: adjusted,
    deadline: new Date(cutoff).toISOString(),
    completedAt: input.completedAt === null ? null : new Date(input.completedAt).toISOString(),
    overdue: input.completedAt === null ? null : input.completedAt >= cutoff,
    pendingOverdue: input.completedAt === null && input.now >= cutoff,
  };
}
