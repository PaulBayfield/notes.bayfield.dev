// Per-document display choices kept on this device (like Outline's "Enable embeds").

const key = (id: string) => `notes.embedsDisabled.${id}`;

export function embedsEnabled(id: string): boolean {
  try {
    return localStorage.getItem(key(id)) !== "1";
  } catch {
    return true;
  }
}

export function setEmbedsEnabled(id: string, enabled: boolean) {
  try {
    if (enabled) localStorage.removeItem(key(id));
    else localStorage.setItem(key(id), "1");
  } catch {
    // Not critical.
  }
}
