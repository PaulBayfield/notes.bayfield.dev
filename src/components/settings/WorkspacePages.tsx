import { useEffect, useState } from "react";
import { chooseAndUploadImage, deleteFileOperation, downloadExport, listExports, updateTeam, type FileOperation, type Team, type UserRole } from "../../lib/api";
import { useSettings } from "../../lib/settings";
import { Avatar } from "../Avatar";
import { ConfirmDialog } from "../Dialogs";
import { EXPORT_FORMATS, ExportForm, startExport } from "../ExportDialog";
import { Trash, Upload } from "../icons";
import { Empty, Loading, PageHeader, Row, Select, Switch, useLoad, usePage } from "./common";

/** Outline's defaults for workspace preferences that were never set. */
const TEAM_DEFAULTS: Record<string, unknown> = {
  seamlessEdit: true,
  viewersCanExport: true,
  membersCanInvite: false,
  membersCanDeleteAccount: true,
  commenting: "members",
  tocPosition: "left",
  emailDisplay: "members",
  personalDocs: true,
};

/** Saves a workspace change right away, showing it before the server answers. */
function useTeamSaver() {
  const { t } = useSettings();
  const { team, setTeam, flash, onError } = usePage();
  const pref = <T,>(key: string) => (team.preferences?.[key] ?? TEAM_DEFAULTS[key]) as T;
  const save = async (patch: Partial<Team>) => {
    const before = team;
    setTeam({ ...team, ...patch, preferences: { ...team.preferences, ...patch.preferences } });
    try {
      setTeam(await updateTeam(patch));
      flash(t("saved"));
    } catch (e) {
      setTeam(before);
      onError(e);
    }
  };
  const savePref = (key: string, value: unknown) => save({ preferences: { [key]: value } });
  return { team, pref, save, savePref };
}

export function DetailsPage() {
  const { t } = useSettings();
  const { workspace, onError } = usePage();
  const { team, pref, save, savePref } = useTeamSaver();
  const [name, setName] = useState(team.name);
  const [description, setDescription] = useState(team.description ?? "");
  const changed = name.trim() !== team.name || description !== (team.description ?? "");

  const changeLogo = async () => {
    try {
      const attachment = await chooseAndUploadImage("avatar");
      if (attachment) await save({ avatarUrl: attachment.url });
    } catch (e) {
      onError(e);
    }
  };

  return (
    <>
      <PageHeader title={t("details")} hint={t("detailsHint")} />
      <section className="settings-rows">
        <Row label={t("logo")} hint={t("logoHint")}>
          <Avatar user={{ name: team.name, color: "var(--primary)", avatarUrl: team.avatarUrl }} size={48} className="square" />
          <button className="text-button" onClick={() => void changeLogo()}>
            {t("choosePhoto")}
          </button>
          {team.avatarUrl && (
            <button className="text-button" onClick={() => void save({ avatarUrl: null })}>
              {t("removePhoto")}
            </button>
          )}
        </Row>
        <form
          className="settings-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void save({ name: name.trim(), description });
          }}
        >
          <label>
            <span>{t("nameLabel")}</span>
            <input className="text-field" value={name} maxLength={255} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            <span>
              {t("workspaceDescription")}
              <span className="settings-hint">{t("workspaceDescriptionHint")}</span>
            </span>
            <textarea className="text-field" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <div className="dialog-actions">
            <button className="primary-button" disabled={!changed || !name.trim()}>
              {t("save")}
            </button>
          </div>
        </form>
      </section>
      <section className="settings-rows">
        <Row label={t("startView")} hint={t("startViewHint")}>
          <Select
            value={team.defaultCollectionId ?? ""}
            options={[["", t("home")], ...workspace.collections.map((c): [string, string] => [c.id, c.name])]}
            onChange={(v) => void save({ defaultCollectionId: v || null })}
          />
        </Row>
        <Row label={t("separateEditing")} hint={t("separateEditingHint")}>
          <Switch checked={!pref<boolean>("seamlessEdit")} onChange={(on) => void savePref("seamlessEdit", !on)} />
        </Row>
        <Row label={t("tocPosition")}>
          <Select
            value={pref<string>("tocPosition")}
            options={[
              ["left", t("tocLeft")],
              ["right", t("tocRight")],
            ]}
            onChange={(v) => void savePref("tocPosition", v)}
          />
        </Row>
      </section>
    </>
  );
}

export function SecurityPage() {
  const { t } = useSettings();
  const { team, pref, save, savePref } = useTeamSaver();
  const [domains, setDomains] = useState((team.allowedDomains ?? []).join("\n"));
  const domainList = domains
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  const domainsChanged = domainList.join() !== (team.allowedDomains ?? []).join();

  const toggle = (key: keyof Team, label: Parameters<typeof t>[0], hint: Parameters<typeof t>[0]) => (
    <Row label={t(label)} hint={t(hint)}>
      <Switch checked={!!team[key]} onChange={(on) => void save({ [key]: on })} />
    </Row>
  );
  const prefToggle = (key: string, label: Parameters<typeof t>[0], hint: Parameters<typeof t>[0]) => (
    <Row label={t(label)} hint={t(hint)}>
      <Switch checked={!!pref<boolean>(key)} onChange={(on) => void savePref(key, on)} />
    </Row>
  );

  return (
    <>
      <PageHeader title={t("security")} hint={t("securityHint")} />
      <section className="settings-rows">
        <h3>{t("sAccess")}</h3>
        {prefToggle("membersCanInvite", "sMembersCanInvite", "sMembersCanInviteHint")}
        {toggle("inviteRequired", "sInviteRequired", "sInviteRequiredHint")}
        {!team.inviteRequired && (
          <Row label={t("sDefaultRole")} hint={t("sDefaultRoleHint")}>
            <Select<UserRole>
              value={team.defaultUserRole ?? "member"}
              options={[
                ["member", t("roleMember")],
                ["viewer", t("roleViewer")],
                ["guest", t("roleGuest")],
              ]}
              onChange={(v) => void save({ defaultUserRole: v })}
            />
          </Row>
        )}
        <form
          className="settings-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save({ allowedDomains: domainList });
          }}
        >
          <label>
            <span>
              {t("sAllowedDomains")}
              <span className="settings-hint">{t("sAllowedDomainsHint")}</span>
            </span>
            <textarea className="text-field" rows={3} placeholder="example.com" value={domains} onChange={(e) => setDomains(e.target.value)} />
          </label>
          {domainsChanged && (
            <div className="dialog-actions">
              <button className="primary-button">{t("save")}</button>
            </div>
          )}
        </form>
      </section>
      <section className="settings-rows">
        <h3>{t("sBehavior")}</h3>
        {toggle("sharing", "sSharing", "sSharingHint")}
        {prefToggle("viewersCanExport", "sViewersExport", "sViewersExportHint")}
        {prefToggle("membersCanDeleteAccount", "sDeleteAccount", "sDeleteAccountHint")}
        <Row label={t("sEmailDisplay")} hint={t("sEmailDisplayHint")}>
          <Select
            value={pref<string>("emailDisplay")}
            options={[
              ["none", t("emailNone")],
              ["members", t("emailMembers")],
              ["everyone", t("emailEveryone")],
            ]}
            onChange={(v) => void savePref("emailDisplay", v)}
          />
        </Row>
        <Row label={t("sCommenting")} hint={t("sCommentingHint")}>
          <Select
            value={pref<string>("commenting")}
            options={[
              ["none", t("commentNone")],
              ["members", t("commentMembers")],
              ["everyone", t("commentEveryone")],
            ]}
            onChange={(v) => void savePref("commenting", v)}
          />
        </Row>
        {prefToggle("personalDocs", "sPersonalDocs", "sPersonalDocsHint")}
        {toggle("memberCollectionCreate", "sCollectionCreate", "sCollectionCreateHint")}
        {toggle("documentEmbeds", "sEmbeds", "sEmbedsHint")}
      </section>
    </>
  );
}

const formatTitle = (format: string) => EXPORT_FORMATS.find((f) => f.value === format)?.title ?? format;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

const inProgress = (op: FileOperation) => op.state === "creating" || op.state === "uploading";

/** Exports the whole workspace, and lists recent exports to download. */
export function ExportPage() {
  const { t, f } = useSettings();
  const { me, flash, onError } = usePage();
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<FileOperation | null>(null);
  const { data: exports, reload } = useLoad(listExports, []);

  // Follow exports being built.
  useEffect(() => {
    if (!exports?.some(inProgress)) return;
    const id = setTimeout(reload, 2500);
    return () => clearTimeout(id);
  }, [exports, reload]);

  const stateLabel = (op: FileOperation) =>
    op.state === "complete" ? formatSize(op.size) : op.state === "error" ? t("exportFailed") : op.state === "expired" ? t("exportExpired") : t("exporting");

  return (
    <>
      <PageHeader title={t("exportTitle")} hint={t("exportWorkspaceHint")} />
      <ExportForm
        canIncludePrivate={me.role === "admin"}
        busy={busy}
        onExport={async (format, attachments, includePrivate) => {
          setBusy(true);
          try {
            await startExport({ includePrivate }, format, attachments, { flash, onError, t });
            reload();
          } catch (e) {
            onError(e);
          } finally {
            setBusy(false);
          }
        }}
      />
      <section className="settings-rows">
        <h3>{t("recentExports")}</h3>
        {!exports ? (
          <Loading />
        ) : exports.length === 0 ? (
          <Empty>{t("noExports")}</Empty>
        ) : (
          <div className="settings-list">
            {exports.map((op) => (
              <div key={op.id} className={`settings-item${op.state === "expired" || op.state === "error" ? " faded" : ""}`}>
                <Upload size={16} />
                <div className="settings-item-text">
                  <span className="settings-item-title">{op.name || t("wholeWorkspace")}</span>
                  <span className="settings-hint" title={op.error ?? undefined}>
                    {[formatTitle(op.format), stateLabel(op), op.user?.name, f.relative(op.createdAt)].filter(Boolean).join(" · ")}
                  </span>
                </div>
                {op.state === "complete" && (
                  <button className="text-button" onClick={() => void downloadExport(op).catch(onError)}>
                    {t("download")}
                  </button>
                )}
                <button className="icon-button small danger" title={t("delete")} disabled={inProgress(op)} onClick={() => setDeleting(op)}>
                  <Trash size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
      {deleting && (
        <ConfirmDialog
          title={t("deleteExport")}
          message={t("deleteExportMessage", { name: deleting.name || t("wholeWorkspace") })}
          confirm={t("delete")}
          danger
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              await deleteFileOperation(deleting.id);
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
