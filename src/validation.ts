
// HTTP 边界校验：结构化错误，非法输入一律 4xx，不进入领域层。

import { badRequest } from "./errors.js";
import { isValidDateOnly, isValidIsoOffset, isValidTimeZone } from "./time.js";

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export function jsonBody(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw badRequest("invalid_body", "请求体必须是 JSON 对象");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw badRequest("invalid_json", "请求体不是合法 JSON");
    }
    throw error;
  }
}

export function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw badRequest("missing_field", `缺少必填文本字段：${key}`);
  }
  return value;
}

export function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw badRequest("invalid_field", `字段类型错误：${key}`);
  return value;
}

export function requireNumber(body: Record<string, unknown>, key: string, min = 0): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    throw badRequest("invalid_field", `字段必须为不小于 ${min} 的数字：${key}`);
  }
  return value;
}

export function optionalNumber(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw badRequest("invalid_field", `字段必须为非负数字：${key}`);
  }
  return value;
}

export function requireIso(body: Record<string, unknown>, key: string): string {
  const value = requireString(body, key);
  if (!isValidIsoOffset(value)) {
    throw badRequest("invalid_time", `时间必须是带偏移量的 ISO 8601 字符串：${key}`);
  }
  return value;
}

export function optionalIso(body: Record<string, unknown>, key: string): string | undefined {
  const value = optionalString(body, key);
  if (value !== undefined && !isValidIsoOffset(value)) {
    throw badRequest("invalid_time", `时间必须是带偏移量的 ISO 8601 字符串：${key}`);
  }
  return value;
}

export function requireDigest(body: Record<string, unknown>, key: string): string {
  const value = requireString(body, key);
  if (!DIGEST_RE.test(value)) {
    throw badRequest("invalid_digest", `摘要格式必须为 sha256:<64位十六进制>：${key}`);
  }
  return value;
}

export function optionalDigest(body: Record<string, unknown>, key: string): string | undefined {
  const value = optionalString(body, key);
  if (value !== undefined && !DIGEST_RE.test(value)) {
    throw badRequest("invalid_digest", `摘要格式必须为 sha256:<64位十六进制>：${key}`);
  }
  return value;
}

export function requireDateOnly(body: Record<string, unknown>, key: string): string {
  const value = requireString(body, key);
  if (!isValidDateOnly(value)) {
    throw badRequest("invalid_date", `日期必须为 YYYY-MM-DD：${key}`);
  }
  return value;
}

export function requireTimeZone(body: Record<string, unknown>, key: string): string {
  const value = requireString(body, key);
  if (!isValidTimeZone(value)) {
    throw badRequest("invalid_timezone", `不被运行环境接受的 IANA 时区：${value}`);
  }
  return value;
}

export function requireStringArray(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw badRequest("invalid_field", `字段必须为字符串数组：${key}`);
  }
  return value as string[];
}

export function requireWorkdayFlags(body: Record<string, unknown>): Record<string, number> {
  const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const flags: Record<string, number> = {};
  for (const day of days) {
    const key = `work_${day}`;
    const value = body[key] ?? (day === "sat" || day === "sun" ? 0 : 1);
    if (value !== 0 && value !== 1) {
      throw badRequest("invalid_field", `${key} 必须为 0 或 1`);
    }
    flags[key] = value;
  }
  return flags;
}
