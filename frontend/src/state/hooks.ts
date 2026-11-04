import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { onWs } from '../api/ws';
import type { Event, FeatureDetail, FeatureSummary } from '../api/types';
import { useApp } from './app';

const REFRESH_KINDS: Event['kind'][] = ['status', 'handoff', 'verdict', 'gate', 'error'];

/** Feature detail with debounced refetch on relevant WebSocket messages. */
export function useFeatureDetail(id: number) {
  const [detail, setDetail] = useState<FeatureDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number>();
  const seq = useRef(0);

  const reload = useCallback(
    (silent = true) => {
      const s = ++seq.current;
      return api.feature(id, { silent }).then(
        (d) => {
          if (s === seq.current) {
            setDetail(d);
            setError(null);
          }
          return d;
        },
        (e: Error) => {
          if (s === seq.current) setError(e.message);
          return null;
        },
      );
    },
    [id],
  );

  useEffect(() => {
    setDetail(null);
    setError(null);
    reload(false);
  }, [reload]);

  useEffect(() => {
    const schedule = () => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => reload(), 400);
    };
    const off = onWs((m) => {
      if (m.type === 'feature' && m.feature.id === id) {
        // patch the summary immediately, then refetch the full detail
        setDetail((d) => (d ? { ...d, feature: { ...d.feature, ...m.feature } } : d));
        schedule();
      } else if (m.type === 'event' && m.event.feature_id === id && REFRESH_KINDS.includes(m.event.kind)) {
        schedule();
      }
    });
    return () => {
      off();
      window.clearTimeout(timer.current);
    };
  }, [id, reload]);

  return { detail, error, reload, setDetail };
}

/** Feature events, newest first: initial page from REST, then live appends from the WebSocket. */
export function useFeatureEvents(id: number, limit = 200) {
  const [events, setEvents] = useState<Event[] | null>(null);
  useEffect(() => {
    let alive = true;
    setEvents(null);
    api.events(id, { limit }, { silent: true }).then(
      (list) => {
        if (!alive) return;
        setEvents((cur) => merge(list, cur ?? []));
      },
      () => alive && setEvents((cur) => cur ?? []),
    );
    const off = onWs((m) => {
      if (m.type === 'event' && m.event.feature_id === id) setEvents((cur) => merge([m.event], cur ?? []));
    });
    return () => {
      alive = false;
      off();
    };
  }, [id, limit]);
  return events;
}

function merge(a: Event[], b: Event[]): Event[] {
  const map = new Map<number, Event>();
  [...b, ...a].forEach((e) => map.set(e.id, e));
  return [...map.values()].sort((x, y) => Date.parse(y.ts) - Date.parse(x.ts) || y.id - x.id).slice(0, 500);
}

/** Features of the current project, refreshed on WebSocket feature messages. */
export function useFeatures(status?: string) {
  const { projectId, projects } = useApp();
  const [list, setList] = useState<FeatureSummary[] | null>(null);
  const timer = useRef<number>();
  const load = useCallback(() => {
    if (!projects) return;
    api.features({ project_id: projectId, status }).then(setList, () => setList((l) => l ?? []));
  }, [projectId, projects, status]);
  useEffect(() => {
    load();
    const off = onWs((m) => {
      if (m.type === 'feature') {
        setList((l) => (l ? l.map((f) => (f.id === m.feature.id ? m.feature : f)) : l));
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(load, 600);
      }
    });
    return () => {
      off();
      window.clearTimeout(timer.current);
    };
  }, [load]);
  return list;
}

/** Re-render every `ms` so relative times stay fresh. */
export function useNow(ms = 10000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}
