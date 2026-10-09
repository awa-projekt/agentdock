import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

const ThemeMode = Schema.Literals(['light', 'dark']);
export type ThemeMode = typeof ThemeMode.Type;

const StoredFlag = Schema.Literals(['true', 'false']);

/**
 * How this person operates the instance: through the built-in assistant beside
 * every page, or through their own coding agent over MCP with the assistant
 * hidden.
 */
const WorkspaceMode = Schema.Literals(['assistant', 'external']);
export type WorkspaceMode = typeof WorkspaceMode.Type;

const THEME_KEY = 'agentdock-theme';
const SIDEBAR_KEY = 'agentdock-sidebar-collapsed';
const WORKSPACE_MODE_KEY = 'agentdock-workspace-mode';

const decodeThemeMode = Schema.decodeUnknownOption(ThemeMode);
const decodeStoredFlag = Schema.decodeUnknownOption(StoredFlag);
const decodeWorkspaceMode = Schema.decodeUnknownOption(WorkspaceMode);

const storedTheme = (): Option.Option<ThemeMode> => decodeThemeMode(window.localStorage.getItem(THEME_KEY));

const storedFlag = (key: string): Option.Option<boolean> =>
  Option.map(decodeStoredFlag(window.localStorage.getItem(key)), (flag) => flag === 'true');

const prefersDarkColorScheme = (): boolean => window.matchMedia('(prefers-color-scheme: dark)').matches;

const isNarrowViewport = (): boolean => window.matchMedia('(max-width: 768px)').matches;

const getInitialTheme = (): ThemeMode =>
  Option.getOrElse(storedTheme(), (): ThemeMode => (prefersDarkColorScheme() ? 'dark' : 'light'));

const getInitialSidebarCollapsed = (): boolean => Option.getOrElse(storedFlag(SIDEBAR_KEY), isNarrowViewport);

/** Persisted light/dark theme that also toggles the `dark` class on the document. */
export function useTheme(): readonly [ThemeMode, () => void] {
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    window.localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const toggleTheme = useCallback(() => setTheme((current) => (current === 'dark' ? 'light' : 'dark')), []);

  return [theme, toggleTheme];
}

/** Persisted boolean flag keyed by a stable storage key (e.g. a collapsible panel). */
export function usePersistedFlag(key: string, defaultValue: boolean): readonly [boolean, (next: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => Option.getOrElse(storedFlag(key), () => defaultValue));

  useEffect(() => {
    window.localStorage.setItem(key, String(value));
  }, [key, value]);

  return [value, setValue];
}

/** Persisted sidebar collapsed state. */
export function useSidebarCollapsed(): readonly [boolean, () => void] {
  const [collapsed, setCollapsed] = useState<boolean>(getInitialSidebarCollapsed);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_KEY, String(collapsed));
  }, [collapsed]);

  const toggleCollapsed = useCallback(() => setCollapsed((current) => !current), []);

  return [collapsed, toggleCollapsed];
}

const workspaceModeListeners = new Set<() => void>();

const subscribeWorkspaceMode = (listener: () => void) => {
  workspaceModeListeners.add(listener);
  return () => {
    workspaceModeListeners.delete(listener);
  };
};

const readWorkspaceMode = (): WorkspaceMode | null =>
  Option.getOrNull(decodeWorkspaceMode(window.localStorage.getItem(WORKSPACE_MODE_KEY)));

/** The persisted workspace mode, shared by every component that reads it; `null` until the person chooses. */
export function useWorkspaceMode(): readonly [WorkspaceMode | null, (mode: WorkspaceMode) => void] {
  const mode = useSyncExternalStore(subscribeWorkspaceMode, readWorkspaceMode);
  const setMode = useCallback((next: WorkspaceMode) => {
    window.localStorage.setItem(WORKSPACE_MODE_KEY, next);
    for (const listener of workspaceModeListeners) listener();
  }, []);
  return [mode, setMode];
}
