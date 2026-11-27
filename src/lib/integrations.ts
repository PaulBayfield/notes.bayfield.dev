// API keys, OAuth apps, MCP, the events log, search history and workspaces: the parts of Outline's API
// behind the settings' "API & apps" pages and the workspace switcher.

import { call, getServer, type Team, type User } from "./api";

// ---------- API keys ----------

export interface ApiKey {
  id: string;
  userId: string;
  name: string;
  /** null: everything the owner can do. */
  scope: string[] | null;
  /** Only right after creation. */
  value?: string;
  last4: string;
  expiresAt: string | null;
  lastActiveAt: string | null;
  createdAt: string;
}

export const listApiKeys = (opts: { all?: boolean; userId?: string } = {}) => call<ApiKey[]>("apiKeys.list", { limit: 100, ...opts }).then((r) => r.data);
export const createApiKey = (input: { name: string; scope?: string[]; expiresAt?: string | null }) => call<ApiKey>("apiKeys.create", input).then((r) => r.data);
export const deleteApiKey = (id: string) => call("apiKeys.delete", { id });

// ---------- OAuth apps ----------

export interface OAuthClient {
  id: string;
  name: string;
  description: string | null;
  developerName: string | null;
  developerUrl: string | null;
  avatarUrl: string | null;
  clientId: string;
  /** Only right after creation or rotation. */
  clientSecret?: string;
  clientType: "confidential" | "public";
  redirectUris: string[];
  published: boolean;
  createdAt: string;
}

export type OAuthClientInput = Partial<Pick<OAuthClient, "name" | "description" | "developerName" | "developerUrl" | "avatarUrl" | "redirectUris" | "published">> & {
  clientType?: "confidential" | "public";
};

export const listOAuthClients = () => call<OAuthClient[]>("oauthClients.list", { limit: 100 }).then((r) => r.data);
export const createOAuthClient = (input: OAuthClientInput) => call<OAuthClient>("oauthClients.create", input).then((r) => r.data);
export const updateOAuthClient = (id: string, input: OAuthClientInput) => call<OAuthClient>("oauthClients.update", { id, ...input }).then((r) => r.data);
export const rotateOAuthSecret = (id: string) => call<OAuthClient>("oauthClients.rotate_secret", { id }).then((r) => r.data);
export const deleteOAuthClient = (id: string) => call("oauthClients.delete", { id });

export interface OAuthConnection {
  id: string;
  scope: string[];
  lastActiveAt: string | null;
  createdAt: string;
  oauthClientId: string;
  oauthClient: { id: string; name: string; avatarUrl: string | null; developerName: string | null; developerUrl: string | null };
}

export const listConnections = () => call<OAuthConnection[]>("oauthAuthentications.list", { limit: 100 }).then((r) => r.data);
export const disconnectApp = (oauthClientId: string) => call("oauthAuthentications.delete", { oauthClientId });

// ---------- MCP ----------

/** The workspace's MCP endpoint (on its own address). */
export const mcpUrl = (team: Team) => `${(team.url || getServer()).replace(/\/+$/, "")}/mcp`;

// ---------- Events ----------

export interface EventChange {
  from: unknown;
  to: unknown;
  /** The name behind an id (a collection, a document), when the change holds one. */
  fromLabel?: string;
  toLabel?: string;
}

export interface WorkspaceEvent {
  id: string;
  name: string;
  modelId: string | null;
  actorId: string | null;
  actor: User | null;
  userId: string | null;
  /** The person the action was about (added to a group, whose role changed…). */
  user: User | null;
  collectionId: string | null;
  collection: { id: string; name: string; url: string; deleted: boolean } | null;
  documentId: string | null;
  document: { id: string; title: string; url: string; deleted: boolean } | null;
  group: { id: string; name: string } | null;
  data: Record<string, unknown> | null;
  /** What changed, field by field. */
  changes: Record<string, EventChange> | null;
  /** The audit log only: where the action came from. */
  actorIpAddress?: string | null;
  client?: string | null;
  userAgent?: string | null;
  /** How they were signed in: cookie (web), bearer (desktop), apiKey, oauth. */
  via?: string | null;
  createdAt: string;
}

export interface EventFilters {
  auditLog?: boolean;
  documentId?: string;
  collectionId?: string;
  actorId?: string;
  events?: string[];
  /** ISO dates: from (inclusive) and until (exclusive). */
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export const listEvents = (filters: EventFilters) => call<WorkspaceEvent[]>("events.list", { limit: 50, ...filters }).then((r) => r.data);

// ---------- Search history ----------

export interface RecentSearch {
  id: string;
  query: string;
  results: number;
  createdAt: string;
}

export const listSearches = (limit = 8) => call<RecentSearch[]>("searches.list", { limit, source: "app" }).then((r) => r.data);
export const deleteSearch = (query: string) => call("searches.delete", { query });

// ---------- Workspaces ----------

export interface AvailableTeam {
  id: string;
  name: string;
  avatarUrl: string | null;
  url: string;
  isSignedIn: boolean;
}

/** The person's other workspaces on this server (auth.info's availableTeams; Outline's cloud gives them too). */
export const availableTeams = () => call<{ availableTeams?: AvailableTeam[] }>("auth.info").then((r) => r.data.availableTeams ?? []);

export const createTeam = (input: { name: string; subdomain?: string }) =>
  call<{ team: Team; transferUrl: string }>("teams.create", input).then((r) => r.data);
