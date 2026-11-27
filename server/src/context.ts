// What the request being handled is (its address, its client, how it signed in), for the events log,
// without passing it through every call: it follows the request across awaits (AsyncLocalStorage).

import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestInfo {
  ip: string | null;
  userAgent: string | null;
  /** How the caller signed in, once known: cookie (web), bearer (desktop), apiKey, oauth (MCP and apps). */
  via?: string;
}

export const requestContext = new AsyncLocalStorage<RequestInfo>();

export const currentRequest = () => requestContext.getStore();
