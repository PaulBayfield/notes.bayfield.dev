# Notes

A lightweight client for a self-hosted [Outline](https://github.com/outline/outline) wiki, with the
same look as [Calendar](https://github.com/PaulBayfield/calendar.bayfield.dev). It runs as a Tauri 2 desktop app
(system WebView2, no bundled Chromium) and as a web app served next to Outline.

Outline stays the server: storage, permissions, search and sharing are all Outline's. This app replaces
only the interface, so you can keep using Outline's own web app at the same time, and friends editing there
show up live here (and the other way round).

- Sidebar with collections, nested documents and starred documents (with Outline's icons), drag and drop to
  reorder or move documents; home with recent documents
- Live: collaborative editing over Outline's own collaboration server (Yjs) with cursors and presence, and the
  sidebar, titles and comments update as others change them
- Editor: `/` block menu, `@` mentions, `:` emoji, Markdown shortcuts (`#`, `-`, `- [ ]`, `>`, ```` ``` ````,
  `**bold**`…), Markdown paste, a formatting toolbar on selection, to-do lists, tables, notices, toggles, code blocks
  with syntax colours, math (KaTeX), images and file uploads (paste or drop)
- Collections: create and edit (name, Outline icon or emoji, colour, access), drag to reorder; each collection's
  overview is an editable page (Markdown descriptions are converted), with pinned documents
- Document menu like Outline's: star, subscribe, templatize, duplicate, unpublish, archive, move, import, new
  nested document, pin (collection / home), comments, history (preview and restore versions), insights, present
  (slides split at headings and dividers), export / copy as Markdown, search & replace in document (Ctrl+F),
  heading numbering, viewer insights, embeds (YouTube, Vimeo, Loom, Figma, Google Docs…) and full width
- Presence: collaborators' avatars; hover one for their role, local time and whether they're reading or editing
- Comments: select text → 💬 (or Ctrl+Alt+M); threads, replies, edit, resolve, in the right panel
- Search (Ctrl+K), contents panel, back/forward, archive/delete with undo
- Themes: System, Light, Dark, Rosé Pine, Rosé Pine Dawn. UI in French or English
- Offline: open documents are cached locally and sync when you're back

## Run it locally

```sh
npm install
npm run tauri dev    # desktop app
npm run dev          # web UI on http://localhost:1430 — add ?demo for sample data (no server needed)
npm run tauri build  # desktop installer → src-tauri/target/release/bundle/
```

The desktop build needs Rust and the MSVC C++ build tools: see <https://tauri.app/start/prerequisites/>.

## How it talks to Outline

- **Sign-in (desktop):** the app uses Outline's own desktop flow. It opens your server's SSO page with
  `?client=desktop` in a window of the app; once you're signed in, Outline hands back a one-time token, which the
  app exchanges for a session (valid 3 months), stored in Windows Credential Manager. If a provider refuses
  embedded windows (Google does), tick "Sign in with my browser instead": the browser then returns through an
  `outline://` link, which the app registers only at that moment (so it doesn't take that link type from the
  official Outline app otherwise).
- **Live updates (desktop):** Outline's realtime socket only accepts its session cookie, so the Rust side holds
  that connection (`src-tauri/src/realtime.rs`) and forwards events to the window. The web build connects directly.
- **API (desktop):** the webview never holds the session token. Its requests go to a `notes://` protocol that the
  Rust side forwards to the server with the token attached (`src-tauri/src/lib.rs`). This also covers
  images and attachments, which need authentication.
- **Web:** served on Outline's own domain (see below), it uses your normal Outline browser session.
- **Collaboration:** the editor connects to `wss://<server>/collaboration` with the same protocol and editor
  version as Outline's web app. The schema in `src/editor/schema.ts` mirrors Outline's node by node: the sync
  layer drops anything it can't represent, so a document containing unknown content is not opened (you get an
  "open in browser" button instead). If an Outline upgrade bumps the editor's major version, the server refuses
  the connection and the app says it needs an update; nothing gets overwritten.

## Web app (Docker)

The web build has to live on Outline's origin to use its session cookie, under a path such as `/app/`:

```sh
docker compose up -d --build     # serves the build on :8788 at /app/
```

Then route `https://notes.bayfield.dev/app/` to `localhost:8788` in your reverse proxy, **before** the catch-all
rule that sends everything to Outline. For example, with Caddy:

```
notes.bayfield.dev {
    handle /app/* {
        reverse_proxy localhost:8788
    }
    handle {
        reverse_proxy localhost:3000   # Outline
    }
}
```

or nginx: `location /app/ { proxy_pass http://127.0.0.1:8788; }` next to the existing `location /`.

Open `https://notes.bayfield.dev/app/`. If you're not signed in to Outline, the page links to its login.

## Desktop releases

Bump `version` in `package.json`, commit, then push a matching tag:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

`.github/workflows/release.yml` builds the Windows installers and attaches them to a draft GitHub release.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Ctrl+K` / `Ctrl+P` | Search (with text selected in the editor, `Ctrl+K` adds a link) |
| `Ctrl+N` | New document |
| `Ctrl+B` (or `\`) · `.` | Toggle sidebar · right panel (in the editor, `Ctrl+B` makes selected text bold) |
| `Alt+←` / `Alt+→` | Back / forward |
| `Ctrl+,` | Settings |
| `/` · `@` · `:` | Blocks · mentions · emoji |
| `Ctrl+B` `I` `U` `D` `E` | Bold, italic, underline, strikethrough, code |
| `Ctrl+Alt+1…4` | Headings |
| `Ctrl+Shift+7/8/9` | Numbered / bulleted / to-do list |
| `Ctrl+Alt+M` | Comment on the selection |
| `Ctrl+Enter` | Check a to-do, or leave a code block / notice / quote |
| `Ctrl+Click` | Open a link |

## License note

Outline is licensed under the BSL 1.1. This project doesn't include Outline code; its editor schema is written to
match Outline's so documents stay compatible. `src/lib/outlineIcons.ts` is generated by
`scripts/gen-outline-icons.mjs` from the [outline-icons](https://github.com/outline/outline-icons) package
(BSD-3-Clause) and Font Awesome Free (CC BY 4.0), following Outline's icon list.
