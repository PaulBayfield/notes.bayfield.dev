export const isTauri = "__TAURI_INTERNALS__" in window;
export const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);
const isWindows = /Windows/.test(navigator.userAgent);

/**
 * Where API calls go. Desktop: the `notes://` protocol, which the Rust side forwards to the
 * server with the session token attached. Web: Outline's own origin (the app is served there).
 */
export const apiBase = isTauri ? (isWindows ? "http://notes.localhost" : "notes://localhost") : "";

export const mod = isMac ? "⌘" : "Ctrl";

/** Opens a link in the system browser (desktop) or a new tab (web). */
export async function openExternal(url: string): Promise<void> {
  if (isTauri) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else window.open(url, "_blank", "noopener");
}

/** Saves text to a file: a save dialog on desktop, a download on the web. Returns false if cancelled. */
export async function saveTextFile(name: string, contents: string, type = "text/markdown"): Promise<boolean> {
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<boolean>("save_file", { name, contents });
  }
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

/** Desktop: asks for files with the system dialog. Returns their paths (empty if cancelled). */
export async function pickFiles(images: boolean): Promise<string[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string[]>("pick_files", { images });
}
