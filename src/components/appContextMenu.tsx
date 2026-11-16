// The app's own right-click menu, in place of the browser's (or WebView2's, with "Inspect" and
// "Reload" in the desktop app). Shift + right-click still opens the native one.

import { TextSelection } from "prosemirror-state";
import { docIdFromHref, webUrl } from "../lib/api";
import type { Translate } from "../lib/i18n";
import { mod, openExternal } from "../lib/platform";
import { editorAt } from "../editor/registry";
import { menu, type MenuEntry } from "./Menu";
import { ArrowLeft, ArrowRight, ClipboardPaste, Copy, External, LinkIcon, MessageSquare, NewTab, Repeat, Scissors } from "./icons";

interface Context {
  t: Translate;
  back: () => void;
  forward: () => void;
  openDocument: (id: string, newTab?: boolean) => void;
}

const key = (combo: string) => `${mod}+${combo}`;

/** Pastes the clipboard as if Ctrl+V were pressed, so the editor's own paste rules apply. */
async function paste(target: HTMLElement, plain: boolean) {
  const data = new DataTransfer();
  try {
    if (!plain && navigator.clipboard.read) {
      for (const item of await navigator.clipboard.read()) {
        for (const type of item.types) if (type === "text/html" || type === "text/plain") data.setData(type, await (await item.getType(type)).text());
      }
    } else data.setData("text/plain", await navigator.clipboard.readText());
  } catch {
    // Clipboard access refused: nothing to paste.
    return;
  }
  target.focus();
  target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
}

/** Text fields: the browser can paste into them itself once given the text. */
async function pasteInto(field: HTMLInputElement | HTMLTextAreaElement) {
  try {
    const text = await navigator.clipboard.readText();
    field.focus();
    document.execCommand("insertText", false, text);
  } catch {
    // Clipboard access refused.
  }
}

const command = (target: HTMLElement, name: "cut" | "copy" | "selectAll") => () => {
  target.focus();
  document.execCommand(name);
};

function linkItems(href: string, c: Context): (MenuEntry | false)[] {
  const id = docIdFromHref(href);
  const url = href.startsWith("/") ? webUrl(href) : href;
  return [
    { label: c.t("openLink"), icon: <External size={15} />, onClick: () => (id ? c.openDocument(id) : void openExternal(url)) },
    !!id && { label: c.t("openInNewTab"), icon: <NewTab size={15} />, onClick: () => c.openDocument(id, true) },
    { label: c.t("copyLink"), icon: <LinkIcon size={15} />, onClick: () => void navigator.clipboard.writeText(url) },
    { kind: "separator" },
  ];
}

/** The menu for a right-click on `target`, or null to leave it to the native one. */
export function contextMenuFor(target: Element, x: number, y: number, c: Context): MenuEntry[] | null {
  const { t } = c;
  const selected = !!window.getSelection()?.toString();
  const link = target.closest("a[href]")?.getAttribute("href");

  const editor = editorAt(target);
  if (editor) {
    const { view } = editor;
    // Right-clicking outside the selection moves the cursor there, as in other editors.
    const at = view.posAtCoords({ left: x, top: y })?.pos;
    const { from, to } = view.state.selection;
    if (at !== undefined && (at < from || at > to)) view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at))));
    const empty = view.state.selection.empty;
    const dom = view.dom as HTMLElement;
    return menu([
      ...(link ? linkItems(link, c) : []),
      view.editable && { label: t("cut"), icon: <Scissors size={15} />, kbd: key("X"), disabled: empty, onClick: command(dom, "cut") },
      { label: t("copy"), icon: <Copy size={15} />, kbd: key("C"), disabled: empty, onClick: command(dom, "copy") },
      view.editable && { label: t("paste"), icon: <ClipboardPaste size={15} />, kbd: key("V"), onClick: () => void paste(dom, false) },
      view.editable && { label: t("pastePlain"), kbd: key("Shift+V"), onClick: () => void paste(dom, true) },
      { kind: "separator" },
      editor.comment && !empty && { label: t("comment"), icon: <MessageSquare size={15} />, kbd: key("Alt+M"), onClick: editor.comment },
      { label: t("selectAll"), kbd: key("A"), onClick: command(dom, "selectAll") },
    ]);
  }

  const field = target.closest("input, textarea") as HTMLInputElement | HTMLTextAreaElement | null;
  if (field && !["checkbox", "radio", "range", "color", "file"].includes(field.type)) {
    const hasSelection = field.selectionStart !== field.selectionEnd;
    const editable = !field.readOnly && !field.disabled;
    return menu([
      editable && { label: t("cut"), icon: <Scissors size={15} />, kbd: key("X"), disabled: !hasSelection, onClick: command(field, "cut") },
      { label: t("copy"), icon: <Copy size={15} />, kbd: key("C"), disabled: !hasSelection, onClick: command(field, "copy") },
      editable && { label: t("paste"), icon: <ClipboardPaste size={15} />, kbd: key("V"), onClick: () => void pasteInto(field) },
      { kind: "separator" },
      { label: t("selectAll"), kbd: key("A"), onClick: () => (field.focus(), field.select()) },
    ]);
  }

  return menu([
    ...(link ? linkItems(link, c) : []),
    selected && { label: t("copy"), icon: <Copy size={15} />, kbd: key("C"), onClick: () => void navigator.clipboard.writeText(window.getSelection()?.toString() ?? "") },
    selected && { kind: "separator" },
    { label: t("back"), icon: <ArrowLeft size={15} />, kbd: "Alt+←", onClick: c.back },
    { label: t("forward"), icon: <ArrowRight size={15} />, kbd: "Alt+→", onClick: c.forward },
    { label: t("reload"), icon: <Repeat size={15} />, onClick: () => location.reload() },
  ]);
}
