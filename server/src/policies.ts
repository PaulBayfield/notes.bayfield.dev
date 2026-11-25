// What a user may do, in Outline's shape: { id, abilities: { read: true, update: false, … } }. An
// ability is true/false, or (when it comes from memberships) the list of those memberships' ids;
// clients only look at whether it's truthy.
//
// Grows with each part of the API: the team and users here, collections and documents with them.

import type { TeamRow, UserRow } from "./users.ts";
import { WORKSPACE_CREATION, WORKSPACE_DOMAIN } from "./config.ts";
import { atLeast, type Access, type DocLike, type Perm } from "./access.ts";

export type Abilities = Record<string, boolean | string[]>;
export interface Policy {
  id: string;
  abilities: Abilities;
}

const isAdmin = (u: UserRow) => u.role === "admin";
const isMember = (u: UserRow) => u.role === "admin" || u.role === "member";
const isViewer = (u: UserRow) => u.role === "viewer";
const isGuest = (u: UserRow) => u.role === "guest";

export function teamPolicy(actor: UserRow, team: TeamRow): Policy {
  const admin = isAdmin(actor);
  const member = isMember(actor);
  return {
    id: team.id,
    abilities: {
      read: true,
      update: admin,
      delete: false,
      createTeam: admin && WORKSPACE_CREATION === "admins" && !!WORKSPACE_DOMAIN,
      createCollection: admin || (member && team.memberCollectionCreate),
      createDocument: !isGuest(actor),
      // Anyone signed in uploads (an avatar at least); where it may go is checked per document.
      createAttachment: true,
      createGroup: admin || (member && team.memberTeamCreate),
      createIntegration: admin,
      createTemplate: member,
      readTemplate: !isGuest(actor),
      createExport: admin,
      createImport: admin,
      createApiKey: member,
      createWebhookSubscription: admin,
      createUser: admin,
      inviteUser: admin || (member && !team.inviteRequired),
      listUsers: !isGuest(actor),
      listGroups: !isGuest(actor),
      listShares: !isGuest(actor),
      listApiKeys: admin,
      createOAuthClient: admin,
      listOAuthClients: admin,
      listWebhookSubscriptions: admin,
      update_settings: admin,
      manageNotifications: true,
      createEmoji: member,
      readEmoji: true,
    },
  };
}

/** What `actor` may do to the account `user`. */
export function userPolicy(actor: UserRow, user: UserRow): Policy {
  const self = actor.id === user.id;
  const admin = isAdmin(actor) && actor.teamId === user.teamId;
  const pendingInvite = !user.lastSignedInAt && !!user.invitedById;
  return {
    id: user.id,
    abilities: {
      read: actor.teamId === user.teamId,
      readDetails: self || admin,
      update: self || admin,
      delete: (self || admin) && !user.deletedAt,
      activate: admin && !!user.suspendedAt,
      suspend: admin && !self && !user.suspendedAt,
      promote: admin && user.role !== "admin" && !user.suspendedAt,
      demote: admin && !self && user.role !== "viewer" && !user.suspendedAt,
      resendInvite: admin && pendingInvite,
      updateRole: admin && !self,
    },
  };
}

// ---------- Collections and documents (abilities as Outline names them) ----------


export interface CollectionLike {
  id: string;
  archivedAt: Date | null;
  deletedAt: Date | null;
  sharing: boolean;
}

export function collectionPolicy(a: Access, c: CollectionLike, team: TeamRow): Policy {
  const p = a.collection(c.id);
  const read = !!p;
  const write = atLeast(p, "read_write") && !c.archivedAt;
  const manage = (a.isAdmin || p === "admin") && a.user.role !== "viewer";
  return {
    id: c.id,
    abilities: {
      read,
      update: manage,
      delete: manage,
      move: a.isAdmin,
      duplicate: manage,
      download: read,
      star: read,
      unstar: read,
      readDocument: read,
      subscribe: read,
      unsubscribe: read,
      share: read && team.sharing && c.sharing,
      shareDocument: read && team.sharing && c.sharing,
      updateDocument: write,
      createDocument: write,
      deleteDocument: write,
      createTemplate: manage,
      manageTemplate: manage,
      archive: manage && !c.archivedAt,
      pin: write,
      manageUsers: manage,
      export: manage,
      restore: manage && !!c.archivedAt,
      updateDeprecatedReason: a.isAdmin,
    },
  };
}

export function documentPolicy(a: Access, d: DocLike, team: TeamRow, opts: { hasChildren?: boolean } = {}): Policy {
  const p: Perm | null = a.document(d);
  const read = !!p;
  const live = !d.deletedAt && !d.archivedAt;
  const write = atLeast(p, "read_write") && a.user.role !== "viewer";
  const update = write && !d.deletedAt;
  const own = d.createdById === a.user.id;
  const published = !!d.publishedAt;
  return {
    id: d.id,
    abilities: {
      read,
      update: update && live,
      delete: (update || own) && !d.deletedAt,
      move: update && live && published,
      duplicate: read && atLeast(a.collection(d.collectionId), "read_write"),
      download: read,
      star: read && !d.deletedAt,
      unstar: read,
      subscribe: read && published && !d.deletedAt,
      unsubscribe: read,
      share: read && team.sharing && a.user.role !== "guest" && !d.deletedAt,
      archive: update && live && published,
      pin: update && live && published,
      unpin: update && published,
      pinToHome: a.isAdmin && published && live,
      manageUsers: write && a.user.role !== "guest" && !d.deletedAt,
      restore: (!!d.deletedAt || !!d.archivedAt) && (write || own),
      unarchive: !!d.archivedAt && write,
      permanentDelete: !!d.deletedAt && (a.isAdmin || own),
      updateDeprecatedReason: a.isAdmin,
      listRevisions: read,
      listViews: read,
      comment: read && !d.deletedAt,
      publish: !published && !d.isTemplate && (own || update) && !d.deletedAt,
      unpublish: published && update && live && !opts.hasChildren,
      createChildDocument: update && live && published,
      updateInsights: update,
    },
  };
}

export function starPolicy(id: string): Policy {
  return { id, abilities: { read: true, update: true, delete: true } };
}
