#!/usr/bin/env bash
# Prints the release notes for a tag: its commits since the previous tag, grouped by
# Conventional Commit type, followed by the installer notes.
# Usage: scripts/release-notes.sh v0.16.0 [owner/repo]
tag=${1:?usage: release-notes.sh <tag> [owner/repo]}
repo=${2:-$GITHUB_REPOSITORY}
prev=$(git describe --tags --abbrev=0 "$tag^" 2>/dev/null)
range=${prev:+$prev..}$tag
types='feat|fix|perf|refactor|style|docs|ci|chore'

subjects() {
  git log --no-merges --reverse --format='%s' "$range" | grep -v '^chore(release)'
}

section() { # <type> <title>
  local lines
  lines=$(subjects | grep -E "^$1(\([^)]*\))?!?: " \
    | sed -E 's/^[a-z]+\(([^)]*)\)!?: (.*)/- **\1:** \2/; s/^[a-z]+!?: (.*)/- \1/')
  if [ -n "$lines" ]; then printf '### %s\n\n%s\n\n' "$2" "$lines"; fi
}

section feat "Features"
section fix "Bug fixes"
section perf "Performance"
section refactor "Refactoring"
section style "Style"
section docs "Documentation"
section ci "CI"
section chore "Chores"

others=$(subjects | grep -vE "^($types)(\([^)]*\))?!?: " | sed 's/^/- /')
if [ -n "$others" ]; then printf '### Other\n\n%s\n\n' "$others"; fi

if [ -n "$prev" ] && [ -n "$repo" ]; then
  printf '**Full changelog:** https://github.com/%s/compare/%s...%s\n\n' "$repo" "$prev" "$tag"
fi

cat <<'EOF'
---

Windows installers: `Notes_*_x64-setup.exe` (recommended) or the `.msi`.
The installer isn't code-signed, so SmartScreen may ask you to confirm (More info → Run anyway).
EOF
