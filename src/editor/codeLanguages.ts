// Code block languages, keyed and labelled like Outline's (shared/editor/lib/code.ts), so the
// language picked here shows the same in Outline's web app. Highlighting uses refractor (Prism),
// as Outline does; each grammar is loaded the first time it's needed.

import type { Syntax } from "refractor/core";

export interface CodeLanguage {
  label: string;
  /** Prism grammar name. */
  lang: string;
  /** Kept for old documents, hidden from the picker. */
  alias?: boolean;
  load?: () => Promise<{ default: Syntax }>;
}

export const CODE_LANGUAGES: Record<string, CodeLanguage> = {
  none: { label: "Plain text", lang: "", load: undefined },
  abap: { label: "ABAP", lang: "abap", load: () => import("refractor/abap") },
  bash: { label: "Bash", lang: "bash", load: () => import("refractor/bash") },
  clike: { label: "C", lang: "clike", load: () => import("refractor/clike") },
  cpp: { label: "C++", lang: "cpp", load: () => import("refractor/cpp") },
  csharp: { label: "C#", lang: "csharp", load: () => import("refractor/csharp") },
  css: { label: "CSS", lang: "css", load: () => import("refractor/css") },
  csv: { label: "CSV", lang: "csv", load: () => import("refractor/csv") },
  dart: { label: "Dart", lang: "dart", load: () => import("refractor/dart") },
  diff: { label: "Diff", lang: "diff", load: () => import("refractor/diff") },
  docker: { label: "Docker", lang: "docker", load: () => import("refractor/docker") },
  elixir: { label: "Elixir", lang: "elixir", load: () => import("refractor/elixir") },
  erb: { label: "ERB", lang: "erb", load: () => import("refractor/erb") },
  erlang: { label: "Erlang", lang: "erlang", load: () => import("refractor/erlang") },
  fortran: { label: "Fortran", lang: "fortran", load: () => import("refractor/fortran") },
  go: { label: "Go", lang: "go", load: () => import("refractor/go") },
  graphql: { label: "GraphQL", lang: "graphql", load: () => import("refractor/graphql") },
  groovy: { label: "Groovy", lang: "groovy", load: () => import("refractor/groovy") },
  haskell: { label: "Haskell", lang: "haskell", load: () => import("refractor/haskell") },
  hcl: { label: "HCL", lang: "hcl", load: () => import("refractor/hcl") },
  markup: { label: "HTML", lang: "markup", load: () => import("refractor/markup") },
  ini: { label: "INI", lang: "ini", load: () => import("refractor/ini") },
  java: { label: "Java", lang: "java", load: () => import("refractor/java") },
  javascript: { label: "JavaScript", lang: "javascript", load: () => import("refractor/javascript") },
  json: { label: "JSON", lang: "json", load: () => import("refractor/json") },
  jsx: { label: "JSX", lang: "jsx", load: () => import("refractor/jsx") },
  kotlin: { label: "Kotlin", lang: "kotlin", load: () => import("refractor/kotlin") },
  kusto: { label: "Kusto", lang: "kusto", load: () => import("refractor/kusto") },
  lisp: { label: "Lisp", lang: "lisp", load: () => import("refractor/lisp") },
  lua: { label: "Lua", lang: "lua", load: () => import("refractor/lua") },
  makefile: { label: "Makefile", lang: "makefile", load: () => import("refractor/makefile") },
  markdown: { label: "Markdown", lang: "markdown", load: () => import("refractor/markdown") },
  mermaid: { label: "Mermaid", lang: "mermaid", load: () => import("refractor/mermaid") },
  mermaidjs: { label: "Mermaid", lang: "mermaid", alias: true, load: () => import("refractor/mermaid") },
  nginx: { label: "Nginx", lang: "nginx", load: () => import("refractor/nginx") },
  nix: { label: "Nix", lang: "nix", load: () => import("refractor/nix") },
  objectivec: { label: "Objective-C", lang: "objectivec", load: () => import("refractor/objectivec") },
  ocaml: { label: "OCaml", lang: "ocaml", load: () => import("refractor/ocaml") },
  perl: { label: "Perl", lang: "perl", load: () => import("refractor/perl") },
  php: { label: "PHP", lang: "php", load: () => import("refractor/php") },
  powershell: { label: "Powershell", lang: "powershell", load: () => import("refractor/powershell") },
  promql: { label: "PromQL", lang: "promql", load: () => import("refractor/promql") },
  protobuf: { label: "Protobuf", lang: "protobuf", load: () => import("refractor/protobuf") },
  python: { label: "Python", lang: "python", load: () => import("refractor/python") },
  r: { label: "R", lang: "r", load: () => import("refractor/r") },
  regex: { label: "Regex", lang: "regex", load: () => import("refractor/regex") },
  ruby: { label: "Ruby", lang: "ruby", load: () => import("refractor/ruby") },
  rust: { label: "Rust", lang: "rust", load: () => import("refractor/rust") },
  scala: { label: "Scala", lang: "scala", load: () => import("refractor/scala") },
  sass: { label: "Sass", lang: "sass", load: () => import("refractor/sass") },
  scss: { label: "SCSS", lang: "scss", load: () => import("refractor/scss") },
  "splunk-spl": { label: "Splunk SPL", lang: "splunk-spl", load: () => import("refractor/splunk-spl") },
  sql: { label: "SQL", lang: "sql", load: () => import("refractor/sql") },
  solidity: { label: "Solidity", lang: "solidity", load: () => import("refractor/solidity") },
  swift: { label: "Swift", lang: "swift", load: () => import("refractor/swift") },
  toml: { label: "TOML", lang: "toml", load: () => import("refractor/toml") },
  tsx: { label: "TSX", lang: "tsx", load: () => import("refractor/tsx") },
  typescript: { label: "TypeScript", lang: "typescript", load: () => import("refractor/typescript") },
  vb: { label: "Visual Basic", lang: "vbnet", load: () => import("refractor/vbnet") },
  verilog: { label: "Verilog", lang: "verilog", load: () => import("refractor/verilog") },
  vhdl: { label: "VHDL", lang: "vhdl", load: () => import("refractor/vhdl") },
  yaml: { label: "YAML", lang: "yaml", load: () => import("refractor/yaml") },
  xml: { label: "XML", lang: "markup", load: () => import("refractor/markup") },
  zig: { label: "Zig", lang: "zig", load: () => import("refractor/zig") },
};

const SHORT_NAMES: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  ts: "typescript",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  html: "markup",
  c: "clike",
  "c++": "cpp",
  cs: "csharp",
  py: "python",
  yml: "yaml",
  rb: "ruby",
  rs: "rust",
  md: "markdown",
  dockerfile: "docker",
  ps1: "powershell",
  kt: "kotlin",
  golang: "go",
  text: "none",
  txt: "none",
  plaintext: "none",
};

/** Outline's id for a language name as written after ``` ("js" → "javascript"). */
export function languageId(name: string): string {
  const lower = name.toLowerCase();
  if (!lower) return "none";
  return CODE_LANGUAGES[lower] ? lower : (SHORT_NAMES[lower] ?? lower);
}
