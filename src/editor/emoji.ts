// Outline stores emoji as nodes named by shortcode ("smile", "thumbs_up"). The shortcode → emoji
// table is big, so it's only loaded once a document actually contains an emoji node.

let table: Record<string, string> | null = null;
let loading: Promise<Record<string, string>> | null = null;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Outline renames these two (emoji-mart → gemoji names).
const RENAMED: Record<string, string> = { "+1": "thumbs_up", "-1": "thumbs_down" };

export function loadEmoji(): Promise<Record<string, string>> {
  loading ??= import("@emoji-mart/data").then(({ default: data }) => {
    const map: Record<string, string> = {};
    const emojis = (data as { emojis: Record<string, { id: string; skins: { native: string }[] }> }).emojis;
    for (const emoji of Object.values(emojis)) {
      map[shortcodeOf(emoji.id)] = emoji.skins[0].native;
    }
    table = map;
    return map;
  });
  return loading;
}

// ---------- Custom (uploaded) emoji: stored in documents by id, as Outline does ----------

export interface CustomEmoji {
  id: string;
  name: string;
}

let custom: CustomEmoji[] = [];
const customById = new Map<string, CustomEmoji>();
/** The app turns a server path into a URL it can load (the desktop app goes through its proxy). */
let resolve = (path: string) => path;

export const isCustomEmoji = (name: string) => UUID.test(String(name ?? ""));

/** The workspace's custom emoji, for the pickers and their names. */
export function setCustomEmoji(list: CustomEmoji[], resolver?: (path: string) => string) {
  custom = [...list].sort((a, b) => a.name.localeCompare(b.name));
  customById.clear();
  for (const e of custom) customById.set(e.id, e);
  if (resolver) resolve = resolver;
}

export const customEmojiList = () => custom;
export const customEmojiName = (id: string) => customById.get(id)?.name ?? null;
/** A custom emoji's image, by id (works before the list has loaded). */
export const customEmojiSrc = (id: string) => resolve(`/api/emojis.redirect?id=${encodeURIComponent(id)}`);

/** Custom emoji whose name matches, for the ":" picker. */
export function searchCustomEmoji(query: string, limit = 8): CustomEmoji[] {
  const q = query.toLowerCase();
  return [...custom.filter((e) => e.name.startsWith(q)), ...custom.filter((e) => !e.name.startsWith(q) && e.name.includes(q))].slice(0, limit);
}

/** The emoji for a shortcode, or the shortcode itself until the table has loaded. */
export function emojiFor(name: string): string {
  const key = String(name ?? "").replace(/:/g, "");
  // Custom emoji are images (see the schema); as text, their name.
  if (UUID.test(key)) return `:${customById.get(key)?.name ?? "emoji"}:`;
  return table?.[key] ?? `:${key}:`;
}

export const emojiLoaded = () => table !== null;

/** Shortcodes matching a query, for the ":" picker. */
export async function searchEmoji(query: string, limit = 8): Promise<{ name: string; emoji: string }[]> {
  const map = await loadEmoji();
  const q = query.toLowerCase();
  const out: { name: string; emoji: string }[] = [];
  for (const [name, emoji] of Object.entries(map)) {
    if (name.startsWith(q)) out.push({ name, emoji });
    if (out.length >= limit) break;
  }
  if (out.length < limit)
    for (const [name, emoji] of Object.entries(map)) {
      if (!name.startsWith(q) && name.includes(q)) out.push({ name, emoji });
      if (out.length >= limit) break;
    }
  return out;
}

export interface CatalogEmoji {
  native: string;
  name: string;
  /** The name Outline stores in an emoji node. */
  shortcode: string;
  search: string;
}

export interface EmojiCategory {
  id: string;
  emojis: CatalogEmoji[];
}

/** emoji-mart id → Outline's shortcode ("thumbs-up" → "thumbs_up", "+1" → "thumbs_up"). */
function shortcodeOf(id: string): string {
  const name = id.replace(/(\w)-(\w)/g, "$1_$2");
  return RENAMED[name] ?? name;
}

let catalog: Promise<EmojiCategory[]> | null = null;

/** Every emoji, grouped by emoji-mart's categories, for the icon picker. */
export function loadEmojiCatalog(): Promise<EmojiCategory[]> {
  catalog ??= import("@emoji-mart/data").then(({ default: data }) => {
    const d = data as {
      categories: { id: string; emojis: string[] }[];
      emojis: Record<string, { id: string; name: string; keywords?: string[]; skins: { native: string }[] }>;
    };
    return d.categories.map((c) => ({
      id: c.id,
      emojis: c.emojis.flatMap((id) => {
        const e = d.emojis[id];
        return e ? [{ native: e.skins[0].native, name: e.name, shortcode: shortcodeOf(e.id), search: [e.id, e.name, ...(e.keywords ?? [])].join(" ").toLowerCase() }] : [];
      }),
    }));
  });
  return catalog;
}
