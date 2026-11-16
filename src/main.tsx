import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { registerPrefsDesktop } from "./lib/prefs";
import { isTauri } from "./lib/platform";
import "./styles.css";
import "./app.css";
import "./editor/editor.css";

// Desktop app: the shared preferences use its Tauri functions (see lib/prefs.ts).
if ("__TAURI_INTERNALS__" in window) registerPrefsDesktop({ invoke, openUrl });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Web build: register the service worker so the app can be installed and opens offline.
if (!isTauri && import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
  });
}
