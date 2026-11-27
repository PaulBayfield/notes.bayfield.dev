// auth.*, installation.info, users.info, teams.create: who's signed in, how to sign in, the person's
// other workspaces, and making a new one.

import { APP_VERSION, DEV_LOGIN_USER, UPDATE_CHECK, WORKSPACE_CREATION, WORKSPACE_DOMAIN, oidc } from "../config.ts";
import { sql } from "../db.ts";
import { collaborationToken, signOutEverywhere, transferToken } from "../auth.ts";
import { forbidden, invalid, notFound } from "../http.ts";
import { teamPolicy, userPolicy } from "../policies.ts";
import { presentTeam, presentUser } from "../presenters.ts";
import { method, publicMethod } from "../rpc.ts";
import { publish } from "../events.ts";
import { createUser, getUser, otherWorkspaces, teamById, teamUrl, type TeamRow } from "../users.ts";

/** The sign-in options for the workspace at this address (Outline's shape: providers). */
publicMethod("auth.config", async ({ c }) => {
  const team = c.get("team");
  const providers = [
    ...(oidc ? [{ id: "oidc", name: oidc.name, authUrl: "/auth/oidc" }] : []),
    ...(DEV_LOGIN_USER ? [{ id: "dev", name: `Development (${DEV_LOGIN_USER})`, authUrl: "/auth/dev" }] : []),
  ];
  return { data: { name: team.name, logo: team.avatarUrl ?? undefined, hostname: new URL(teamUrl(team)).host, providers, workspaceDomain: WORKSPACE_DOMAIN ?? undefined } };
});

method("auth.info", async ({ user }) => {
  const team = await teamById(user.teamId);
  const [groups, others] = await Promise.all([
    sql<{ id: string; name: string }[]>`SELECT g.id, g.name FROM groups g JOIN group_users gu ON gu.group_id = g.id WHERE gu.user_id = ${user.id} AND g.deleted_at IS NULL`,
    otherWorkspaces(user),
  ]);
  const available = (t: TeamRow, signedIn: boolean) => ({ id: t.id, name: t.name, avatarUrl: t.avatarUrl, url: teamUrl(t), isSignedIn: signedIn });
  return {
    data: {
      user: presentUser(user, { includeDetails: true }),
      team: presentTeam(team),
      groups: groups.map((g) => ({ id: g.id, name: g.name })),
      groupUsers: [],
      collaborationToken: collaborationToken(user.id),
      availableTeams: [available(team, true), ...others.map((t) => available(t, false))],
    },
    policies: [teamPolicy(user, team), userPolicy(user, user)],
  };
});

/** Signs the user out, everywhere (as Outline does). */
method("auth.delete", async ({ c, user }) => {
  await signOutEverywhere(c, user.id);
  return { success: true };
});

const REPOSITORY = "PaulBayfield/notes.bayfield.dev";

/** The newest release on GitHub, looked up at most every 6 hours (UPDATE_CHECK=false: never). */
let latest: { version: string | null; at: number } = { version: null, at: 0 };
async function latestRelease(): Promise<string | null> {
  if (!UPDATE_CHECK) return null;
  if (Date.now() - latest.at < 6 * 60 * 60_000) return latest.version;
  latest = { version: latest.version, at: Date.now() };
  try {
    const res = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(5000) });
    if (res.ok) latest.version = String(((await res.json()) as { tag_name?: string }).tag_name ?? "").replace(/^v/, "") || null;
  } catch {
    // Offline: unknown until the next try.
  }
  return latest.version;
}

const parts = (v: string) => v.split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
const newer = (a: string, b: string) => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

/** The server's version (Outline's shape), and what it is: Notes, with its project page. */
method("installation.info", async () => {
  const latestVersion = await latestRelease();
  return {
    data: {
      version: APP_VERSION,
      latestVersion: latestVersion ?? undefined,
      // Major/minor/patch steps don't count releases; "behind" is enough to say so.
      versionsBehind: latestVersion ? (newer(latestVersion, APP_VERSION) ? 1 : 0) : -1,
      server: "notes",
      repository: `https://github.com/${REPOSITORY}`,
      releasesUrl: `https://github.com/${REPOSITORY}/releases`,
    },
  };
});

/** A person by id (anyone in the workspace), or the caller. */
method("users.info", async ({ params, user }) => {
  const id = params.uuid("id") ?? user.id;
  const target = id === user.id ? user : await getUser(id);
  if (!target || target.teamId !== user.teamId) throw notFound();
  const details = target.id === user.id || user.role === "admin";
  return { data: presentUser(target, { includeDetails: details }), policies: [userPolicy(user, target)] };
});

/**
 * A new workspace (Outline's teams.create): at "<subdomain>.<WORKSPACE_DOMAIN>". Its creator becomes its
 * first admin, with the same sign-in identity, and gets a one-time link that signs them in there.
 */
method("teams.create", async ({ params, user }) => {
  if (WORKSPACE_CREATION === "none" || user.role !== "admin") throw forbidden("Only admins can create workspaces");
  if (!WORKSPACE_DOMAIN) throw invalid("Set WORKSPACE_DOMAIN on the server to host more workspaces");
  const name = params.string("name", { required: true, max: 255 })!.trim();
  if (!name) throw invalid("name is required");
  const subdomain = (params.string("subdomain", { max: 63 }) ?? name)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) throw invalid("The subdomain can only use letters, digits and dashes");
  const [taken] = await sql`SELECT 1 FROM teams WHERE lower(subdomain) = ${subdomain}`;
  if (taken) throw invalid("This subdomain is taken");

  const [team] = await sql<TeamRow[]>`INSERT INTO teams (name, subdomain) VALUES (${name}, ${subdomain}) RETURNING *`;
  const admin = await createUser({ teamId: team.id, name: user.name, email: user.email, avatarUrl: user.avatarUrl, role: "admin" });
  // The same identity signs in to both.
  await sql`
    INSERT INTO user_authentications (user_id, team_id, provider, provider_id, scopes)
    SELECT ${admin.id}, ${team.id}, provider, provider_id, scopes FROM user_authentications WHERE user_id = ${user.id}
    ON CONFLICT DO NOTHING`;
  publish({ name: "teams.create", data: { id: team.id, name: team.name }, teamId: user.teamId, userIds: [user.id], actorId: user.id });
  const url = teamUrl(team);
  return { data: { team: presentTeam(team), transferUrl: `${url}/auth/redirect?token=${encodeURIComponent(await transferToken(admin))}` } };
});
