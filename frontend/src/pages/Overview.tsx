import { Link } from 'react-router-dom';
import type { Event, Overview, StageState } from '../api/types';
import { ACTIVITY_PATHS, IconPlus } from '../components/icons';
import { Chip, Dot, EmptyCard, Loading, StageBar } from '../components/ui';
import { duration, money, moneyShort, numberWord, plural, relTime } from '../lib/format';
import { AGENT_NAME, AGENT_STATE_KIND, AGENT_STATE_LABEL, FILL, STATE_WORD, featureChip, featureHref } from '../lib/status';
import { useApp, useCrumbs } from '../state/app';
import { useNow } from '../state/hooks';

const MONO = "'GitLab Mono', monospace";

export default function OverviewPage() {
  useCrumbs([{ label: 'Overview' }]);
  const { overview, projects, overviewAt } = useApp();
  const now = useNow(1000);

  if (projects && projects.length === 0) return <FirstRun />;
  if (!overview || !projects) return <Loading label="Loading overview" />;

  const o = overview;
  const ago = Math.max(0, Math.round((now - overviewAt) / 1000));
  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <h1 style={{ margin: 0, fontSize: 28, fontWeight: 700, letterSpacing: '-0.045em' }}>Factory overview</h1>
          <p style={{ margin: 0, fontSize: 14, color: '#74717A' }}>
            {plural(o.features.length, 'feature')} · {plural(projects.length, 'repository', 'repositories')} · updated {ago < 60 ? `${ago} s` : relTime(new Date(overviewAt).toISOString(), now)} ago
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <span className="pill-btn" style={{ height: 42, borderRadius: 10, border: '1px solid #D9D8DC', background: '#fff', cursor: 'default' }}>
            Last 7 days
          </span>
          <Link to="/new" className="btn btn-primary" style={{ paddingInline: 16 }}>
            <IconPlus />
            New feature spec
          </Link>
        </div>
      </div>

      <Hero o={o} />
      <Kpis o={o} />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'stretch' }}>
        <Board o={o} />
        <Spend o={o} />
      </div>

      {o.trends.length > 0 && <Trends o={o} />}
      <FeaturesTable o={o} />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
        <Agents o={o} />
        <Activity events={o.activity} now={now} />
      </div>
    </>
  );
}

function FirstRun() {
  return (
    <section
      aria-labelledby="first-h"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 24,
        padding: '40px 36px',
        borderRadius: 12,
        border: '1px solid #E4E3E7',
        background: HERO_BG,
      }}
    >
      <div style={{ flex: '1 1 380px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <span className="mono" style={{ fontSize: 13, color: '#45424D' }}>
          Welcome to CowCrew
        </span>
        <h1 id="first-h" style={{ margin: 0, fontSize: 40, fontWeight: 700, lineHeight: 1.05, letterSpacing: '-0.045em' }}>
          Point the factory at a repository to get started.
        </h1>
        <p style={{ margin: 0, fontSize: 18, lineHeight: 1.35, letterSpacing: '-0.02em', color: '#45424D' }}>
          Add a git repo on this computer. Then write a feature spec: the agents plan it, build it, test it and hand you a PR to merge.
        </p>
        <ol style={{ margin: '4px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {['Open Settings → Projects', 'Add the absolute path to your repo', 'Write your first feature spec'].map((s, i) => (
            <li key={s} style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 15 }}>
              <span className="numbox sm" style={{ borderColor: ['#FC6D26', '#E24329', '#A989F5'][i] }} aria-hidden="true">
                {i + 1}
              </span>
              {s}
            </li>
          ))}
        </ol>
        <div style={{ marginTop: 6 }}>
          <Link to="/settings#projects" className="btn btn-primary" style={{ minHeight: 44, borderRadius: 8 }}>
            Add a project
          </Link>
        </div>
      </div>
      <HeroArt />
    </section>
  );
}

const HERO_BG =
  'radial-gradient(55% 140% at 100% 0%, rgba(169,137,245,0.40), rgba(169,137,245,0) 62%), radial-gradient(45% 120% at 78% 100%, rgba(255,185,201,0.55), rgba(255,185,201,0) 62%), radial-gradient(35% 110% at 58% 0%, rgba(252,109,38,0.20), rgba(252,109,38,0) 62%), #FFFFFF';

function partOfDay(): string {
  const h = new Date().getHours();
  if (h < 5 || h >= 18) return "Tonight's factory run";
  if (h < 12) return "This morning's factory run";
  return "This afternoon's factory run";
}

function Hero({ o }: { o: Overview }) {
  const plans = o.features.filter((f) => f.status === 'awaiting_plan_approval');
  const questions = o.features.filter((f) => f.status === 'awaiting_answers');
  const merges = o.features.filter((f) => f.status === 'awaiting_merge');
  const gates = o.kpis.waiting_on_you;
  const moving = o.features.some((f) => !f.waiting_on_you && !['merged', 'stopped', 'failed'].includes(f.status));

  const parts: string[] = [];
  if (questions.length) parts.push(`${numberWord(questions.length)} ${questions.length === 1 ? 'spec has questions' : 'specs have questions'}`);
  if (plans.length) parts.push(`${numberWord(plans.length, parts.length > 0)} ${plans.length === 1 ? 'plan' : 'plans'} to approve`);
  if (merges.length) parts.push(`${numberWord(merges.length, parts.length > 0)} PR${merges.length === 1 ? '' : 's'} to merge`);

  const headline =
    gates > 0
      ? `${numberWord(gates)} ${gates === 1 ? 'gate is' : 'gates are'} waiting for you. ${moving ? 'Everything else is moving.' : 'Nothing else is running.'}`
      : moving
        ? 'Nothing needs you right now. The agents are on it.'
        : 'The factory is quiet. Write a spec to start a run.';
  const sub = gates > 0 ? `${parts.join(', ')}. The agents handle the loop in between.` : 'You will be pinged at the two gates: plan approval and merge.';

  const firstPlan = questions[0] ?? plans[0];
  return (
    <section
      aria-labelledby="hero-h"
      className="hero" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 24, borderRadius: 12, border: '1px solid #E4E3E7', background: HERO_BG }}
    >
      <div style={{ flex: '1 1 380px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <span className="mono" style={{ fontSize: 13, color: '#45424D' }}>
          {partOfDay()}
        </span>
        <h2 id="hero-h" style={{ margin: 0, fontSize: 40, fontWeight: 700, lineHeight: 1.05, letterSpacing: '-0.045em', color: '#171321' }}>
          {headline}
        </h2>
        <p style={{ margin: 0, fontSize: 18, lineHeight: 1.1, letterSpacing: '-0.02em', color: '#45424D' }}>{sub}</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 6 }}>
          {firstPlan ? (
            <Link to={`/features/${firstPlan.id}/plan`} className="btn btn-primary" style={{ minHeight: 44, borderRadius: 8 }}>
              {firstPlan.status === 'awaiting_answers' ? 'Answer the questions' : 'Review the plan'}
            </Link>
          ) : (
            <Link to="/new" className="btn btn-primary" style={{ minHeight: 44, borderRadius: 8 }}>
              Write a feature spec
            </Link>
          )}
          {merges.length > 0 ? (
            <Link to="/merge" className="btn btn-outline-dark" style={{ minHeight: 44, borderRadius: 8 }}>
              Open merge queue
            </Link>
          ) : (
            <Link to="/live" className="btn btn-outline-dark" style={{ minHeight: 44, borderRadius: 8 }}>
              Watch live runs
            </Link>
          )}
        </div>
      </div>
      <HeroArt />
    </section>
  );
}

function HeroArt() {
  return (
    <svg viewBox="0 0 460 240" aria-hidden="true" className="hero-art">
      <defs>
        <linearGradient id="speed" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#FC6D26" stopOpacity="0" />
          <stop offset="1" stopColor="#FC6D26" />
        </linearGradient>
      </defs>
      <path d="M0 86h34M8 104h26M16 122h18" stroke="url(#speed)" strokeWidth="2" strokeLinecap="round" />
      <rect x="56" y="56" width="140" height="112" fill="#CEB3EF" />
      <path d="M44 44h104a36 36 0 0 1 36 36v76H44z" fill="#FFFFFF" stroke="#171321" strokeWidth="2" />
      <path d="M44 66h140" stroke="#171321" strokeWidth="2" />
      <rect x="60" y="80" width="14" height="14" fill="#FC6D26" />
      <path d="M84 87h72" stroke="#171321" strokeWidth="2" strokeLinecap="round" />
      <rect x="60" y="104" width="14" height="14" fill="#FCA326" />
      <path d="M84 111h56" stroke="#171321" strokeWidth="2" strokeLinecap="round" />
      <rect x="60" y="128" width="14" height="14" fill="none" stroke="#171321" strokeWidth="2" />
      <path d="M84 135h64" stroke="#171321" strokeWidth="2" strokeLinecap="round" />
      <path d="M184 104C222 104 222 64 262 64" fill="none" stroke="#171321" strokeWidth="2" strokeDasharray="6 6" />
      <path d="M262 18h126a28 28 0 0 1 28 28v66H262z" fill="#FFFFFF" stroke="#171321" strokeWidth="2" />
      <rect x="374" y="0" width="34" height="34" fill="#7759C2" />
      <path d="M384 11l-5 6 5 6M398 11l5 6-5 6" fill="none" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M280 44h60M280 62h96M296 80h70M280 98h40" stroke="#171321" strokeWidth="2" strokeLinecap="round" />
      <path d="M430 70a52 52 0 0 1 0 104" fill="none" stroke="#7759C2" strokeWidth="2" strokeDasharray="6 6" />
      <path d="M424 168l6 6-8 3" fill="none" stroke="#7759C2" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M300 150h88a24 24 0 0 1 24 24v46H300z" fill="#FFFFFF" stroke="#171321" strokeWidth="2" />
      <circle cx="330" cy="186" r="16" fill="#6FDAC9" />
      <path d="M322 186l6 6 11-12" fill="none" stroke="#171321" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M356 180h38M356 196h26" stroke="#171321" strokeWidth="2" strokeLinecap="round" />
      <path d="M290 120a40 40 0 0 0 0 52" fill="none" stroke="#7759C2" strokeWidth="2" strokeDasharray="6 6" />
    </svg>
  );
}

function Kpis({ o }: { o: Overview }) {
  const k = o.kpis;
  const items = [
    { label: 'In flight', value: String(k.in_flight), unit: k.in_flight === 1 ? 'feature' : 'features', dot: '#7759C2' },
    { label: 'Waiting on you', value: String(k.waiting_on_you), unit: k.waiting_on_you === 1 ? 'gate' : 'gates', dot: '#FC6D26' },
    { label: 'Committed 7d', value: String(k.committed_7d), unit: k.committed_7d === 1 ? 'task' : 'tasks', dot: '#10B1B1' },
    { label: 'First-try pass', value: `${Math.round(k.first_try_pass_pct)}%`, unit: `${k.first_try_pass_num} of ${k.committed_7d}`, dot: '#10B1B1' },
    { label: 'CI failing', value: String(k.ci_failing), unit: k.ci_failing ? 'on-call fixing' : 'all green', dot: k.ci_failing ? '#E24329' : '#10B1B1' },
    { label: 'Spend 7d', value: moneyShort(k.spend_7d_usd), unit: `of ${moneyShort(k.budget_usd)}`, dot: '#A989F5' },
  ];
  return (
    <section aria-label="Key numbers" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
      {items.map((it) => (
        <div key={it.label} className="card" style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span className="label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Dot color={it.dot} size={7} />
            {it.label}
          </span>
          <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontFamily: MONO, fontSize: 30, fontWeight: 400, letterSpacing: '-0.03em', color: '#171321' }}>{it.value}</span>
            <span style={{ fontSize: 13, color: '#74717A' }}>{it.unit}</span>
          </span>
        </div>
      ))}
    </section>
  );
}

function Board({ o }: { o: Overview }) {
  const { connected } = useApp();
  const counts: Record<StageState, number> = { done: 0, run: 0, wait: 0, fail: 0, pend: 0 };
  o.board.forEach((r) => r.cells.forEach((c) => counts[c]++));
  const total = o.board.reduce((a, r) => a + r.cells.length, 0);
  const legend: [StageState, string][] = [
    ['done', 'Committed'],
    ['run', 'Running'],
    ['wait', 'Waiting on you'],
    ['fail', 'Failing'],
    ['pend', 'Pending'],
  ];
  return (
    <section aria-labelledby="board-h" className="card" style={{ flex: '999 1 560px', minWidth: 0, padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <h2 id="board-h" className="h2">
          Task board{' '}
          <span style={{ fontWeight: 400, color: '#74717A' }}>
            · {plural(total, 'task')} across {plural(o.board.length, 'feature')}
          </span>
        </h2>
        <span
          className="mono"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 24,
            padding: '0 10px',
            borderRadius: 999,
            border: `1px solid ${connected ? '#6FDAC9' : '#D9D8DC'}`,
            fontSize: 12,
            color: '#171321',
          }}
        >
          <Dot color={connected ? '#10B1B1' : '#A2A1A6'} />
          {connected ? 'Live' : 'Reconnecting'}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {o.board.length === 0 && <span className="muted" style={{ fontSize: 14 }}>No tasks yet. Approve a plan and its tasks show up here.</span>}
        {o.board.map((r) => (
          <div key={r.feature_id} className="board-row">
            <Link
              to={`/features/${r.feature_id}`}
              style={{ fontSize: 13, fontWeight: 500, color: '#171321', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textDecoration: 'none' }}
            >
              {r.title}
            </Link>
            <span className="board-cells" role="img" aria-label={`${r.cells.length} tasks: ${summarize(r.cells)}`}>
              {r.cells.map((c, i) => (
                <span key={i} style={{ width: 22, height: 22, borderRadius: 4, background: FILL[c] }} />
              ))}
            </span>
            <span className="mono" style={{ fontSize: 12, color: '#74717A' }}>
              {r.summary}
            </span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, paddingTop: 12, borderTop: '1px solid #EFEEF1', fontSize: 13, color: '#45424D' }}>
        {legend.map(([k, l]) => (
          <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            <span style={{ width: 11, height: 11, borderRadius: 3, background: FILL[k] }} />
            {l} <b>{counts[k]}</b>
          </span>
        ))}
      </div>
    </section>
  );
}

function summarize(cells: StageState[]): string {
  const c: Partial<Record<StageState, number>> = {};
  cells.forEach((x) => (c[x] = (c[x] ?? 0) + 1));
  return Object.entries(c)
    .map(([k, n]) => `${n} ${STATE_WORD[k as StageState]}`)
    .join(', ');
}

const MODEL_COLORS = ['#5943B6', '#A989F5', '#FC6D26', '#FCA326', '#7759C2', '#E24329'];

function Spend({ o }: { o: Overview }) {
  const s = o.spend;
  return (
    <section aria-labelledby="spend-h" className="card" style={{ flex: '1 1 320px', minWidth: 0, padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 id="spend-h" className="h2">
          Agent spend
        </h2>
        <Link to="/settings" style={{ fontSize: 13, fontWeight: 500 }}>
          Budget settings
        </Link>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontSize: 34, fontWeight: 700, letterSpacing: '-0.045em' }}>{money(s.total_usd)}</span>
        {s.wow_pct != null && (
          <span className="mono" style={{ fontSize: 12, color: '#171321' }}>
            {s.wow_pct >= 0 ? '+' : '−'}
            {Math.abs(s.wow_pct).toFixed(1)}% WoW
          </span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 3, height: 8, background: s.by_model.length ? undefined : '#F3F2F4' }} aria-hidden="true">
        {s.by_model.map((m, i) => (
          <span key={m.model} style={{ flex: Math.max(m.pct, 0.5), background: MODEL_COLORS[i % MODEL_COLORS.length] }} />
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 14 }}>
        {s.by_model.map((m, i) => (
          <div key={m.model} style={{ display: 'grid', gridTemplateColumns: '12px 1fr auto 44px', gap: 10, alignItems: 'center' }}>
            <span style={{ width: 10, height: 10, background: MODEL_COLORS[i % MODEL_COLORS.length] }} />
            <span>
              {m.model} <span style={{ color: '#74717A' }}>· {m.agents}</span>
            </span>
            <span className="mono">{money(m.usd)}</span>
            <span className="mono" style={{ fontSize: 12, color: '#74717A', textAlign: 'right' }}>
              {Math.round(m.pct)}%
            </span>
          </div>
        ))}
        {s.by_model.length === 0 && <span className="muted">No spend yet this week.</span>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, paddingTop: 14, borderTop: '1px solid #EFEEF1', marginTop: 'auto' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="label">Projected</span>
          <span style={{ fontSize: 20, fontWeight: 600 }}>{money(s.projected_usd)}</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="label">Budget</span>
          <span style={{ fontSize: 20, fontWeight: 600, color: '#171321' }}>{Math.round(s.budget_used_pct)}% used</span>
        </div>
      </div>
    </section>
  );
}

const TREND_STYLE = [
  { stroke: '#7759C2', fill: 'rgba(119,89,194,0.10)' },
  { stroke: '#A989F5', fill: 'rgba(169,137,245,0.16)' },
  { stroke: '#FC6D26', fill: 'rgba(252,109,38,0.12)' },
];

function sparkPaths(pts: number[]) {
  const w = 300,
    h = 64,
    n = Math.max(pts.length, 2);
  const xy = (pts.length ? pts : [0, 0]).map((v, i) => [(i / (n - 1)) * w, h - 6 - Math.min(1, Math.max(0, v)) * (h - 14)]);
  const line = 'M' + xy.map((p) => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' L');
  return { line, area: line + ' L300 64 L0 64 Z' };
}

function Trends({ o }: { o: Overview }) {
  return (
    <section aria-label="Trends" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
      {o.trends.map((t, i) => {
        const p = sparkPaths(t.points);
        const st = TREND_STYLE[i % TREND_STYLE.length];
        return (
          <div key={t.key} className="card" style={{ padding: '18px 18px 0', display: 'flex', flexDirection: 'column', gap: 6, overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span style={{ color: '#45424D' }}>{t.label}</span>
              <span className="mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#171321' }}>
                <span style={{ width: 8, height: 8, borderTopRightRadius: 3, background: t.good ? '#10B1B1' : '#E24329' }} aria-hidden="true" />
                {t.delta}
                <span className="sr-only">{t.good ? '(better)' : '(worse)'}</span>
              </span>
            </div>
            <span style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.045em' }}>{t.value}</span>
            <svg viewBox="0 0 300 64" preserveAspectRatio="none" role="img" aria-label={`${t.label} trend over 7 days`} style={{ width: '100%', height: 64, display: 'block' }}>
              <path d={p.area} fill={st.fill} />
              <path d={p.line} fill="none" stroke={st.stroke} strokeWidth="2" vectorEffect="non-scaling-stroke" />
            </svg>
          </div>
        );
      })}
    </section>
  );
}

const GRID = '2.2fr 2fr 0.6fr 0.8fr 0.7fr 1.1fr';

function FeaturesTable({ o }: { o: Overview }) {
  return (
    <section aria-labelledby="features-h" className="card" style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '16px 20px', borderBottom: '1px solid #E4E3E7' }}>
        <h2 id="features-h" className="h2">
          Features
        </h2>
        <span className="label">Plan · Build · Verify · CI · Merge</span>
      </div>
      {o.features.length === 0 ? (
        <EmptyCard title="No features yet" action={<Link className="btn btn-primary" to="/new">New feature spec</Link>}>
          Write a spec and the Product Architect will start grilling it.
        </EmptyCard>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: 940 }} role="table" aria-label="Features">
            <div
              role="row"
              className="mono"
              style={{ display: 'grid', gridTemplateColumns: GRID, gap: 16, padding: '10px 20px', background: '#FAFAFA', borderBottom: '1px solid #E4E3E7', fontSize: 12, color: '#74717A' }}
            >
              {['Feature', 'Progress', 'Tasks', 'Elapsed', 'Cost', 'Status'].map((h) => (
                <span key={h} role="columnheader">
                  {h}
                </span>
              ))}
            </div>
            {o.features.map((f) => {
              const c = featureChip(f);
              const branch = f.status === 'merged' ? `merged${f.pr_number ? ` · #${f.pr_number}` : ''}` : (f.branch ?? 'branch not created yet');
              return (
                <Link
                  key={f.id}
                  role="row"
                  to={featureHref(f)}
                  style={{ display: 'grid', gridTemplateColumns: GRID, gap: 16, alignItems: 'center', minHeight: 64, padding: '10px 20px', borderBottom: '1px solid #EFEEF1', color: '#171321', textDecoration: 'none' }}
                >
                  <span role="cell" style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>{f.title}</span>
                    <span className="mono" style={{ fontSize: 12, color: '#74717A' }}>
                      {branch}
                    </span>
                  </span>
                  <span role="cell" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <StageBar stages={f.stages} />
                    <span style={{ fontSize: 12, color: '#74717A' }}>{f.stage_text}</span>
                  </span>
                  <span role="cell" className="mono" style={{ fontSize: 13 }}>
                    {f.tasks_done}/{f.tasks_total}
                  </span>
                  <span role="cell" className="mono" style={{ fontSize: 13 }}>
                    {duration(f.elapsed_seconds)}
                  </span>
                  <span role="cell" className="mono" style={{ fontSize: 13 }}>
                    {money(f.cost_usd)}
                  </span>
                  <span role="cell">
                    <Chip kind={c.kind}>{c.label}</Chip>
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

function Agents({ o }: { o: Overview }) {
  const models = new Set(o.agents.map((a) => a.model)).size;
  const maxSpend = Math.max(0.01, ...o.agents.map((a) => a.spend_usd));
  return (
    <section aria-labelledby="agents-h" className="card" style={{ flex: '999 1 560px', minWidth: 0, padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h2 id="agents-h" className="h2">
          Agent team{' '}
          <span style={{ fontWeight: 400, color: '#74717A' }}>
            · {plural(o.agents.length, 'agent')} · {plural(models, 'model')}
          </span>
        </h2>
        <span style={{ fontSize: 12, color: '#74717A' }}>bars show context used</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 12 }}>
        {o.agents.map((a) => {
          const k = AGENT_STATE_KIND[a.state];
          const ctx = Math.round(a.context_pct);
          const spendPct = Math.round((a.spend_usd / maxSpend) * 100);
          return (
            <div key={a.key} className="card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{a.name}</span>
                <span className="label">{a.model}</span>
              </div>
              <Chip kind={k}>{AGENT_STATE_LABEL[a.state]}</Chip>
              <span style={{ fontSize: 13, lineHeight: 1.5, color: '#45424D', minHeight: 39 }}>
                {a.feature_id ? (
                  <Link to={`/features/${a.feature_id}/live`} style={{ color: '#45424D', textDecoration: 'none' }}>
                    {a.job}
                  </Link>
                ) : (
                  a.job
                )}
              </span>
              <Meter label="Context" pct={ctx} text={`${ctx}%`} color={ctx > 65 ? '#FC6D26' : '#7759C2'} />
              <Meter label="Spend" pct={spendPct} text={moneyShort(a.spend_usd)} color="#A989F5" />
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Meter({ label, pct, text, color }: { label: string; pct: number; text: string; color: string }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '64px 1fr 40px', gap: 8, alignItems: 'center' }}>
      <span className="label">{label}</span>
      <span role="meter" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} style={{ height: 5, borderRadius: 3, background: '#EFEEF1' }}>
        <span style={{ display: 'block', height: 5, borderRadius: 3, width: `${Math.min(100, pct)}%`, background: color }} />
      </span>
      <span className="mono" style={{ fontSize: 12, color: '#45424D', textAlign: 'right' }}>
        {text}
      </span>
    </div>
  );
}

function activityLook(e: Event): { icon: string; bg: string; color: string } {
  const verdict = String(e.data?.verdict ?? '').toUpperCase();
  if (e.kind === 'error') return { icon: ACTIVITY_PATHS.warn, bg: '#FCE4DF', color: '#171321' };
  if (e.kind === 'verdict' && (verdict === 'FAIL' || verdict === 'REJECT' || verdict === 'BLOCKERS')) return { icon: ACTIVITY_PATHS.x, bg: '#FCE4DF', color: '#171321' };
  if (e.kind === 'gate') return { icon: ACTIVITY_PATHS.list, bg: '#FDF1DD', color: '#171321' };
  if (/^merged/i.test(e.message)) return { icon: ACTIVITY_PATHS.merge, bg: '#C5F4EC', color: '#171321' };
  if (e.kind === 'verdict' && e.agent === 'pr_reviewer') return { icon: ACTIVITY_PATHS.eye, bg: '#F1ECFD', color: '#5943B6' };
  if (e.kind === 'verdict') return { icon: ACTIVITY_PATHS.check, bg: '#C5F4EC', color: '#171321' };
  if (e.kind === 'handoff') return { icon: ACTIVITY_PATHS.arrow, bg: '#F1ECFD', color: '#5943B6' };
  return { icon: ACTIVITY_PATHS.code, bg: '#F1ECFD', color: '#5943B6' };
}

function Activity({ events, now }: { events: Event[]; now: number }) {
  return (
    <section aria-labelledby="act-h" className="card" style={{ flex: '1 1 340px', minWidth: 0, padding: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 id="act-h" className="h2">
          Activity
        </h2>
        <Link to="/live" style={{ fontSize: 13, fontWeight: 500 }}>
          View all
        </Link>
      </div>
      {events.length === 0 && <span className="muted" style={{ fontSize: 14 }}>Nothing has happened yet.</span>}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {events.map((e) => {
          const look = activityLook(e);
          const detail = typeof e.data?.detail === 'string' ? ` · ${e.data.detail}` : '';
          return (
            <li key={e.id} style={{ display: 'grid', gridTemplateColumns: '34px 1fr auto', gap: 12, alignItems: 'start', padding: '10px 0' }}>
              <span aria-hidden="true" style={{ width: 34, height: 34, borderRadius: 8, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: look.bg, color: look.color }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d={look.icon} />
                </svg>
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                {e.feature_id ? (
                  <Link to={`/features/${e.feature_id}`} className="clamp2" title={e.message} style={{ fontSize: 14, color: '#171321', textDecoration: 'none' }}>
                    {e.message}
                  </Link>
                ) : (
                  <span style={{ fontSize: 14, color: '#171321' }}>{e.message}</span>
                )}
                <span style={{ fontSize: 12, color: '#74717A' }}>
                  {AGENT_NAME[e.agent]}
                  {detail}
                </span>
              </span>
              <span className="mono" style={{ fontSize: 12, color: '#74717A' }}>
                <span className="sr-only">ago: </span>
                {relTime(e.ts, now)}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
