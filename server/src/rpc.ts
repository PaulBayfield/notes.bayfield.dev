// The API's dispatcher: POST /api/<method> with a JSON body (or a query string, as Outline accepts),
// answered { data, policies?, pagination?, status: 200, ok: true }.
//
// Methods register themselves with `method()`: their name, whether they need a signed-in caller, and
// a handler returning the envelope's fields.

import type { Context } from "hono";
import { checkCsrf, identify, type AppEnv, type Caller } from "./auth.ts";
import { ApiError, Params, notFound, unauthenticated } from "./http.ts";
import type { Policy } from "./policies.ts";
import type { UserRow } from "./users.ts";

export interface Result {
  data?: unknown;
  policies?: Policy[];
  pagination?: { limit: number; offset: number; nextPath?: string; total?: number };
  /** Anything else the method answers at the top level (rare: auth.info's extras live in data). */
  [extra: string]: unknown;
}

export interface Call {
  c: Context<AppEnv>;
  params: Params;
  caller: Caller | null;
  /** The API version the client asked for (x-api-version), 0 when it didn't say. */
  apiVersion: number;
}

export interface SignedInCall extends Call {
  caller: Caller;
  user: UserRow;
}

/** A method answers the envelope's fields, or a Response of its own (a file download). */
type Answer = Result | Response;
type Handler = (call: Call) => Promise<Answer> | Answer;
type SignedInHandler = (call: SignedInCall) => Promise<Answer> | Answer;

const methods = new Map<string, { auth: boolean; handler: Handler }>();

/** A method for signed-in callers (most of them). */
export function method(name: string, handler: SignedInHandler) {
  methods.set(name, {
    auth: true,
    handler: (call) => handler({ ...call, caller: call.caller!, user: call.caller!.user }),
  });
}

/** A method anyone may call (auth.config, shares.info for a public share…). */
export function publicMethod(name: string, handler: Handler) {
  methods.set(name, { auth: false, handler });
}

export const hasMethod = (name: string) => methods.has(name);

export async function dispatch(c: Context<AppEnv>) {
  const name = c.req.param("method") ?? "";
  const m = methods.get(name);
  if (!m) throw notFound();
  const caller = await identify(c);
  c.set("caller", caller);
  if (m.auth && !caller) throw unauthenticated();
  if (c.req.method !== "GET") checkCsrf(c, caller);

  let raw: Record<string, unknown> = {};
  const type = c.req.header("content-type") ?? "";
  if (c.req.method === "GET") raw = c.req.query();
  else if (type.includes("application/json")) {
    const text = await c.req.text();
    if (text.trim()) {
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        raw = parsed as Record<string, unknown>;
      } catch {
        throw new ApiError("invalid_request", "Request body must be a JSON object");
      }
    }
  } else if (type.includes("form")) raw = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, typeof v === "string" ? v : v]));

  const result = await m.handler({ c, params: new Params(raw), caller, apiVersion: Number(c.req.header("x-api-version") ?? 0) || 0 });
  if (result instanceof Response) return result;
  return c.json({ ...result, status: 200, ok: true });
}
