import type { ReactNode } from "react";
import { OUTLINE_ICONS } from "../lib/outlineIcons";
import { emojiIcon } from "../lib/workspace";

/**
 * A collection or document icon as Outline stores it: an emoji, the name of one of Outline's
 * icons (drawn in the item's colour), or nothing (the fallback is shown).
 */
export function EntityIcon({ icon, color, size = 16, fallback }: { icon?: string | null; color?: string | null; size?: number; fallback: ReactNode }) {
  const emoji = emojiIcon(icon);
  if (emoji) return <span className="entity-emoji" style={{ fontSize: size * 0.9 }}>{emoji}</span>;
  const svg = icon ? OUTLINE_ICONS[icon] : undefined;
  if (!svg) return <>{fallback}</>;
  const inner = svg.fa ? size * (2 / 3) : size;
  return (
    <span className="entity-icon" style={{ width: size, height: size, color: color ?? undefined }}>
      <svg width={inner} height={inner} viewBox={svg.viewBox} fill="currentColor" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg.body }} />
    </span>
  );
}
