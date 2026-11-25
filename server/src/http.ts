// Errors and request helpers, in Outline's shapes.
//
// Every error answers { ok: false, error: <code>, status, message } like Outline's API, with the same
// codes (authentication_required, authorization_error, not_found, validation_error, …): clients match
// on them.

import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { CLIENT_IP_HEADER } from "./config.ts";

export type ErrorCode =
  | "authentication_required"
  | "authorization_error"
  | "not_found"
  | "validation_error"
  | "invalid_request"
  | "rate_limit_exceeded"
  | "payload_too_large"
  | "csrf_error"
  | "internal_server_error";

const STATUS: Record<ErrorCode, 400 | 401 | 403 | 404 | 413 | 429 | 500> = {
  authentication_required: 401,
  authorization_error: 403,
  not_found: 404,
  validation_error: 400,
  invalid_request: 400,
  rate_limit_exceeded: 429,
  payload_too_large: 413,
  csrf_error: 403,
  internal_server_error: 500,
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: 400 | 401 | 403 | 404 | 413 | 429 | 500;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
  }
  toJSON() {
    return { ok: false, error: this.code, status: this.status, message: this.message };
  }
}

export const unauthenticated = (message = "Authentication required") => new ApiError("authentication_required", message);
export const forbidden = (message = "Authorization error") => new ApiError("authorization_error", message);
export const notFound = (message = "Resource not found") => new ApiError("not_found", message);
export const invalid = (message: string) => new ApiError("validation_error", message);

export function clientIp(c: Context): string {
  if (CLIENT_IP_HEADER) {
    const ip = c.req.header(CLIENT_IP_HEADER)?.split(",").at(-1)?.trim();
    if (ip) return ip;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

const hits = new Map<string, number[]>();

/** Sliding-window limit per bucket and client IP. */
export function rateLimit(c: Context, bucket: string, limit: number, windowMs: number) {
  const key = `${bucket}:${clientIp(c)}`;
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 10_000) for (const [k, times] of hits) if (times[times.length - 1] < now - 60 * 60_000) hits.delete(k);
  if (recent.length > limit) throw new ApiError("rate_limit_exceeded", "Rate limit exceeded for this operation");
}

// ---------- Reading a request body (the API's parameters) ----------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** A method's parameters, with typed getters that answer validation_error like Outline. */
export class Params {
  readonly raw: Record<string, unknown>;
  constructor(raw: Record<string, unknown>) {
    this.raw = raw;
  }

  has(name: string) {
    return this.raw[name] !== undefined;
  }

  string(name: string, opts: { required?: boolean; max?: number } = {}): string | undefined {
    const v = this.raw[name];
    if (v === undefined || v === null || v === "") {
      if (opts.required) throw invalid(`${name} is required`);
      return v === "" ? "" : undefined;
    }
    if (typeof v !== "string") throw invalid(`${name} must be a string`);
    if (opts.max && v.length > opts.max) throw invalid(`${name} must be at most ${opts.max} characters`);
    return v;
  }

  /** A string that may be explicitly null (to clear a field). */
  nullableString(name: string, max?: number): string | null | undefined {
    if (this.raw[name] === null) return null;
    return this.string(name, { max });
  }

  uuid(name: string, opts: { required?: boolean } = {}): string | undefined {
    const v = this.raw[name];
    if (v === undefined || v === null || v === "") {
      if (opts.required) throw invalid(`${name} is required`);
      return undefined;
    }
    if (!isUuid(v)) throw invalid(`${name} must be a valid UUID`);
    return v.toLowerCase();
  }

  nullableUuid(name: string): string | null | undefined {
    if (this.raw[name] === null) return null;
    return this.uuid(name);
  }

  boolean(name: string): boolean | undefined {
    const v = this.raw[name];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "boolean") throw invalid(`${name} must be a boolean`);
    return v;
  }

  number(name: string, opts: { min?: number; max?: number } = {}): number | undefined {
    const v = this.raw[name];
    if (v === undefined || v === null) return undefined;
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n !== "number" || !Number.isFinite(n)) throw invalid(`${name} must be a number`);
    if (opts.min !== undefined && n < opts.min) throw invalid(`${name} must be at least ${opts.min}`);
    if (opts.max !== undefined && n > opts.max) throw invalid(`${name} must be at most ${opts.max}`);
    return n;
  }

  oneOf<T extends string>(name: string, values: readonly T[]): T | undefined {
    const v = this.raw[name];
    if (v === undefined || v === null) return undefined;
    if (!values.includes(v as T)) throw invalid(`${name} must be one of ${values.join(", ")}`);
    return v as T;
  }

  object(name: string): Record<string, unknown> | undefined {
    const v = this.raw[name];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "object" || Array.isArray(v)) throw invalid(`${name} must be an object`);
    return v as Record<string, unknown>;
  }

  array(name: string): unknown[] | undefined {
    const v = this.raw[name];
    if (v === undefined || v === null) return undefined;
    if (!Array.isArray(v)) throw invalid(`${name} must be an array`);
    return v;
  }

  /** Outline's pagination: limit (1–100, default 25) and offset. */
  pagination() {
    const limit = this.number("limit", { min: 1, max: 100 }) ?? 25;
    const offset = this.number("offset", { min: 0 }) ?? 0;
    return { limit: Math.floor(limit), offset: Math.floor(offset) };
  }

  /** Outline's sort direction: ASC or DESC (either case). */
  direction(fallback: "ASC" | "DESC" = "DESC"): "ASC" | "DESC" {
    const v = this.raw.direction;
    if (v === undefined || v === null) return fallback;
    const d = String(v).toUpperCase();
    if (d !== "ASC" && d !== "DESC") throw invalid("direction must be one of ASC, DESC");
    return d;
  }
}
