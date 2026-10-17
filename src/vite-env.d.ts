/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Server pre-filled on the desktop sign-in screen. */
  readonly VITE_OUTLINE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
