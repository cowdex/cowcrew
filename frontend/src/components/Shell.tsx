import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../state/app';
import { AGENT_NAME, AGENT_STATE_KIND, ST, featureChip, featureHref } from '../lib/status';
import { relTime } from '../lib/format';
import { Chip, Dot, Toasts } from './ui';
import { IconBell, IconChevron, IconEye, IconGear, IconList, IconMerge, IconOverview, IconPulse, IconRefresh, IconSearch } from './icons';

function Sidebar() {
  const { overview } = useApp();
  const feats = overview?.features ?? [];
  const plans = feats.filter((f) => f.status === 'awaiting_answers' || f.status === 'awaiting_plan_approval').length;
  const merges = feats.filter((f) => f.status === 'awaiting_merge').length;
  const ciFail = overview?.kpis.ci_failing ?? 0;
  const loc = useLocation();
  const path = loc.pathname;
  // feature pages highlight their section
  const section = path.match(/^\/features\/\d+\/(plan|live|review|ci|merge)/)?.[1];
  const active = (key: string) =>
    section ? { plan: '/plans', live: '/live', review: '/reviews', ci: '/ci', merge: '/merge' }[section] === key : false;

  const items: { to: string; label: string; icon: ReactNode; badge?: number; badgeKind?: 'fail'; badgeLabel?: string }[] = [
    { to: '/', label: 'Overview', icon: <IconOverview /> },
    { to: '/plans', label: 'Plans', icon: <IconList />, badge: plans, badgeLabel: 'awaiting you' },
    { to: '/live', label: 'Live runs', icon: <IconPulse /> },
    { to: '/reviews', label: 'Reviews', icon: <IconEye /> },
    { to: '/ci', label: 'CI & On-Call', icon: <IconRefresh />, badge: ciFail, badgeKind: 'fail', badgeLabel: 'failing' },
    { to: '/merge', label: 'Merge queue', icon: <IconMerge />, badge: merges, badgeLabel: 'awaiting merge' },
  ];

  return (
    <nav aria-label="Main navigation" className="sidebar">
      <div className="sidebar-inner">
      <Link to="/" className="brand" aria-label="CowCrew home">
        <img src="/cowcrew-logo.png" alt="" width={42} height={42} />
        <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span className="brand-name">CowCrew</span>
          <span className="brand-sub">AI Software Factory</span>
        </span>
      </Link>
      <div className="nav-group">
        <span className="nav-title">Workflow</span>
        {items.map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            end={it.to === '/'}
            className="nav-link"
            aria-current={active(it.to) || (it.to === '/' ? path === '/' : path.startsWith(it.to)) ? 'page' : undefined}
          >
            {it.icon}
            <span className="grow">{it.label}</span>
            {it.badge ? (
              <span className={'nav-badge' + (it.badgeKind ? ' ' + it.badgeKind : '')}>
                {it.badge}
                <span className="sr-only"> {it.badgeLabel}</span>
              </span>
            ) : null}
          </NavLink>
        ))}
      </div>
      <div className="nav-group">
        <span className="nav-title">Agent team</span>
        {(overview?.agents ?? []).map((a) => {
          const k = AGENT_STATE_KIND[a.state];
          const content = (
            <>
              <Dot color={ST[k][0]} size={8} />
              <span className="name">{a.name}</span>
              <span className="state">{a.state}</span>
            </>
          );
          return a.feature_id ? (
            <Link key={a.key} to={`/features/${a.feature_id}/live`} className="agent-row" title={a.job}>
              {content}
            </Link>
          ) : (
            <div key={a.key} className="agent-row" title={a.job}>
              {content}
            </div>
          );
        })}
        {!overview && <span className="agent-row muted" style={{ fontSize: 13 }}>Loading…</span>}
      </div>
      <NavLink to="/settings" className="nav-link settings-link">
        <IconGear />
        <span>Settings</span>
      </NavLink>
      </div>
    </nav>
  );
}

function SearchBox() {
  const { overview } = useApp();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return [];
    return (overview?.features ?? []).filter((f) => f.title.toLowerCase().includes(term) || (f.branch ?? '').toLowerCase().includes(term)).slice(0, 8);
  }, [q, overview]);

  const go = (i: number) => {
    const f = results[i];
    if (!f) return;
    nav(featureHref(f));
    setQ('');
    setOpen(false);
    input.current?.blur();
  };

  return (
    <div className="search" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOpen(false)}>
      <label>
        <IconSearch />
        <span className="sr-only">Search features</span>
        <input
          ref={input}
          role="combobox"
          aria-expanded={open && q.trim() !== ''}
          aria-controls="search-results"
          aria-autocomplete="list"
          aria-activedescendant={open && results[active] ? `sr-${results[active].id}` : undefined}
          placeholder="Search features, tasks, logs…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, results.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter') {
              go(active);
            } else if (e.key === 'Escape') {
              setOpen(false);
              input.current?.blur();
            }
          }}
        />
        <kbd aria-hidden="true">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
      </label>
      {open && q.trim() !== '' && (
        <div className="popover" id="search-results" role="listbox" aria-label="Matching features">
          {results.length === 0 && <div className="popover-empty">No features match “{q}”</div>}
          {results.map((f, i) => {
            const c = featureChip(f);
            return (
              <button
                key={f.id}
                id={`sr-${f.id}`}
                type="button"
                role="option"
                aria-selected={i === active}
                data-active={i === active}
                className="popover-item"
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => go(i)}
                onMouseEnter={() => setActive(i)}
              >
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{f.title}</span>
                <Chip kind={c.kind}>{c.label}</Chip>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ProjectPicker() {
  const { projects, project, setProjectId } = useApp();
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className="pill-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Dot color={project ? '#10B1B1' : '#A2A1A6'} size={8} />
        {project ? `${project.name} · ${project.default_branch}` : projects ? 'No project' : 'Loading…'}
        <span className="sr-only"> — switch project</span>
        <IconChevron />
      </button>
      {open && (
        <div className="popover" role="menu" style={{ right: 0, minWidth: 260 }}>
          {(projects ?? []).map((p) => (
            <button
              key={p.id}
              type="button"
              role="menuitemradio"
              aria-checked={p.id === project?.id}
              className="popover-item"
              data-active={p.id === project?.id}
              onClick={() => {
                setProjectId(p.id);
                setOpen(false);
              }}
            >
              <Dot color={p.id === project?.id ? '#10B1B1' : '#A2A1A6'} size={8} />
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <span style={{ fontWeight: 600 }}>{p.name}</span>
                <span className="mono muted" style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.repo_path}</span>
              </span>
            </button>
          ))}
          <div style={{ borderTop: '1px solid #EFEEF1', margin: '4px 0' }} />
          <button
            type="button"
            role="menuitem"
            className="popover-item"
            onClick={() => {
              setOpen(false);
              nav('/settings#projects');
            }}
          >
            <span style={{ width: 8, textAlign: 'center' }} aria-hidden="true">
              +
            </span>
            Add project…
          </button>
        </div>
      )}
    </div>
  );
}

function Notifications() {
  const { notifications, unread, markRead } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    markRead();
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open, markRead]);
  const items = notifications.slice(0, 8);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className="icon-btn" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <IconBell />
        {unread > 0 && <span className="unread" aria-hidden="true" />}
      </button>
      {open && (
        <div className="popover" style={{ right: 0, width: 340 }} role="region" aria-label="Latest gates and errors">
          <span className="label" style={{ padding: '6px 10px' }}>
            Gates and errors
          </span>
          {items.length === 0 && <div className="popover-empty">Nothing needs you right now.</div>}
          {items.map((e) => (
            <Link
              key={e.id}
              to={e.feature_id ? notifHref(e.feature_id, e.kind, e.message) : '/'}
              className="popover-item"
              onClick={() => setOpen(false)}
              style={{ alignItems: 'flex-start' }}
            >
              <Dot color={e.kind === 'error' ? '#E24329' : '#FC6D26'} size={8} style={{ marginTop: 6 }} />
              <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span>{e.message}</span>
                <span className="muted" style={{ fontSize: 12 }}>
                  {e.kind === 'error' ? 'Error' : 'Gate'} · {AGENT_NAME[e.agent]}
                </span>
              </span>
              <span className="mono muted" style={{ fontSize: 12 }}>
                {relTime(e.ts)}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function notifHref(id: number, kind: string, msg: string): string {
  const m = msg.toLowerCase();
  if (kind === 'error') return m.includes('ci') ? `/features/${id}/ci` : `/features/${id}/live`;
  if (m.includes('merge') || m.includes('pr #')) return `/features/${id}/merge`;
  return `/features/${id}/plan`;
}

function Topbar() {
  const { crumbs } = useApp();
  return (
    <header className="topbar">
      <nav aria-label="Breadcrumb" style={{ flex: '1 1 200px' }}>
        <ol className="crumbs">
          <li>
            <Link to="/">Workflow</Link>
          </li>
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            return (
              <li key={i} style={{ display: 'inline-flex', gap: 4 }}>
                <span aria-hidden="true">›</span>
                {last ? <span aria-current="page">{c.label}</span> : c.to ? <Link to={c.to}>{c.label}</Link> : <span>{c.label}</span>}
              </li>
            );
          })}
        </ol>
      </nav>
      <SearchBox />
      <ProjectPicker />
      <Notifications />
      <span className="avatar" role="img" aria-label="Your account">
        You
      </span>
    </header>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { settings } = useApp();
  const loc = useLocation();
  useEffect(() => {
    if (!loc.hash) window.scrollTo(0, 0);
  }, [loc.pathname, loc.hash]);
  return (
    <div className="app">
      <a href="#main" className="sr-only">
        Skip to content
      </a>
      <Sidebar />
      <div className="main-col">
        {settings?.simulate && (
          <div className="sim-banner" role="note">
            <Dot color="#FCA326" size={8} />
            <span>
              Simulation mode — agents are simulated. Add an Anthropic API key to run real agents. <Link to="/settings">Settings</Link>
            </span>
          </div>
        )}
        <Topbar />
        <main id="main" className="page" tabIndex={-1}>
          {children}
        </main>
      </div>
      <Toasts />
    </div>
  );
}

