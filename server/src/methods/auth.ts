// auth.*, installation.info, users.info: who's signed in, how to sign in, what this server runs.

import { APP_VERSION, DEV_LOGIN_USER, oidc } from "../config.ts";
import { sql } from "../db.ts";
import { collaborationToken, signOutEverywhere } from "../auth.ts";
import { notFound } from "../http.ts";
import { teamPolicy, userPolicy } from "../policies.ts";
import { presentTeam, presentUser } from "../presenters.ts";
import { method, publicMethod } from "../rpc.ts";
import { currentTeam, getUser } from "../users.ts";

/** The sign-in options, for the sign-in page and the desktop app (Outline's shape: providers). */
publicMethod("auth.config", async () => {
  const team = await currentTeam();
  const providers = [
    ...(oidc ? [{ id: "oidc", name: oidc.name, authUrl: "/auth/oidc" }] : []),
    ...(DEV_LOGIN_USER ? [{ id: "dev", name: `Development (${DEV_LOGIN_USER})`, authUrl: "/auth/dev" }] : []),
  ];
  return { data: { name: team.name, logo: team.avatarUrl ?? undefined, hostname: undefined, providers } };
});

method("auth.info", async ({ user }) => {
  const team = await currentTeam();
  const groups = await sql<{ id: string; name: string }[]>`
    SELECT g.id, g.name FROM groups g JOIN group_users gu ON gu.group_id = g.id WHERE gu.user_id = ${user.id} AND g.deleted_at IS NULL`;
  return {
    data: {
      user: presentUser(user, { includeDetails: true }),
      team: presentTeam(team),
      groups: groups.map((g) => ({ id: g.id, name: g.name })),
      groupUsers: [],
      collaborationToken: collaborationToken(user.id),
      availableTeams: [{ id: team.id, name: team.name, avatarUrl: team.avatarUrl, url: presentTeam(team).url, isSignedIn: true }],
    },
    policies: [teamPolicy(user, team), userPolicy(user, user)],
  };
});

/** Signs the user out, everywhere (as Outline does). */
method("auth.delete", async ({ c, user }) => {
  await signOutEverywhere(c, user.id);
  return { success: true };
});

method("installation.info", () => ({ data: { version: APP_VERSION, latestVersion: APP_VERSION, versionsBehind: 0 } }));

/** A person by id (anyone in the workspace), or the caller. */
method("users.info", async ({ params, user }) => {
  const id = params.uuid("id") ?? user.id;
  const target = id === user.id ? user : await getUser(id);
  if (!target || target.teamId !== user.teamId) throw notFound();
  const details = target.id === user.id || user.role === "admin";
  return { data: presentUser(target, { includeDetails: details }), policies: [userPolicy(user, target)] };
});
