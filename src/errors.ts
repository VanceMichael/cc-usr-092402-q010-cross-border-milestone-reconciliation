// 结构化领域错误：HTTP 边界统一映射为状态码 + {error, message, details}。
export class DomainError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new DomainError(400, code, message, details);
export const forbidden = (code: string, message: string, details?: unknown) =>
  new DomainError(403, code, message, details);
export const notFound = (code: string, message: string, details?: unknown) =>
  new DomainError(404, code, message, details);
export const conflict = (code: string, message: string, details?: unknown) =>
  new DomainError(409, code, message, details);
