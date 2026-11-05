import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { onReconnect, onWs } from '../api/ws';
import type { ClaudeUsage, PlanLimit } from '../api/types';
import { Loading } from '../components/ui';
import { useApp, useCrumbs } from '../state/app';
import { toast } from '../lib/toast';

/** "Resets in 2 hr 14 min" (session) or "Resets Mon 1:18 AM" (weekly), like the Claude apps. */
function resetText(ts: number | null, now: number): string {
  if (!ts) return '';
  const s = Math.max(0, Math.round(ts - now / 1000));
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.max(1, Math.round((s % 3600) / 60));
    return h ? `Resets in ${h} hr ${m} min` : `Resets in ${m} min`;
  }
  return `Resets ${new Date(ts * 1000).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
}

function ago(ts: number | null, now: number): string {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round(now / 1000 - ts));
  if (s < 60) return 'less than a minute ago';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function LimitRow({ l, now }: { l: PlanLimit; now: number }) {
  const pct = Math.min(100, l.used_pct ?? 0);
  const color = l.status === 'rejected' || pct >= 100 ? '#E24329' : pct >= 80 ? '#FCA326' : '#5943B6';
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 220px) 1fr auto', gap: 18, alignItems: 'center', padding: '14px 0' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ fontSize: 15, fontWeight: 600 }}>{l.label}</span>
        <span style={{ fontSize: 13, color: '#74717A' }}>{l.status === 'rejected' ? 'Limit reached · ' : ''}{resetText(l.resets_at, now)}</span>
      </div>
      <div role="progressbar" aria-label={`${l.label} usage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} style={{ height: 10, borderRadius: 5, background: '#EFEEF1', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', borderRadius: 5, background: color, transition: 'width .4s' }} />
      </div>
      <span style={{ fontSize: 14, color: '#45424D', minWidth: 64, textAlign: 'right' }}>{l.used_pct == null ? '—' : `${Math.round(pct)}% used`}</span>
    </div>
  );
}

const SOURCE: Record<string, string> = {
  claude_code: 'from Claude Code',
  agent: 'from an agent run',
  refresh: 'from Refresh',
  simulated: 'simulated',
};

export default function UsagePage() {
  useCrumbs([{ label: 'Claude usage' }]);
  const { settings } = useApp();
  const [u, setU] = useState<ClaudeUsage | null>(null);
  const [busy, setBusy] = useState<'' | 'refresh' | 'connect'>('');
  const [now, setNow] = useState(Date.now());

  const load = useCallback(() => {
    api.claudeUsage().then(setU, () => undefined);
  }, []);
  useEffect(() => {
    load();
    const off = onWs((m) => {
      if (m.type === 'claude_usage' || (m.type === 'event' && m.event.kind === 'cost')) load();
    });
    const offRe = onReconnect(load);
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    const poll = window.setInterval(load, 60_000);
    return () => {
      off();
      offRe();
      window.clearInterval(tick);
      window.clearInterval(poll);
    };
  }, [load]);

  const refresh = async () => {
    setBusy('refresh');
    try {
      setU(await api.refreshClaudeUsage());
      setNow(Date.now());
    } catch {
      /* toast shown */
    } finally {
      setBusy('');
    }
  };
  const toggleStatusline = async () => {
    setBusy('connect');
    try {
      const next = u?.statusline_connected ? await api.disconnectStatusline() : await api.connectStatusline();
      setU(next);
      toast.success(next.statusline_connected ? 'Claude Code now sends your usage to CowCrew.' : 'Claude Code status line restored.');
    } catch {
      /* toast shown */
    } finally {
      setBusy('');
    }
  };

  if (settings && settings.billing !== 'subscription') {
    return (
      <section className="card" style={{ padding: 24, maxWidth: 760 }}>
        <h1 className="title" style={{ fontSize: 28 }}>
          Claude usage
        </h1>
        <p style={{ color: '#45424D' }}>
          Plan limits only exist when CowCrew runs on a Claude Pro, Max or Ultra login. With an API key, usage is billed per token: see Overview → Usage.
        </p>
      </section>
    );
  }
  if (!u) return <Loading />;

  const session = u.limits.filter((l) => l.kind === 'five_hour');
  const weekly = u.limits.filter((l) => l.kind.startsWith('seven_day'));
  const other = u.limits.filter((l) => l.kind !== 'five_hour' && !l.kind.startsWith('seven_day'));
  const latest = u.limits.reduce<PlanLimit | null>((a, l) => (!a || l.seen_at > a.seen_at ? l : a), null);
  const maxDay = Math.max(1, ...u.daily.map((d) => d.weekly_pct));
  const today = u.daily[u.daily.length - 1];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 860 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <h1 className="title" style={{ fontSize: 28 }}>
            Plan usage limits
          </h1>
          <p style={{ margin: 0, fontSize: 14, color: '#74717A' }}>Your Claude session and weekly limits, as Claude reports them. Same numbers as Settings → Usage in the Claude apps.</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 13, color: '#74717A' }}>
            Last updated: {ago(u.updated_at, now)}
            {latest?.source ? ` · ${SOURCE[latest.source] ?? latest.source}` : ''}
          </span>
          <button type="button" className="btn" onClick={() => void refresh()} disabled={busy !== ''}>
            {busy === 'refresh' ? 'Refreshing…' : 'Refresh now'}
          </button>
        </div>
      </div>

      {u.limits.length === 0 && (
        <section className="card" style={{ padding: 22, fontSize: 14, color: '#45424D' }}>
          No readings yet. Click <b>Refresh now</b>, connect Claude Code below, or run any feature.
        </section>
      )}

      {session.length > 0 && (
        <section className="card" style={{ padding: '10px 22px' }} aria-label="Current session">
          {session.map((l) => (
            <LimitRow key={l.kind} l={l} now={now} />
          ))}
        </section>
      )}

      {weekly.length > 0 && (
        <section className="card" style={{ padding: '18px 22px 8px' }} aria-labelledby="weekly-h">
          <h2 id="weekly-h" className="h2" style={{ margin: 0 }}>
            Weekly limits
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {weekly.map((l, i) => (
              <div key={l.kind} style={{ borderTop: i ? '1px solid #EFEEF1' : 0 }}>
                <LimitRow l={l} now={now} />
              </div>
            ))}
          </div>
        </section>
      )}

      {other.length > 0 && (
        <section className="card" style={{ padding: '10px 22px' }} aria-label="Other limits">
          {other.map((l) => (
            <LimitRow key={l.kind} l={l} now={now} />
          ))}
        </section>
      )}

      <section className="card" style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }} aria-labelledby="daily-h">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <h2 id="daily-h" className="h2" style={{ margin: 0 }}>
            Daily use of your weekly limit
          </h2>
          <span style={{ fontSize: 13, color: '#45424D' }}>
            Today: <b>{today ? `${today.weekly_pct}%` : '—'}</b> of the week
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${u.daily.length}, 1fr)`, gap: 10, alignItems: 'end', height: 150 }}>
          {u.daily.map((d, i) => (
            <div key={d.date} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, height: '100%', justifyContent: 'flex-end' }}>
              <span className="mono" style={{ fontSize: 11, color: '#45424D' }}>
                {d.weekly_pct ? `${d.weekly_pct}%` : ''}
              </span>
              <div
                title={`${d.date}: ${d.weekly_pct}% of the weekly limit`}
                style={{ width: '100%', maxWidth: 46, height: `${Math.max(2, (d.weekly_pct / maxDay) * 100)}%`, borderRadius: '6px 6px 2px 2px', background: i === u.daily.length - 1 ? '#FC6D26' : '#A989F5' }}
              />
              <span style={{ fontSize: 12, color: '#74717A' }}>{new Date(d.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short' })}</span>
            </div>
          ))}
        </div>
        <span style={{ fontSize: 12, color: '#74717A' }}>
          Claude has no daily limit. CowCrew works this out from its readings of your weekly meter, so a day only shows what was recorded while CowCrew was running.
        </span>
      </section>

      <section className="card" style={{ padding: 22, display: 'flex', gap: 18, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }} aria-labelledby="sync-h">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 560 }}>
          <h2 id="sync-h" className="h2" style={{ margin: 0 }}>
            Keep it in sync with Claude Code
          </h2>
          <span style={{ fontSize: 13, color: '#45424D', lineHeight: 1.5 }}>
            {u.statusline_connected
              ? 'Connected. Every time Claude Code replies, it sends your session and weekly numbers here. Your own status line, if you had one, still shows.'
              : 'Claude Code receives your session and weekly numbers after every reply. Connect it and CowCrew updates whenever you use Claude Code, not only when agents run. This adds a status-line command to ~/.claude/settings.json (a backup is kept) and you can undo it here.'}
          </span>
        </div>
        <button type="button" className={u.statusline_connected ? 'btn' : 'btn btn-primary'} onClick={() => void toggleStatusline()} disabled={busy !== ''}>
          {busy === 'connect' ? 'Working…' : u.statusline_connected ? 'Disconnect' : 'Connect Claude Code'}
        </button>
      </section>
      <p style={{ margin: 0, fontSize: 12, color: '#74717A' }}>
        Refresh now sends one tiny Haiku request so Claude reports fresh numbers; it uses a negligible amount of your plan. Usage on claude.ai and the desktop app is included in these numbers, but CowCrew only sees updates when Claude Code, an agent or Refresh asks for them.
      </p>
    </div>
  );
}
