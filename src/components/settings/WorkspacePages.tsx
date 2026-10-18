import { useState } from "react";
import { chooseAndUploadImage, updateTeam, type Team, type UserRole } from "../../lib/api";
import { useSettings } from "../../lib/settings";
import { Avatar } from "../Avatar";
import { PageHeader, Row, Select, Switch, usePage } from "./common";

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
