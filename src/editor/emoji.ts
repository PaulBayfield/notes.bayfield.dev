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
      const id = emoji.id.replace(/(\w)-(\w)/g, "$1_$2");
      map[RENAMED[id] ?? id] = emoji.skins[0].native;
    }
    table = map;
    return map;
  });
  return loading;
}

/** The emoji for a shortcode, or the shortcode itself until the table has loaded. */
export function emojiFor(name: string): string {
  const key = String(name ?? "").replace(/:/g, "");
  // Custom (uploaded) emoji are stored by id; we don't render those, so show the shortcode form.
  if (UUID.test(key)) return `:${key.slice(0, 8)}:`;
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

export interface EmojiCategory {
  id: string;
  emojis: { native: string; name: string; search: string }[];
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
        return e ? [{ native: e.skins[0].native, name: e.name, search: [e.id, e.name, ...(e.keywords ?? [])].join(" ").toLowerCase() }] : [];
      }),
    }));
  });
  return catalog;
}
