
// 时间工具：对外时间一律为带偏移量的 ISO 8601 字符串；比较前先转瞬时毫秒。

export function nowIso(): string {
  return new Date().toISOString();
}

export function parseInstant(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`无法解析的时间：${value}`);
  }
  return ms;
}

const ISO_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function isValidIsoOffset(value: unknown): value is string {
  return typeof value === "string" && ISO_OFFSET_RE.test(value) && !Number.isNaN(Date.parse(value));
}

/** 校验 IANA 时区名是否被当前运行环境接受 */
export function isValidTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** 瞬时 -> 指定时区的本地日期（YYYY-MM-DD） */
export function zonedDateString(instantMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instantMs));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** 本地日期 + 时区 -> 该日 00:00 的瞬时毫秒（含 DST 处理） */
export function zonedStartOfDay(date: string, timeZone: string): number {
  const [year, month, day] = date.split("-").map(Number);
  // 先按 UTC 猜测，再用该时区的实际偏移迭代修正
  let guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  for (let i = 0; i < 3; i += 1) {
    const offset = timeZoneOffsetMs(guess, timeZone);
    const candidate = Date.UTC(year, month - 1, day, 0, 0, 0) - offset;
    if (candidate === guess) break;
    guess = candidate;
  }
  return guess;
}

/** 某瞬时在指定时区的 UTC 偏移（毫秒） */
export function timeZoneOffsetMs(instantMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = dtf.formatToParts(new Date(instantMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") === 24 ? 0 : get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** 本地日期（YYYY-MM-DD）是星期几：1=周一 … 7=周日 */
export function dayOfWeek(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return dow === 0 ? 7 : dow;
}

/** 本地日期加减天数 */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const ms = Date.UTC(year, month - 1, day + days);
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function isValidDateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/** 稳定摘要：对排序后的字符串片段做 FNV-1a 64 位指纹（幂等去重与重放一致性用） */
export function digestOf(parts: Array<string | number | undefined | null>): string {
  let hash = 0xcbf29ce484222325n;
  const text = parts.map((p) => String(p ?? "")).join("\u001f");
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}
