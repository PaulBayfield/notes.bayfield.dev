# Notes server: replacing the official Outline image

Today notes.bayfield.dev runs **one server and two front ends**: the official Outline image (its API,
collaboration server, realtime socket and its own web app) and this repository's web app, served under
`/app/` on Outline's domain to share its session. The goal is **one server and one front end**: a server
of our own in `server/`, serving this web app at the root, that speaks Outline's API exactly. The front
end can still switch to other (official) Outline workspaces, so it must not be able to tell the two apart.

Decisions (2026-11-25):

- **New schema + a one-time import** from Outline's database and file storage (not Outline's tables in
  place). Ids, `urlId`s and URLs are kept, so links between documents, bookmarks and shares survive.
- **Big bang**: the whole server is built and checked against a copy of the real data, then the official
  image is swapped out in one go.
- **In this repository** (`server/`), one Docker image (web build + Hono server), like the other apps.

No Outline code is copied (Outline is BSL 1.1). The request and response shapes come from Outline's
OpenAPI spec (github.com/outline/openapi, BSD-3-Clause) and from what this front end already reads.

## What "compatible" means

The contract is what this front end (web and desktop) uses, in Outline's exact shapes:

| Surface | Details |
|---|---|
| HTTP API | `POST /api/<method>` with a JSON body; answers `{ data, policies?, pagination? }`, errors `{ ok: false, error, message, status }`. ~100 methods (list below). |
| Sessions | `accessToken` cookie (web, same origin), CSRF header on cookie-authenticated writes, `Authorization: Bearer` for API keys. |
| Sign-in | `auth.config` (providers), `/auth/oidc` + callback (Authentik), the desktop hand-off (`outline://…?token=` then `/auth/redirect?token=` setting the `accessToken` cookie), `auth.delete`. |
| Collaboration | Hocuspocus (Yjs) at `/collaboration/`, authenticated by `auth.info`'s `collaborationToken`, protocol v1, Outline's close codes. |
| Live updates | socket.io (Engine.IO v4, websocket) at `/realtime/`, Outline's event names and payloads. |
| Files | `attachments.create` (+ the upload endpoint it returns), `attachments.redirect`, `files.get`, exports through `fileOperations.*`. |
| Public shares | `/s/<shareId>` and `shares.info` for signed-out readers (served by this front end). |

Methods the front end calls today:

```
attachments.create attachments.redirect auth.info auth.config auth.delete
collections.add_user collections.archive collections.create collections.delete collections.documents collections.export
collections.export_all collections.info collections.list collections.move collections.update
comments.create comments.delete comments.list comments.resolve comments.unresolve comments.update (+ mentions)
documents.add_group documents.add_user documents.archive documents.archived documents.create documents.delete
documents.deleted documents.drafts documents.duplicate documents.empty_trash documents.export documents.group_memberships
documents.info documents.list documents.memberships documents.move documents.publish documents.remove_group
documents.remove_user documents.restore documents.search documents.search_titles documents.templatize documents.unpublish
documents.update documents.users documents.viewed
emojis.create emojis.delete emojis.list fileOperations.delete fileOperations.info fileOperations.list fileOperations.redirect
groupMemberships.list groups.add_user groups.create groups.delete groups.list groups.memberships groups.remove_user groups.update
installation.info notifications.create notifications.list notifications.update notifications.update_all
pins.create pins.delete pins.list reactions.create revisions.create revisions.info revisions.list
shares.create shares.info shares.list shares.revoke shares.update stars.create stars.delete stars.list
subscriptions.create subscriptions.delete subscriptions.info teams.update
templates.create templates.delete templates.duplicate templates.info templates.list templates.update
userMemberships.list users.activate users.info users.invite users.list users.notificationsSubscribe
users.notificationsUnsubscribe users.resendInvite users.suspend users.update users.update_role views.list
```

Out of scope for the first version (nothing here uses them): OAuth apps, webhooks, Slack and other
integrations, data attributes, AI answers, imports from other tools, email sign-in and passkeys.

## Architecture

- **Stack** (the family's): Node 24 running `.ts` directly, Hono, PostgreSQL 17 with postgres.js
  (`postgres.camel`), OIDC with Authentik. Local file storage on a volume (what production uses today).
- **Documents**: the Yjs state is the source of truth while a document is edited (as in Outline); the
  ProseMirror JSON, the Markdown text (for `documents.info`, exports, search) and revisions are derived
  from it with the **same editor schema as the front end** (`src/editor/schema.ts`, shared, not copied).
- **Search**: Postgres full-text search (French and English configurations, unaccent) with ranked
  context snippets, plus trigram title search for `search_titles`.
- **Permissions**: one policy module computing Outline's abilities (team role, collection permission,
  document memberships, group memberships), returned as `policies` like Outline does.
- **Realtime**: one in-process event bus; the socket and the collaboration server listen to it.

## Phases

1. **Foundation**: `server/` skeleton (config, migrations, the API envelope and errors, validation),
   the schema, sessions and sign-in (OIDC, the `accessToken` cookie, CSRF, the desktop hand-off,
   `collaborationToken`), `auth.*`, `installation.info`, `users.info`, the Docker image serving the web
   app at `/`.
2. **Content**: collections, documents (tree, create/update/move, drafts and publishing, archive, trash,
   duplicate, templates), stars, pins, views, revisions, memberships and groups, policies.
3. **Live**: the Hocuspocus collaboration server (persistence, revisions, derived text) and the realtime
   socket with Outline's events.
4. **Everything else**: comments, reactions, shares (and the public share page), subscriptions and
   notifications, users and team administration, emojis, attachments and files, exports, search, insights.
5. **Import**: a script reading Outline's database and file storage into the new schema, keeping ids;
   counts and spot checks against the source.
6. **Switch**: run this front end against both servers on a copy of the data and compare answers
   endpoint by endpoint; then stop Outline, import, deploy, point notes.bayfield.dev at the new image.
   Outline's database and files are kept untouched, so going back is restarting the old containers.
