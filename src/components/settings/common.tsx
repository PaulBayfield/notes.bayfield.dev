// Pieces shared by the settings pages.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { can, type Envelope, type Team, type User } from "../../lib/api";
import type { Route } from "../../lib/router";
import type { Workspace } from "../../lib/workspace";

export interface SettingsContextValue {
  me: User;
  team: Team;
  /** `auth.info`'s policies: what the signed-in user may do in the workspace. */
  policies: Envelope<unknown>;
  server: string;
  workspace: Workspace;
  setMe: (patch: Partial<User>) => void;
  setTeam: (team: Team) => void;
  flash: (message: string, action?: () => void, label?: string) => void;
  onError: (e: unknown) => void;
  /** Opens a page of the app (and closes the settings). */
  onNavigate: (route: Route) => void;
  onSignOut: () => void;
}

export const SettingsPageContext = createContext<SettingsContextValue | null>(null);

export function usePage(): SettingsContextValue & { teamCan: (ability: string) => boolean } {
  const value = useContext(SettingsPageContext);
  if (!value) throw new Error("usePage outside the settings");
  return { ...value, teamCan: (ability) => can(value.policies, value.team.id, ability) };
}

export function PageHeader({ title, hint, children }: { title: string; hint?: string; children?: ReactNode }) {
  return (
    <header className="settings-page-header">
      <div>
        <h2>{title}</h2>
        {hint && <p className="dialog-text">{hint}</p>}
      </div>
      {children}
    </header>
  );
}

/** A setting: its name and explanation on the left, the control on the right. */
export function Row({ label, hint, children, disabled }: { label: ReactNode; hint?: ReactNode; children: ReactNode; disabled?: boolean }) {
  return (
    <div className={`setting-row${disabled ? " disabled" : ""}`}>
      <div className="setting-text">
        <span>{label}</span>
        {hint && <span className="settings-hint">{hint}</span>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

export function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  return <input type="checkbox" className="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />;
}

export function Select<T extends string>({ value, options, onChange, disabled }: { value: T; options: [T, string][]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
      {options.map(([v, label]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
    </select>
  );
}

/** Loads something when a page opens; `reload` fetches it again. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; reload: () => void; setData: (d: T) => void } {
  const { onError } = usePage();
  const [data, setData] = useState<T | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = useCallback(() => {
    loadRef.current().then(setData, onError);
  }, [onError]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, deps);
  return { data, reload, setData };
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="muted settings-empty">{children}</p>;
}

export function Loading() {
  return <div className="skeleton-rows" />;
}
