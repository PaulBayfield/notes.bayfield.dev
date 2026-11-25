// Bundles editor/entry.ts and everything it imports into one ESM file Node runs as is.
import { defineConfig } from "rolldown";

export default defineConfig({
  input: new URL("./entry.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  platform: "node",
  // Yjs stays the server's own copy (server/node_modules), the one the collaboration server uses: two
  // copies of Yjs can't share documents.
  external: ["yjs"],
  output: { file: new URL("../src/editor.bundle.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), format: "esm", codeSplitting: false },
});
