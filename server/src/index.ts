// Notes server: Outline's API (POST /api/<method>), sign-in (/auth/…), and the web app at the root.

import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { DEV_LOGIN_USER, DIST_DIR, PORT, PUBLIC_URL, UPLOAD_MAX_SIZE, oidc } from "./config.ts";
import { migrate, sql } from "./db.ts";
import { authRoutes, cleanUpAuth, csrfCookie, desktopRedirectPage, type AppEnv } from "./auth.ts";
import { ApiError, clientIp } from "./http.ts";
import { dispatch } from "./rpc.ts";
import { defaultTeam, forgetTeam, teamForHost } from "./users.ts";
import { requestContext } from "./context.ts";
import { bus, listenToOtherInstances, type ChangeEvent } from "./events.ts";
import { schedule, startJobs } from "./jobs.ts";
import "./methods/auth.ts";
import "./methods/collections.ts";
import "./methods/documents.ts";
import "./methods/library.ts";
import "./methods/comments.ts";
import "./methods/people.ts";
import "./methods/apikeys.ts";
import "./methods/events.ts";
import "./methods/searches.ts";
import { watchMentions } from "./mentions.ts";
import { scheduleHousekeeping } from "./housekeeping.ts";
import { oauthRoutes } from "./oauth.ts";
import { mcpRoutes } from "./mcp.ts";
import { cors } from "hono/cors";
import { attachmentRedirect, filesCreate, filesGet } from "./methods/files.ts";
import { shareRoutes } from "./methods/shares.ts";
import { flushCollaboration, handleCollaborationUpgrade } from "./collaboration.ts";
import { handleRealtimeUpgrade } from "./realtime.ts";

await migrate();
await defaultTeam();
await listenToOtherInstances();
// A workspace changed (here or on another instance): forget the cached copy.
bus.on("change", (e: ChangeEvent) => {
  if (e.name === "teams.update" || e.name === "teams.create") forgetTeam(e.teamId);
});

const app = new Hono<AppEnv>();

app.onError((err, c) => {
  if (err instanceof ApiError) return c.json(err.toJSON(), err.status);
  console.error(err);
  return c.json({ ok: false, error: "internal_server_error", status: 500, message: "An internal error occurred" }, 500);
});
app.notFound((c) => c.json(new ApiError("not_found", "Resource not found").toJSON(), 404));

// Documents embed images, videos and frames from anywhere, so no content security policy here (as
// Outline's web app); the other protective headers apply.
app.use("*", secureHeaders({ contentSecurityPolicy: undefined, crossOriginEmbedderPolicy: false, crossOriginResourcePolicy: false, referrerPolicy: "strict-origin-when-cross-origin" }));
app.use("*", csrfCookie);

app.get("/api/health", async (c) => {
  await sql`SELECT 1`;
  return c.json({ ok: true });
});
app.get("/_health", (c) => c.text("OK"));

// Each request's address and client, for the events log (see context.ts).
app.use("*", (c, next) => requestContext.run({ ip: clientIp(c), userAgent: c.req.header("User-Agent")?.slice(0, 300) ?? null }, () => next()));

// The workspace this address serves (the main address, a subdomain, a custom domain).
app.use("*", async (c, next) => {
  const team = await teamForHost(c.req.header("host"));
  if (!team) {
    if (c.req.path.startsWith("/api/")) return c.json(new ApiError("not_found", "No workspace at this address").toJSON(), 404);
    return c.text("No workspace at this address.", 404);
  }
  c.set("team", team);
  await next();
});

// Files, before the API's body limit: uploads go up to FILE_STORAGE_UPLOAD_MAX_SIZE.
app.post("/api/files.create", bodyLimit({ maxSize: UPLOAD_MAX_SIZE + 1024 * 1024, onError: (c) => c.json(new ApiError("payload_too_large", "The file is too large").toJSON(), 413) }), filesCreate);
app.get("/api/files.get", filesGet);
app.get("/api/attachments.redirect", (c) => attachmentRedirect(c, c.req.query("id")));

app.use("/api/*", bodyLimit({ maxSize: 5 * 1024 * 1024, onError: (c) => c.json(new ApiError("payload_too_large", "Request too large").toJSON(), 413) }));
app.post("/api/:method", dispatch);
app.get("/api/:method", dispatch);

// MCP clients and OAuth apps: bearer tokens only (no cookies), so any origin may call these.
const openCors = cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type", "Mcp-Protocol-Version", "Mcp-Session-Id"], exposeHeaders: ["WWW-Authenticate", "Mcp-Session-Id"], maxAge: 86400 });
for (const path of ["/mcp", "/mcp/*", "/oauth/token", "/oauth/register", "/oauth/revoke", "/.well-known/*"]) app.use(path, openCors);
app.use("/mcp", bodyLimit({ maxSize: 5 * 1024 * 1024, onError: (c) => c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } }, 413) }));
app.use("/oauth/*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "invalid_request", error_description: "Request too large" }, 413) }));
app.route("/mcp", mcpRoutes);
app.route("/", oauthRoutes);
app.route("/auth", authRoutes);
app.route("/s", shareRoutes);
app.get("/desktop-redirect", (c) => c.html(desktopRedirectPage(c.req.query("token") ?? "", c.req.header("host") ?? new URL(PUBLIC_URL).host)));
app.get("/robots.txt", (c) => c.text("User-agent: *\nDisallow: /\n"));

// The web app used to live under /app/ on Outline's domain: old links still work.
app.get("/app", (c) => c.redirect("/", 301));
app.get("/app/*", (c) => c.redirect(c.req.path.slice(4) + (new URL(c.req.url).search || ""), 301));

const indexPath = resolve(DIST_DIR, "index.html");
const indexHtml = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : null;
if (indexHtml) {
  app.use("/assets/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "public, max-age=31536000, immutable");
  });
  const page = (c: Context) => {
    c.header("Cache-Control", "no-cache");
    return c.html(indexHtml);
  };
  app.get("/", page);
  app.get("/index.html", page);
  app.use("/*", serveStatic({ root: relative(process.cwd(), DIST_DIR) }));
  app.get("*", page);
} else {
  console.warn(`No web build at ${DIST_DIR}; only the API is served. Run \`npm run build\` in the project root.`);
}

schedule("auth-cleanup", 60 * 60_000, async () => cleanUpAuth());
scheduleHousekeeping();
watchMentions();
startJobs();

const server = serve({ fetch: app.fetch, port: PORT }, ({ port }) => {
  console.log(`Notes server on http://localhost:${port} (public URL ${PUBLIC_URL})`);
  console.log(`  sign-in: ${[oidc && `OIDC (${oidc.name})`, DEV_LOGIN_USER && `development sign-in as ${DEV_LOGIN_USER}`].filter(Boolean).join(", ")}`);
});

// WebSockets: live collaboration and live updates, on the same port as the API.
server.on("upgrade", (req, socket, head) => {
  if (handleCollaborationUpgrade(req, socket, head) || handleRealtimeUpgrade(req, socket, head)) return;
  socket.destroy();
});

// Saves the documents being edited before stopping (a deploy, a restart).
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void flushCollaboration().finally(() => process.exit(0));
  });
