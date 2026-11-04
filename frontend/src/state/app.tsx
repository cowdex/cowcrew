import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import { onWs, startWs } from '../api/ws';
import type { Event, Overview, Project, Settings } from '../api/types';

const NOTIFY_KINDS: Event['kind'][] = ['gate', 'error'];
const PROJECT_KEY = 'cowcrew.project';

export interface Crumb {
  label: string;
  to?: string;
}

interface AppState {
  projects: Project[] | null;
  projectId: number | null;
  project: Project | null;
  setProjectId: (id: number) => void;
  reloadProjects: () => Promise<void>;
  settings: Settings | null;
  setSettings: (s: Settings) => void;
  overview: Overview | null;
  overviewAt: number;
  reloadOverview: () => void;
  notifications: Event[];
  unread: number;
  markRead: () => void;
  connected: boolean;
  crumbs: Crumb[];
  setCrumbs: (c: Crumb[]) => void;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside provider');
  return v;
}

/** Set the top-bar breadcrumb for the current page. */
export function useCrumbs(crumbs: Crumb[]) {
  const { setCrumbs } = useApp();
  const key = JSON.stringify(crumbs);
  useEffect(() => {
    setCrumbs(JSON.parse(key) as Crumb[]);
  }, [key, setCrumbs]);
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectId, setProjectIdState] = useState<number | null>(() => {
    const v = Number(localStorage.getItem(PROJECT_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  });
  const [settings, setSettings] = useState<Settings | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewAt, setOverviewAt] = useState(0);
  const [notifications, setNotifications] = useState<Event[]>([]);
  const [readUpTo, setReadUpTo] = useState<number>(() => Number(localStorage.getItem('cowcrew.readUpTo')) || 0);
  const [connected, setConnected] = useState(false);
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);

  const reloadProjects = useCallback(async () => {
    try {
      const list = await api.projects();
      setProjects(list);
    } catch {
      setProjects((p) => p ?? []);
    }
  }, []);

  useEffect(() => {
    reloadProjects();
    api.settings().then(setSettings, () => undefined);
  }, [reloadProjects]);

  // keep the selected project valid
  useEffect(() => {
    if (!projects) return;
    if (projects.length === 0) {
      if (projectId !== null) setProjectIdState(null);
    } else if (!projects.some((p) => p.id === projectId)) {
      setProjectIdState(projects[0].id);
    }
  }, [projects, projectId]);

  const setProjectId = useCallback((id: number) => {
    localStorage.setItem(PROJECT_KEY, String(id));
    setProjectIdState(id);
  }, []);

  const ovSeq = useRef(0);
  const reloadOverview = useCallback(() => {
    if (!projects) return;
    const seq = ++ovSeq.current;
    api.overview(projectId, { silent: overview !== null }).then(
      (o) => {
        if (seq !== ovSeq.current) return;
        setOverview(o);
        setOverviewAt(Date.now());
        setNotifications((prev) => mergeEvents(prev, o.activity.filter((e) => NOTIFY_KINDS.includes(e.kind))));
      },
      () => undefined,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, projectId]);

  useEffect(() => {
    reloadOverview();
  }, [reloadOverview]);

  // WebSocket: notifications + debounced overview refresh
  const timer = useRef<number>();
  useEffect(() => {
    const stop = startWs(setConnected);
    const off = onWs((m) => {
      if (m.type === 'event' && NOTIFY_KINDS.includes(m.event.kind)) {
        setNotifications((prev) => mergeEvents(prev, [m.event]));
      }
      if (m.type === 'feature' || (m.type === 'event' && m.event.kind !== 'log' && m.event.kind !== 'tool')) {
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => reloadOverview(), 800);
      }
    });
    return () => {
      off();
      stop();
      window.clearTimeout(timer.current);
    };
  }, [reloadOverview]);

  const markRead = useCallback(() => {
    const max = notifications.reduce((a, e) => Math.max(a, e.id), 0);
    setReadUpTo(max);
    localStorage.setItem('cowcrew.readUpTo', String(max));
  }, [notifications]);

  const value = useMemo<AppState>(
    () => ({
      projects,
      projectId,
      project: projects?.find((p) => p.id === projectId) ?? null,
      setProjectId,
      reloadProjects,
      settings,
      setSettings,
      overview,
      overviewAt,
      reloadOverview,
      notifications,
      unread: notifications.filter((e) => e.id > readUpTo).length,
      markRead,
      connected,
      crumbs,
      setCrumbs,
    }),
    [projects, projectId, setProjectId, reloadProjects, settings, overview, overviewAt, reloadOverview, notifications, readUpTo, markRead, connected, crumbs],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function mergeEvents(prev: Event[], next: Event[]): Event[] {
  const map = new Map<number, Event>();
  [...prev, ...next].forEach((e) => map.set(e.id, e));
  return [...map.values()].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts) || b.id - a.id).slice(0, 20);
}
