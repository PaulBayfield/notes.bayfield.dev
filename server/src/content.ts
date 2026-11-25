// Documents' content and their place in a collection: ids in URLs, slugs, the tree the sidebar shows
// (a collection's documentStructure, kept in sync on every change as in Outline), and writing a
// document's content (the Yjs state, the ProseMirror JSON, the Markdown and its task count together).

import { randomInt } from "node:crypto";
import { sql, type Tx } from "./db.ts";
import { countTasks, toMarkdown, type PMNode } from "./markdown.ts";
import { checkDoc, docToState, markdownToDoc, stateToDoc, type DocJSON } from "./editor.bundle.mjs";
import { invalid } from "./http.ts";

export { markdownToDoc, stateToDoc, docToState, checkDoc, type DocJSON };

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Outline's urlId: 10 random letters and digits, the end of a document's or collection's URL. */
export const newUrlId = () => Array.from({ length: 10 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");

/** "Réunion du 3 mai" → "reunion-du-3-mai" (accents off, as Outline's slugify). */
export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
  return slug || "untitled";
}

export const documentUrl = (d: { title: string; urlId: string }) => `/doc/${slugify(d.title)}-${d.urlId}`;
export const collectionUrl = (c: { name: string; urlId: string }) => `/collection/${slugify(c.name)}-${c.urlId}`;

// ---------- Content ----------

export interface ContentFields {
  content: DocJSON;
  state: Buffer;
  text: string;
}

/** A document's content, every form of it, from ProseMirror JSON. */
export function contentFrom(json: DocJSON): ContentFields {
  const doc = checkDoc(json);
  return { content: doc, state: Buffer.from(docToState(doc)), text: toMarkdown(doc as PMNode) };
}

export const contentFromMarkdown = (markdown: string) => contentFrom(markdownToDoc(markdown));

/** From a Yjs state (the collaboration server saving an edit). */
export function contentFromState(state: Uint8Array): ContentFields {
  const doc = stateToDoc(state);
  return { content: doc, state: Buffer.from(state), text: toMarkdown(doc as PMNode) };
}

export const tasksOf = (content: unknown) => countTasks(content as PMNode | null);

/** Parses a client's `data` (ProseMirror JSON), answering a validation error when it doesn't fit the schema. */
export function parseData(data: unknown): DocJSON {
  try {
    return checkDoc(data);
  } catch (e) {
    throw invalid(`data isn't a valid document: ${e instanceof Error ? e.message : e}`);
  }
}

// ---------- The collection's tree ----------

export interface NavNode {
  id: string;
  url: string;
  title: string;
  icon?: string | null;
  color?: string | null;
  children: NavNode[];
}

export function navNode(d: { id: string; title: string; urlId: string; icon: string | null; color: string | null }, children: NavNode[] = []): NavNode {
  const node: NavNode = { id: d.id, url: documentUrl(d), title: d.title, children };
  if (d.icon) node.icon = d.icon;
  if (d.color) node.color = d.color;
  return node;
}

/** Runs `change` on a collection's tree inside the transaction, with the row locked, and saves it. */
async function editTree(tx: Tx, collectionId: string, change: (tree: NavNode[]) => NavNode[] | void) {
  const [row] = await tx<{ documentStructure: NavNode[] }[]>`SELECT document_structure FROM collections WHERE id = ${collectionId} FOR UPDATE`;
  if (!row) return;
  const tree = structuredClone(row.documentStructure ?? []);
  const next = change(tree) ?? tree;
  await tx`UPDATE collections SET document_structure = ${tx.json(next as never)}, updated_at = now() WHERE id = ${collectionId}`;
}

/** Takes a document (and its children) out of a tree; returns it, or null when it wasn't there. */
export function detach(tree: NavNode[], id: string): NavNode | null {
  for (let i = 0; i < tree.length; i++) {
    if (tree[i].id === id) return tree.splice(i, 1)[0];
    const found = detach(tree[i].children, id);
    if (found) return found;
  }
  return null;
}

function findNode(tree: NavNode[], id: string): NavNode | null {
  for (const n of tree) {
    if (n.id === id) return n;
    const found = findNode(n.children, id);
    if (found) return found;
  }
  return null;
}

/** Puts a node under `parentId` (or at the top) at `index` (default: last). */
function attach(tree: NavNode[], node: NavNode, parentId: string | null, index?: number) {
  const siblings = parentId ? (findNode(tree, parentId)?.children ?? tree) : tree;
  const at = index === undefined || index < 0 || index > siblings.length ? siblings.length : index;
  siblings.splice(at, 0, node);
}

/** A published document joins its collection's tree, with its published children. */
export async function addToTree(tx: Tx, collectionId: string, node: NavNode, parentId: string | null, index?: number) {
  await editTree(tx, collectionId, (tree) => {
    detach(tree, node.id);
    attach(tree, node, parentId, index);
  });
}

/** A document (and its children) leaves its collection's tree; returns what was removed. */
export async function removeFromTree(tx: Tx, collectionId: string, id: string): Promise<NavNode | null> {
  let removed: NavNode | null = null;
  await editTree(tx, collectionId, (tree) => {
    removed = detach(tree, id);
  });
  return removed;
}

/** A renamed document (or a new icon): its node in the tree follows. */
export async function updateInTree(tx: Tx, collectionId: string, d: { id: string; title: string; urlId: string; icon: string | null; color: string | null }) {
  await editTree(tx, collectionId, (tree) => {
    const n = findNode(tree, d.id);
    if (!n) return;
    Object.assign(n, navNode(d, n.children));
    if (!d.icon) delete n.icon;
    if (!d.color) delete n.color;
  });
}

/** The document and every document under it (ids), via parentDocumentId. */
export async function descendants(tx: Tx | typeof sql, id: string): Promise<string[]> {
  const rows = await tx<{ id: string }[]>`
    WITH RECURSIVE t AS (SELECT id FROM documents WHERE parent_document_id = ${id} UNION SELECT d.id FROM documents d JOIN t ON d.parent_document_id = t.id)
    SELECT id FROM t`;
  return rows.map((r) => r.id);
}

/** The tree of a document's published, live children (to put back in a collection after a restore). */
export async function subtree(tx: Tx | typeof sql, doc: { id: string; title: string; urlId: string; icon: string | null; color: string | null }): Promise<NavNode> {
  const rows = await tx<{ id: string; parentDocumentId: string; title: string; urlId: string; icon: string | null; color: string | null }[]>`
    WITH RECURSIVE t AS (
      SELECT id, parent_document_id, title, url_id, icon, color FROM documents
      WHERE parent_document_id = ${doc.id} AND published_at IS NOT NULL AND archived_at IS NULL AND deleted_at IS NULL
      UNION ALL
      SELECT d.id, d.parent_document_id, d.title, d.url_id, d.icon, d.color FROM documents d JOIN t ON d.parent_document_id = t.id
      WHERE d.published_at IS NOT NULL AND d.archived_at IS NULL AND d.deleted_at IS NULL)
    SELECT id, parent_document_id, title, url_id, icon, color FROM t ORDER BY title`;
  const build = (parentId: string): NavNode[] => rows.filter((r) => r.parentDocumentId === parentId).map((r) => navNode(r, build(r.id)));
  return navNode(doc, build(doc.id));
}
