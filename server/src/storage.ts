// Uploaded files on disk (Outline's local storage): attachments, avatars, emoji, exports. A file's key
// is its path under FILE_STORAGE_DIR, the same layout Outline uses ("uploads/<user>/<id>/<name>",
// "public/<team>/<id>/<name>"), so an import copies the folder as is.

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { FILE_STORAGE_DIR } from "./config.ts";
import { invalid } from "./http.ts";

/** A file name safe on disk and in a URL path (accents kept, separators and controls out). */
export const safeName = (name: string) =>
  name
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, "-")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 200) || "file";

/** The absolute path of a key, refusing anything that would leave the storage folder. */
export function pathOf(key: string): string {
  const path = resolve(FILE_STORAGE_DIR, key);
  if (!path.startsWith(resolve(FILE_STORAGE_DIR) + sep)) throw invalid("Invalid file key");
  return path;
}

export async function save(key: string, data: Uint8Array | ReadableStream<Uint8Array>): Promise<number> {
  const path = pathOf(key);
  await mkdir(dirname(path), { recursive: true });
  if (data instanceof Uint8Array) await writeFile(path, data);
  else await pipeline(Readable.fromWeb(data as never), createWriteStream(path));
  return (await stat(path)).size;
}

export async function exists(key: string): Promise<number | null> {
  try {
    return (await stat(pathOf(key))).size;
  } catch {
    return null;
  }
}

/** A file as a web stream, for a response. */
export const open = (key: string) => Readable.toWeb(createReadStream(pathOf(key))) as ReadableStream<Uint8Array>;

export async function remove(key: string) {
  await rm(pathOf(key), { force: true }).catch(() => {});
}

/** How a file should be shown: inline when browsers do it safely, otherwise downloaded. */
export function disposition(name: string, contentType: string, download = false) {
  const inline = !download && /^(image\/(png|jpe?g|gif|webp|avif)|video\/|audio\/|application\/pdf|text\/plain)/.test(contentType);
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
