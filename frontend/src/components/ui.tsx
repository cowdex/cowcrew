import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import type { FeatureSummary, StageState } from '../api/types';
import { FILL, ST, STATE_WORD, STAGES, TAB_STAGE_INDEX, type FeatureTab } from '../lib/status';
import { dismissToast, subscribeToasts, type Toast } from '../lib/toast';

export function Dot({ color, size = 6, style }: { color: string; size?: number; style?: CSSProperties }) {
  return <span className="dot" style={{ width: size, height: size, background: color, ...style }} aria-hidden="true" />;
}

export function Chip({ kind, children, lg }: { kind: StageState; children: ReactNode; lg?: boolean }) {
  const [dot, text, bg] = ST[kind];
  return (
    <span className={'chip' + (lg ? ' lg' : '')} style={{ background: bg, color: kind === 'run' ? text : '#171321' }}>
      <Dot color={dot} />
      {children}
    </span>
  );
}

/** Five-segment progress bar (Plan · Build · Verify · CI · Merge). */
export function StageBar({ stages, height = 6 }: { stages: StageState[]; height?: number }) {
  const label = stages.map((s, i) => `${STAGES[i]} ${STATE_WORD[s]}`).join(', ');
  return (
    <span role="img" aria-label={`Progress: ${label}`} style={{ display: 'flex', gap: 3 }}>
      {stages.map((s, i) => (
        <span key={i} style={{ flex: 1, height, borderRadius: 2, background: FILL[s] }} />
      ))}
    </span>
  );
}

export function NumBox({ n, color, size }: { n: ReactNode; color: string; size?: 'sm' | 'md' }) {
  return (
    <span className={'numbox' + (size ? ' ' + size : '')} style={{ borderColor: color }} aria-hidden="true">
      {n}
    </span>
  );
}

export function SectionLabel({ children, as = 'h2', id, style }: { children: ReactNode; as?: 'h2' | 'span'; id?: string; style?: CSSProperties }) {
  const El = as;
  return (
    <El id={id} className="label" style={style}>
      {children}
    </El>
  );
}

export function Modal({ title, children, onClose, labelledBy = 'modal-title' }: { title: string; children: ReactNode; onClose: () => void; labelledBy?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('textarea, input, button');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={labelledBy} ref={ref}>
        <h2 id={labelledBy}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function Toasts() {
  const [list, setList] = useState<Toast[]>([]);
  useEffect(() => subscribeToasts(setList), []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={'toast ' + t.kind}>
          <Dot color={t.kind === 'error' ? '#E24329' : t.kind === 'success' ? '#10B1B1' : '#7759C2'} size={8} style={{ marginTop: 6 }} />
          <span>
            <span className="sr-only">{t.kind === 'error' ? 'Error: ' : ''}</span>
            {t.text}
          </span>
          <button type="button" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

const TABS: { key: FeatureTab; label: string }[] = [
  { key: 'plan', label: 'Plan' },
  { key: 'live', label: 'Live' },
  { key: 'review', label: 'Review' },
  { key: 'ci', label: 'CI' },
  { key: 'merge', label: 'Merge' },
];

/** Plan · Live · Review · CI · Merge for one feature, each with its stage state dot. */
export function FeatureTabs({ feature }: { feature: Pick<FeatureSummary, 'id' | 'stages'> }) {
  return (
    <nav aria-label="Feature pages" className="ftabs">
      {TABS.map((t) => {
        const st = feature.stages[TAB_STAGE_INDEX[t.key]] ?? 'pend';
        return (
          <NavLink key={t.key} to={`/features/${feature.id}/${t.key}`} end>
            <Dot color={FILL[st] === '#E3E2E6' ? '#A2A1A6' : FILL[st]} />
            {t.label}
            <span className="sr-only"> ({STATE_WORD[st]})</span>
          </NavLink>
        );
      })}
    </nav>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <span className="sr-only">{label}…</span>
      <div className="skeleton" style={{ height: 70, width: '45%' }} />
      <div className="skeleton" style={{ height: 220 }} />
      <div className="row">
        <div className="skeleton" style={{ height: 300, flex: '999 1 540px' }} />
        <div className="skeleton" style={{ height: 300, flex: '1 1 330px' }} />
      </div>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="card empty" role="alert">
      <Chip kind="fail">Could not load</Chip>
      <span>{message}</span>
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyCard({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="card empty">
      <span style={{ fontSize: 16, fontWeight: 600, color: '#171321' }}>{title}</span>
      {children && <span style={{ maxWidth: 520, lineHeight: 1.55 }}>{children}</span>}
      {action}
    </div>
  );
}

export function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  const external = /^https?:/.test(href);
  if (external)
    return (
      <a className="pill-link" href={href} target="_blank" rel="noreferrer">
        {children}
        <ExternalSvg />
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  return (
    <Link className="pill-link" to={href}>
      {children}
      <ExternalSvg />
    </Link>
  );
}

function ExternalSvg() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </svg>
  );
}

/** Page header used by feature pages: eyebrow, title + chip, meta line, tab strip. */
export function FeatureHeader({
  eyebrow,
  eyebrowColor,
  title,
  chip,
  meta,
  feature,
  actions,
}: {
  eyebrow: string;
  eyebrowColor: string;
  title: string;
  chip: ReactNode;
  meta?: ReactNode;
  feature: Pick<FeatureSummary, 'id' | 'stages'>;
  actions?: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14 }}>
          <span className="mono" style={{ fontSize: 12, color: eyebrowColor }}>
            {eyebrow}
          </span>
          <FeatureTabs feature={feature} />
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14 }}>
          <h1 className="title">{title}</h1>
          {chip}
        </div>
        {meta}
      </div>
      {actions && <div style={{ display: 'flex', gap: 10 }}>{actions}</div>}
    </div>
  );
}

export function MetaLine({ children }: { children: ReactNode }) {
  return (
    <div className="mono" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 18, fontSize: 12, color: '#74717A' }}>
      {children}
    </div>
  );
}
