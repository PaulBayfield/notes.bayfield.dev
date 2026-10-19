// `?demo`: sample workspace and documents, no server. Handy for trying the UI and editor.

import type { Collection, Doc, NavNode, User } from "./api";

export const isDemo = new URLSearchParams(location.search).has("demo");

const now = Date.now();
const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

const me: User = { id: "u1", name: "Paul", avatarUrl: null, color: "#907aa9", email: "demo@example.com" };
const friend: User = { id: "u2", name: "Lisa", avatarUrl: null, color: "#d7827e" };

const collections: Collection[] = [
  { id: "c1", urlId: "perso00001", name: "Personnel", color: "#c4a7e7", icon: "beaker", index: "a" },
  { id: "c2", urlId: "projet0001", name: "Projets", color: "#9ccfd8", icon: "🚀", index: "b" },
];

const node = (id: string, title: string, children: NavNode[] = [], icon?: string): NavNode => ({
  id,
  title,
  url: `/doc/${title.toLowerCase().replace(/\W+/g, "-")}-${id.padEnd(10, "0")}`,
  icon: icon ?? null,
  color: icon === "rocket" ? "#eb6f92" : null,
  children,
});

const trees: Record<string, NavNode[]> = {
  c1: [node("d1", "Welcome", [node("d2", "Reading list", [], "rocket"), node("d3", "Recipes", [], "🍝")]), node("d4", "Journal")],
  c2: [node("d5", "Notes app", [node("d6", "Roadmap")], "📝"), node("d7", "Calendar")],
};

const docs: Doc[] = Object.entries(trees).flatMap(([collectionId, nodes]) => {
  const out: Doc[] = [];
  const walk = (list: NavNode[], parent: string | null, depth: number) =>
    list.forEach((n, i) => {
      out.push({
        id: n.id,
        urlId: n.id.padEnd(10, "0"),
        url: n.url,
        title: n.title,
        icon: n.icon ?? null,
        color: null,
        collectionId,
        parentDocumentId: parent,
        createdAt: iso(60 * 24 * (10 + i)),
        updatedAt: iso(15 * (depth + i + 1)),
        publishedAt: iso(60 * 24 * 9),
        archivedAt: null,
        createdBy: me,
        updatedBy: i % 2 ? friend : me,
      });
      walk(n.children, n.id, depth + 1);
    });
  walk(nodes, null, 0);
  return out;
});

interface DemoComment {
  id: string;
  documentId: string;
  parentCommentId: string | null;
  data: object;
  createdBy: User;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolvedBy: User | null;
}
const comments: DemoComment[] = [];
const overviews: Record<string, object> = {};
const pins: { id: string; documentId: string; collectionId: string | null; index: string }[] = [{ id: "p0", documentId: "d1", collectionId: null, index: "a" }];
const subscribed = new Set<string>();
const guest: User = { id: "u3", name: "Marc", avatarUrl: null, color: "#56949f" };
const members: { userId: string; permission: string }[] = [{ userId: "u1", permission: "admin" }];
const groups = [
  { id: "g1", name: "Friends", memberCount: 3 },
  { id: "g2", name: "Family", memberCount: 5 },
];
const groupMembers: { groupId: string; permission: string }[] = [];
let demoShare: Record<string, unknown> | null = null;
const textData = (text: string) => ({ type: "doc", content: text.split(/\n/).map((line) => ({ type: "paragraph", content: line ? [{ type: "text", text: line }] : [] })) });

const find = (id: string) => docs.find((d) => d.id === id || d.urlId === id);

const exports: Record<string, unknown>[] = [];

export async function demoCall(method: string, body: Record<string, unknown>): Promise<{ data: unknown; policies?: unknown[] }> {
  await new Promise((r) => setTimeout(r, 60));
  switch (method) {
    case "auth.info":
      return {
        data: { user: me, team: { id: "t1", name: "Demo", avatarUrl: null, url: "" }, collaborationToken: "demo" },
        policies: [{ id: "t1", abilities: { update: true, createExport: true } }],
      };
    case "fileOperations.list":
      return { data: exports };
    case "fileOperations.info":
      return { data: { ...(exports.find((x) => x.id === body.id) ?? exports[0]), state: "complete" } };
    case "fileOperations.delete":
      exports.splice(exports.findIndex((x) => x.id === body.id), 1);
      return { data: null };
    case "collections.export":
    case "collections.export_all": {
      const op = { id: `e${exports.length + 1}`, type: "export", format: body.format, name: body.id ? collections.find((c) => c.id === body.id)?.name : "", state: "creating", error: null, size: 0, collectionId: body.id ?? null, documentId: null, user: me, createdAt: iso(0), updatedAt: iso(0) };
      exports.unshift(op);
      setTimeout(() => Object.assign(op, { state: "complete", size: 482_133 }), 3000);
      return { data: { fileOperation: op } };
    }
    case "collections.list":
      return { data: collections };
    case "collections.documents":
      return { data: trees[body.id as string] ?? [] };
    case "collections.info": {
      const c = collections.find((x) => x.id === body.id || x.urlId === body.id);
      return {
        data: { ...c, description: overviews[String(body.id)] ? undefined : "## About\n\nA **sample** collection with a [link](https://rosepinetheme.com).\n\n- [ ] Write the overview\n- [x] Pick an icon", data: overviews[String(body.id)] ?? null },
        policies: [{ id: body.id, abilities: { update: true } }],
      };
    }
    case "collections.update": {
      const c = collections.find((x) => x.id === body.id);
      if (c) Object.assign(c, Object.fromEntries(Object.entries(body).filter(([k]) => ["name", "icon", "color", "permission"].includes(k))));
      if (body.data) overviews[String(body.id)] = body.data as object;
      return { data: c };
    }
    case "collections.create": {
      const c: Collection = { id: `c${collections.length + 1}`, urlId: `new${collections.length}`.padEnd(10, "0"), name: String(body.name), color: (body.color as string) ?? null, icon: (body.icon as string) ?? null, index: `z${collections.length}` };
      collections.push(c);
      trees[c.id] = [];
      return { data: c };
    }
    case "collections.move": {
      const c = collections.find((x) => x.id === body.id);
      if (c) c.index = String(body.index);
      collections.sort((a, b) => (a.index < b.index ? -1 : 1));
      return { data: c };
    }
    case "documents.drafts":
      return { data: [{ ...docs[3], id: "dr1", title: "Unfinished idea", publishedAt: null }] };
    case "documents.archived":
      return { data: [{ ...docs[2], id: "ar1", title: "Old roadmap", archivedAt: iso(60 * 24 * 3) }] };
    case "documents.deleted":
      return { data: [{ ...docs[1], id: "de1", title: "Scratch notes", deletedAt: iso(60 * 5) }] };
    case "documents.memberships":
      return { data: { memberships: members.map((m) => ({ id: `m${m.userId}`, userId: m.userId, documentId: body.id, permission: m.permission })), users: [me, friend, guest].filter((u) => members.some((m) => m.userId === u.id)) } };
    case "documents.add_user": {
      const existing = members.find((m) => m.userId === body.userId);
      if (existing) existing.permission = String(body.permission);
      else members.push({ userId: String(body.userId), permission: String(body.permission ?? "read_write") });
      return { data: null };
    }
    case "documents.remove_user": {
      const i = members.findIndex((m) => m.userId === body.userId);
      if (i >= 0) members.splice(i, 1);
      return { data: null };
    }
    case "documents.users":
      return { data: [me, friend, guest].filter((u) => u.id !== guest.id || members.some((m) => m.userId === u.id)) };
    case "userMemberships.list":
      return { data: { memberships: [{ id: "um1", userId: me.id, documentId: "d2", permission: "read" }], documents: [find("d2")] } };
    case "groupMemberships.list":
      return { data: { groupMemberships: [], groups: [], documents: [] } };
    case "groups.list":
      return { data: { groups: groups.filter((g) => g.name.toLowerCase().includes(String(body.query ?? "").toLowerCase())), groupMemberships: [] } };
    case "documents.group_memberships":
      return {
        data: {
          groupMemberships: groupMembers.map((m) => ({ id: `gm${m.groupId}`, groupId: m.groupId, documentId: body.id, permission: m.permission })),
          groups: groups.filter((g) => groupMembers.some((m) => m.groupId === g.id)),
        },
      };
    case "documents.add_group": {
      const existing = groupMembers.find((m) => m.groupId === body.groupId);
      if (existing) existing.permission = String(body.permission);
      else groupMembers.push({ groupId: String(body.groupId), permission: String(body.permission ?? "read_write") });
      return { data: null };
    }
    case "documents.remove_group": {
      const i = groupMembers.findIndex((m) => m.groupId === body.groupId);
      if (i >= 0) groupMembers.splice(i, 1);
      return { data: null };
    }
    case "shares.info":
      return demoShare ? { data: { shares: [demoShare] } } : (undefined as unknown as { data: unknown });
    case "shares.create":
      demoShare = { id: "sh1", documentId: body.documentId, published: true, url: "https://notes.example.com/s/demo-share", includeChildDocuments: false, allowIndexing: false };
      return { data: demoShare };
    case "shares.update":
      Object.assign(demoShare ?? {}, body);
      return { data: demoShare };
    case "pins.list":
      return { data: { pins: pins.filter((x) => (x.collectionId ?? null) === (body.collectionId ?? null)), documents: docs } };
    case "pins.create": {
      const pin = { id: `p${pins.length + 1}`, documentId: String(body.documentId), collectionId: (body.collectionId as string) ?? null, index: `a${pins.length}` };
      pins.push(pin);
      return { data: pin };
    }
    case "pins.delete": {
      const i = pins.findIndex((x) => x.id === body.id);
      if (i >= 0) pins.splice(i, 1);
      return { data: null };
    }
    case "subscriptions.info":
      if (!subscribed.has(String(body.documentId))) throw Object.assign(new Error("Not found"), { status: 404 });
      return { data: { id: `s-${body.documentId}` } };
    case "subscriptions.create":
      subscribed.add(String(body.documentId));
      return { data: { id: `s-${body.documentId}` } };
    case "subscriptions.delete":
      subscribed.delete(String(body.id).slice(2));
      return { data: null };
    case "revisions.list":
      return {
        data: [0, 1, 2].map((i) => ({ id: `r${i}`, documentId: body.documentId, title: find(String(body.documentId))?.title, createdAt: iso(15 + i * 90), createdBy: i % 2 ? friend : me, collaborators: [i % 2 ? friend : me] })),
      };
    case "revisions.info":
      return { data: { id: body.id, title: "Earlier version", createdAt: iso(120), createdBy: friend, data: demoContent("an earlier version") } };
    case "views.list":
      return { data: [{ id: "v1", count: 12, lastViewedAt: iso(5), user: me }, { id: "v2", count: 4, lastViewedAt: iso(240), user: friend }] };
    case "users.info":
      return { data: { ...(body.id === "u2" ? friend : me), role: body.id === "u2" ? "member" : "admin", timezone: "Europe/Paris" } };
    case "documents.export":
      return { data: `# ${find(String(body.id))?.title}\n\nExported from the demo.` };
    case "documents.info": {
      const doc = find(String(body.id));
      if (!doc) throw Object.assign(new Error("Not found"), { status: 404 });
      return { data: doc, policies: [{ id: doc.id, abilities: { update: true, manageUsers: true, share: true, delete: true } }] };
    }
    case "documents.list":
    case "documents.viewed":
      return { data: [...docs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, Number(body.limit ?? 10)) };
    case "stars.list":
      return { data: { stars: [{ id: "s1", documentId: "d5", collectionId: null, index: "a" }], documents: [find("d5")] } };
    case "documents.search_titles":
    case "documents.search": {
      const q = String(body.query ?? "").toLowerCase();
      const hits = docs.filter((d) => d.title.toLowerCase().includes(q));
      return { data: method === "documents.search" ? hits.map((d) => ({ document: d, context: `… <b>${d.title}</b> …`, ranking: 1 })) : hits };
    }
    case "users.list":
      if (Array.isArray(body.ids)) return { data: [me, friend, guest].filter((u) => (body.ids as string[]).includes(u.id)) };
      return { data: [me, friend, guest].filter((u) => u.name.toLowerCase().includes(String(body.query ?? "").toLowerCase())) };
    case "documents.update": {
      const doc = find(String(body.id));
      if (doc && typeof body.title === "string") doc.title = body.title;
      if (doc) for (const k of ["fullWidth", "insightsEnabled", "preferences"] as const) if (k in body) (doc as unknown as Record<string, unknown>)[k] = body[k];
      return { data: doc };
    }
    case "comments.list":
      return { data: comments.filter((c) => c.documentId === body.documentId) };
    case "comments.create": {
      const c: DemoComment = {
        id: String(body.id),
        documentId: String(body.documentId),
        parentCommentId: (body.parentCommentId as string) ?? null,
        data: textData(String(body.text ?? "")),
        createdBy: me,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        resolvedAt: null,
        resolvedBy: null,
      };
      comments.push(c);
      return { data: c };
    }
    case "comments.update":
    case "comments.resolve":
    case "comments.unresolve": {
      const c = comments.find((x) => x.id === body.id);
      if (c && method === "comments.update") c.data = textData(String(body.text ?? ""));
      if (c && method === "comments.resolve") (c.resolvedAt = new Date().toISOString()), (c.resolvedBy = me);
      if (c && method === "comments.unresolve") (c.resolvedAt = null), (c.resolvedBy = null);
      return { data: c };
    }
    case "comments.delete": {
      const i = comments.findIndex((x) => x.id === body.id);
      if (i >= 0) comments.splice(i, 1);
      return { data: null };
    }
    default:
      return { data: null };
  }
}

/** Sample content for a demo document, as ProseMirror JSON. */
export function demoContent(title: string) {
  const text = (t: string, marks?: { type: string; attrs?: object }[]) => ({ type: "text", text: t, ...(marks ? { marks } : {}) });
  const p = (...content: object[]) => ({ type: "paragraph", content });
  return {
    type: "doc",
    content: [
      p(text("This is "), text(title, [{ type: "strong" }]), text(", a demo document. Type "), text("/", [{ type: "code_inline" }]), text(" for blocks, select text to format it.")),
      { type: "heading", attrs: { level: 2 }, content: [text("To do")] },
      {
        type: "checkbox_list",
        content: [
          { type: "checkbox_item", attrs: { checked: true }, content: [p(text("Rosé Pine themes"))] },
          { type: "checkbox_item", attrs: { checked: false }, content: [p(text("Live collaboration with "), { type: "mention", attrs: { type: "user", label: "Lisa", modelId: "u2", id: "m1" } })] },
        ],
      },
      { type: "container_notice", attrs: { style: "tip" }, content: [p(text("Notices, toggles, tables, code and math all work."))] },
      { type: "heading", attrs: { level: 2 }, content: [text("Code")] },
      { type: "code_fence", attrs: { language: "typescript" }, content: [text('const greet = (name: string) => `Hello ${name}`;')] },
      {
        type: "table",
        content: [
          { type: "tr", content: [{ type: "th", content: [p(text("Theme"))] }, { type: "th", content: [p(text("Mode"))] }] },
          { type: "tr", content: [{ type: "td", content: [p(text("Rosé Pine"))] }, { type: "td", content: [p(text("Dark"))] }] },
          { type: "tr", content: [{ type: "td", content: [p(text("Rosé Pine Dawn"))] }, { type: "td", content: [p(text("Light"))] }] },
        ],
      },
      { type: "blockquote", content: [p(text("Simplicity is prerequisite for reliability.", [{ type: "em" }]))] },
      p(text("Highlight", [{ type: "highlight" }]), text(" and "), text("links", [{ type: "link", attrs: { href: "https://rosepinetheme.com" } }]), text(".")),
    ],
  };
}
