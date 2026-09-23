
/** HTTP 边界结构化错误：状态码 + 稳定错误码 + 中文说明 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function badRequest(code: string, message: string): HttpError {
  return new HttpError(400, code, message);
}

export function forbidden(message: string): HttpError {
  return new HttpError(403, "forbidden", message);
}

export function notFound(message: string): HttpError {
  return new HttpError(404, "not_found", message);
}

export function conflict(code: string, message: string): HttpError {
  return new HttpError(409, code, message);
}
