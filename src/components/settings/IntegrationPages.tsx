// "API & apps": personal API keys, the apps someone connected (OAuth), connecting an assistant over MCP,
// and for admins the workspace's OAuth applications and its audit log. Same pages and options as
// Outline's settings.

import { useState, type ReactNode } from "react";
import {
  createApiKey,
  createOAuthClient,
  deleteApiKey,
  deleteOAuthClient,
  disconnectApp,
  listApiKeys,
  listConnections,
  listOAuthClients,
  mcpUrl,
  rotateOAuthSecret,
  updateOAuthClient,
  type ApiKey,
  type OAuthClient,
  type OAuthClientInput,
} from "../../lib/integrations";
import { updateTeam } from "../../lib/api";
import { useSettings } from "../../lib/settings";
import type { StringKey } from "../../lib/i18n";
import { Avatar } from "../Avatar";
import { ConfirmDialog, Dialog } from "../Dialogs";
import { Check, Copy, Pencil, Plus, Repeat, Trash } from "../icons";
import { Empty, Loading, PageHeader, Row, Select, Switch, useLoad, usePage } from "./common";

/** A value to copy: an API key, a client secret, the MCP address. */
export function CopyField({ value, secret }: { value: string; secret?: boolean }) {
  const { t } = useSettings();
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-field">
      <input className={`text-field mono${secret ? " secret" : ""}`} readOnly value={value} onFocus={(e) => e.currentTarget.select()} />
      <button
        type="button"
        className="icon-button small"
        title={t("copy")}
        aria-label={t("copy")}
        onClick={() =>
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

// ---------- API keys ----------

type ScopeChoice = "all" | "read" | "custom";
type ExpiryChoice = "never" | "7" | "30" | "90" | "365";

function NewKeyDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (key: ApiKey) => void }) {
  const { t } = useSettings();
  const { onError } = usePage();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<ScopeChoice>("all");
  const [custom, setCustom] = useState("");
  const [expiry, setExpiry] = useState<ExpiryChoice>("never");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const scopes = scope === "read" ? ["read"] : scope === "custom" ? custom.split(/[\s,]+/).filter(Boolean) : undefined;
      const expiresAt = expiry === "never" ? null : new Date(Date.now() + Number(expiry) * 24 * 60 * 60_000).toISOString();
      onCreated(await createApiKey({ name: name.trim(), scope: scopes, expiresAt }));
    } catch (e) {
      onError(e);
      setBusy(false);
    }
  };

  return (
    <Dialog title={t("newApiKey")} onClose={onClose}>
      <form
        className="settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void submit();
        }}
      >
        <label>
          <span>{t("nameLabel")}</span>
          <input className="text-field" autoFocus value={name} maxLength={255} placeholder={t("apiKeyNamePlaceholder")} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          <span>
            {t("apiKeyScope")}
            <span className="settings-hint">{t("apiKeyScopeHint")}</span>
          </span>
          <Select<ScopeChoice>
            value={scope}
            options={[
              ["all", t("scopeAll")],
              ["read", t("scopeRead")],
              ["custom", t("scopeCustom")],
            ]}
            onChange={setScope}
          />
        </label>
        {scope === "custom" && (
          <label>
            <span>
              {t("scopeMethods")}
              <span className="settings-hint">{t("scopeMethodsHint")}</span>
            </span>
            <input className="text-field mono" value={custom} placeholder="documents.info documents.search collections.*" onChange={(e) => setCustom(e.target.value)} />
          </label>
        )}
        <label>
          <span>{t("expiration")}</span>
          <Select<ExpiryChoice>
            value={expiry}
            options={[
              ["never", t("neverExpires")],
              ["7", t("inDays", { n: 7 })],
              ["30", t("inDays", { n: 30 })],
              ["90", t("inDays", { n: 90 })],
              ["365", t("inDays", { n: 365 })],
            ]}
            onChange={setExpiry}
          />
        </label>
        <div className="dialog-actions">
          <button type="button" className="text-button" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="primary-button" disabled={busy || !name.trim() || (scope === "custom" && !custom.trim())}>
            {t("create")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function scopeLabel(key: ApiKey, t: (k: StringKey) => string) {
  if (!key.scope?.length) return t("scopeAll");
  if (key.scope.length === 1 && key.scope[0] === "read") return t("scopeRead");
  return key.scope.join(", ");
}

/** Personal API keys; admins can also see (and revoke) everyone's. */
export function ApiKeysPage() {
  const { t, f } = useSettings();
  const { me, onError, flash } = usePage();
  const admin = me.role === "admin";
  const [everyone, setEveryone] = useState(false);
  const { data: keys, reload } = useLoad(() => listApiKeys({ all: everyone }), [everyone]);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<ApiKey | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const canCreate = me.role === "admin" || me.role === "member";

  return (
    <>
      <PageHeader title={t("apiKeys")} hint={t("apiKeysHint")}>
        {canCreate && (
          <button className="primary-button" onClick={() => setCreating(true)}>
            <Plus size={14} />
            {t("newApiKey")}
          </button>
        )}
      </PageHeader>
      {created?.value && (
        <section className="settings-rows notice-box">
          <h3>{t("apiKeyCreated", { name: created.name })}</h3>
          <p className="dialog-text">{t("apiKeyCopyNow")}</p>
          <CopyField value={created.value} />
          <p className="settings-hint">{t("apiKeyUsage")}</p>
        </section>
      )}
      {admin && (
        <section className="settings-rows">
          <Row label={t("everyonesKeys")} hint={t("everyonesKeysHint")}>
            <Switch checked={everyone} onChange={setEveryone} />
          </Row>
        </section>
      )}
      <section className="settings-rows">
        {!keys ? (
          <Loading />
        ) : keys.length === 0 ? (
          <Empty>{t("noApiKeys")}</Empty>
        ) : (
          <div className="settings-list">
            {keys.map((k) => {
              const expired = !!k.expiresAt && new Date(k.expiresAt) < new Date();
              return (
                <div key={k.id} className={`settings-item${expired ? " faded" : ""}`}>
                  <div className="settings-item-text">
                    <span className="settings-item-title">
                      {k.name} <span className="mono muted">…{k.last4}</span>
                    </span>
                    <span className="settings-hint">
                      {[
                        scopeLabel(k, t),
                        k.expiresAt ? (expired ? t("expired") : t("expiresOn", { date: f.date(k.expiresAt) })) : t("neverExpires"),
                        k.lastActiveAt ? t("lastUsed", { when: f.relative(k.lastActiveAt) }) : t("neverUsed"),
                        everyone && k.userId !== me.id ? t("otherPersonsKey") : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </div>
                  <button className="icon-button small danger" title={t("revoke")} aria-label={t("revoke")} onClick={() => setRevoking(k)}>
                    <Trash size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>
      {creating && (
        <NewKeyDialog
          onClose={() => setCreating(false)}
          onCreated={(k) => {
            setCreating(false);
            setCreated(k);
            reload();
          }}
        />
      )}
      {revoking && (
        <ConfirmDialog
          title={t("revokeApiKey")}
          message={t("revokeApiKeyMessage", { name: revoking.name })}
          confirm={t("revoke")}
          danger
          onClose={() => setRevoking(null)}
          onConfirm={async () => {
            try {
              await deleteApiKey(revoking.id);
              if (created?.id === revoking.id) setCreated(null);
              flash(t("revoked"));
              reload();
            } catch (e) {
              onError(e);
            }
          }}
        />
      )}
    </>
  );
}

// ---------- Connected apps ----------

export function ConnectedAppsPage() {
  const { t, f } = useSettings();
  const { onError, flash } = usePage();
  const { data: apps, reload } = useLoad(listConnections, []);
  const [removing, setRemoving] = useState<string | null>(null);
  const target = apps?.find((a) => a.oauthClientId === removing);

  return (
    <>
      <PageHeader title={t("connectedApps")} hint={t("connectedAppsHint")} />
      <section className="settings-rows">
        {!apps ? (
          <Loading />
        ) : apps.length === 0 ? (
          <Empty>{t("noConnectedApps")}</Empty>
        ) : (
          <div className="settings-list">
            {apps.map((a) => (
              <div key={a.id} className="settings-item">
                <Avatar user={{ name: a.oauthClient.name, color: "var(--primary)", avatarUrl: a.oauthClient.avatarUrl }} size={32} className="square" />
                <div className="settings-item-text">
                  <span className="settings-item-title">{a.oauthClient.name}</span>
                  <span className="settings-hint">
                    {[
                      a.scope.includes("write") ? t("scopeAll") : a.scope.includes("read") ? t("scopeRead") : a.scope.join(", "),
                      t("connectedOn", { date: f.date(a.createdAt) }),
                      a.lastActiveAt ? t("lastUsed", { when: f.relative(a.lastActiveAt) }) : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
                <button className="text-button danger" onClick={() => setRemoving(a.oauthClientId)}>
                  {t("disconnect")}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
      {target && (
        <ConfirmDialog
          title={t("disconnectApp")}
          message={t("disconnectAppMessage", { name: target.oauthClient.name })}
          confirm={t("disconnect")}
          danger
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            try {
              await disconnectApp(target.oauthClientId);
              flash(t("disconnected"));
              reload();
            } catch (e) {
              onError(e);
            }
          }}
        />
      )}
    </>
  );
}

// ---------- MCP ----------

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className="mcp-step">
      <span className="mcp-step-number">{n}</span>
      <div className="mcp-step-body">
        <h4>{title}</h4>
        {children}
      </div>
    </div>
  );
}

type McpClient = "claude" | "claudeCode" | "cursor" | "vscode" | "other";

/** Connecting an assistant (Claude, Cursor, VS Code…) to the workspace over MCP. */
export function McpPage() {
  const { t } = useSettings();
  const { team, setTeam, teamCan, flash, onError } = usePage();
  const url = mcpUrl(team);
  const enabled = (team.preferences as Record<string, unknown> | null)?.mcp !== false;
  const [client, setClient] = useState<McpClient>("claude");
  const name = team.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "notes";

  const toggle = async (on: boolean) => {
    const before = team;
    setTeam({ ...team, preferences: { ...team.preferences, mcp: on } });
    try {
      setTeam(await updateTeam({ preferences: { mcp: on } }));
      flash(t("saved"));
    } catch (e) {
      setTeam(before);
      onError(e);
    }
  };

  const snippets: Record<McpClient, ReactNode> = {
    claude: (
      <ol className="mcp-instructions">
        <li>{t("mcpClaudeStep1")}</li>
        <li>{t("mcpClaudeStep2")}</li>
        <li>{t("mcpClaudeStep3")}</li>
      </ol>
    ),
    claudeCode: <CopyField value={`claude mcp add --transport http ${name} ${url}`} />,
    cursor: <pre className="mcp-code">{JSON.stringify({ mcpServers: { [name]: { url } } }, null, 2)}</pre>,
    vscode: <pre className="mcp-code">{JSON.stringify({ servers: { [name]: { type: "http", url } } }, null, 2)}</pre>,
    other: <p className="dialog-text">{t("mcpOtherHint")}</p>,
  };

  return (
    <>
      <PageHeader title={t("mcp")} hint={t("mcpHint")} />
      {teamCan("update") && (
        <section className="settings-rows">
          <Row label={t("mcpEnabled")} hint={t("mcpEnabledHint")}>
            <Switch checked={enabled} onChange={(on) => void toggle(on)} />
          </Row>
        </section>
      )}
      {!enabled ? (
        <Empty>{t("mcpDisabled")}</Empty>
      ) : (
        <section className="settings-rows">
          <Step n={1} title={t("mcpStepUrl")}>
            <CopyField value={url} />
          </Step>
          <Step n={2} title={t("mcpStepClient")}>
            <Select<McpClient>
              value={client}
              options={[
                ["claude", "Claude (claude.ai, Desktop)"],
                ["claudeCode", "Claude Code"],
                ["cursor", "Cursor"],
                ["vscode", "VS Code"],
                ["other", t("mcpOtherClient")],
              ]}
              onChange={setClient}
            />
            <div className="mcp-snippet">{snippets[client]}</div>
          </Step>
          <Step n={3} title={t("mcpStepSignIn")}>
            <p className="dialog-text">{t("mcpSignInHint")}</p>
          </Step>
          <p className="settings-hint">{t("mcpApiKeyHint")}</p>
        </section>
      )}
    </>
  );
}

// ---------- OAuth applications (admins) ----------

function ClientDialog({ client, onClose, onSaved }: { client: OAuthClient | null; onClose: () => void; onSaved: (c: OAuthClient) => void }) {
  const { t } = useSettings();
  const { onError } = usePage();
  const [name, setName] = useState(client?.name ?? "");
  const [description, setDescription] = useState(client?.description ?? "");
  const [developerName, setDeveloperName] = useState(client?.developerName ?? "");
  const [developerUrl, setDeveloperUrl] = useState(client?.developerUrl ?? "");
  const [avatarUrl, setAvatarUrl] = useState(client?.avatarUrl ?? "");
  const [redirects, setRedirects] = useState((client?.redirectUris ?? []).join("\n"));
  const [type, setType] = useState<"confidential" | "public">(client?.clientType ?? "confidential");
  const [published, setPublished] = useState(client?.published ?? false);
  const [busy, setBusy] = useState(false);
  const uris = redirects
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const submit = async () => {
    setBusy(true);
    const input: OAuthClientInput = {
      name: name.trim(),
      description: description.trim() || null,
      developerName: developerName.trim() || null,
      developerUrl: developerUrl.trim() || null,
      avatarUrl: avatarUrl.trim() || null,
      redirectUris: uris,
      published,
    };
    try {
      onSaved(client ? await updateOAuthClient(client.id, input) : await createOAuthClient({ ...input, clientType: type }));
    } catch (e) {
      onError(e);
      setBusy(false);
    }
  };

  return (
    <Dialog title={client ? t("editApplication") : t("newApplication")} onClose={onClose}>
      <form
        className="settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && uris.length) void submit();
        }}
      >
        <label>
          <span>{t("nameLabel")}</span>
          <input className="text-field" autoFocus value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          <span>{t("descriptionLabel")}</span>
          <input className="text-field" value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label>
          <span>
            {t("redirectUris")}
            <span className="settings-hint">{t("redirectUrisHint")}</span>
          </span>
          <textarea className="text-field mono" rows={3} value={redirects} placeholder="https://example.com/oauth/callback" onChange={(e) => setRedirects(e.target.value)} />
        </label>
        {!client && (
          <label>
            <span>
              {t("clientType")}
              <span className="settings-hint">{t("clientTypeHint")}</span>
            </span>
            <Select
              value={type}
              options={[
                ["confidential", t("clientConfidential")],
                ["public", t("clientPublic")],
              ]}
              onChange={setType}
            />
          </label>
        )}
        <label>
          <span>{t("developerName")}</span>
          <input className="text-field" value={developerName} maxLength={255} onChange={(e) => setDeveloperName(e.target.value)} />
        </label>
        <label>
          <span>{t("developerUrl")}</span>
          <input className="text-field" type="url" value={developerUrl} maxLength={500} onChange={(e) => setDeveloperUrl(e.target.value)} />
        </label>
        <label>
          <span>{t("iconUrl")}</span>
          <input className="text-field" type="url" value={avatarUrl} maxLength={500} onChange={(e) => setAvatarUrl(e.target.value)} />
        </label>
        <Row label={t("publishedApp")} hint={t("publishedAppHint")}>
          <Switch checked={published} onChange={setPublished} />
        </Row>
        <div className="dialog-actions">
          <button type="button" className="text-button" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="primary-button" disabled={busy || !name.trim() || !uris.length}>
            {client ? t("save") : t("create")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function ApplicationsPage() {
  const { t, f } = useSettings();
  const { onError, flash } = usePage();
  const { data: clients, reload } = useLoad(listOAuthClients, []);
  const [editing, setEditing] = useState<OAuthClient | "new" | null>(null);
  const [secret, setSecret] = useState<OAuthClient | null>(null);
  const [deleting, setDeleting] = useState<OAuthClient | null>(null);
  const [rotating, setRotating] = useState<OAuthClient | null>(null);

  return (
    <>
      <PageHeader title={t("applications")} hint={t("applicationsHint")}>
        <button className="primary-button" onClick={() => setEditing("new")}>
          <Plus size={14} />
          {t("newApplication")}
        </button>
      </PageHeader>
      {secret && (
        <section className="settings-rows notice-box">
          <h3>{secret.name}</h3>
          <label className="settings-form">
            <span>{t("clientId")}</span>
            <CopyField value={secret.clientId} />
          </label>
          {secret.clientSecret && (
            <label className="settings-form">
              <span>{t("clientSecret")}</span>
              <CopyField value={secret.clientSecret} />
              <span className="settings-hint">{t("clientSecretCopyNow")}</span>
            </label>
          )}
        </section>
      )}
      <section className="settings-rows">
        {!clients ? (
          <Loading />
        ) : clients.length === 0 ? (
          <Empty>{t("noApplications")}</Empty>
        ) : (
          <div className="settings-list">
            {clients.map((c) => (
              <div key={c.id} className="settings-item">
                <Avatar user={{ name: c.name, color: "var(--primary)", avatarUrl: c.avatarUrl }} size={32} className="square" />
                <button className="settings-item-main" onClick={() => setSecret({ ...c, clientSecret: undefined })}>
                  <span className="settings-item-text">
                    <span className="settings-item-title">{c.name}</span>
                    <span className="settings-hint">
                      {[c.clientType === "public" ? t("clientPublic") : t("clientConfidential"), c.redirectUris[0], t("createdOn", { date: f.date(c.createdAt) })]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                </button>
                <button className="icon-button small" title={t("edit")} aria-label={t("edit")} onClick={() => setEditing(c)}>
                  <Pencil size={14} />
                </button>
                {c.clientType === "confidential" && (
                  <button className="icon-button small" title={t("rotateSecret")} aria-label={t("rotateSecret")} onClick={() => setRotating(c)}>
                    <Repeat size={14} />
                  </button>
                )}
                <button className="icon-button small danger" title={t("delete")} aria-label={t("delete")} onClick={() => setDeleting(c)}>
                  <Trash size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
      {editing && (
        <ClientDialog
          client={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(c) => {
            setEditing(null);
            if (c.clientSecret || editing === "new") setSecret(c);
            flash(t("saved"));
            reload();
          }}
        />
      )}
      {rotating && (
        <ConfirmDialog
          title={t("rotateSecret")}
          message={t("rotateSecretMessage", { name: rotating.name })}
          confirm={t("rotateSecret")}
          danger
          onClose={() => setRotating(null)}
          onConfirm={async () => {
            try {
              setSecret(await rotateOAuthSecret(rotating.id));
            } catch (e) {
              onError(e);
            }
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={t("deleteApplication")}
          message={t("deleteApplicationMessage", { name: deleting.name })}
          confirm={t("delete")}
          danger
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await deleteOAuthClient(deleting.id);
              if (secret?.id === deleting.id) setSecret(null);
              reload();
            } catch (e) {
              onError(e);
            }
          }}
        />
      )}
    </>
  );
}
