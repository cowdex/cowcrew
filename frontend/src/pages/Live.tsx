import { useMemo, useRef, useState, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { AgentKey, Event, FeatureDetail, Task } from '../api/types';
import { Chip, Dot, ErrorState, FeatureHeader, Loading, MetaLine, Modal } from '../components/ui';
import { clock, compactNum, duration, minus, money, pad3, plural } from '../lib/format';
import { AGENT_NAME, AGENT_SHORT, featureChip } from '../lib/status';
import { toast } from '../lib/toast';
import { useApp, useTokensMode } from '../state/app';
import { useFeatureEvents } from '../state/hooks';
import { useAction, useFeaturePage } from './shared';

type NState = 'done' | 'run' | 'fail' | 'wait' | 'todo';
type NodeKey = 'pa1' | 'swe' | 'tst' | 'pa2' | 'rev' | 'onc' | 'you';
const NC: Record<NState, string> = { done: '#10B1B1', run: '#7759C2', fail: '#E24329', wait: '#FC6D26', todo: '#A2A1A6' };
const NODE_AGENT: Record<NodeKey, AgentKey> = {
  pa1: 'product_architect',
  swe: 'software_engineer',
  tst: 'tester',
  pa2: 'product_architect',
  rev: 'pr_reviewer',
  onc: 'oncall_engineer',
  you: 'human',
};

interface NodeInfo {
  key: NodeKey;
  name: string;
  model: string;
  state: NState;
  sub: string;
  text: string;
  metrics: [string, string][];
}

/** CI can report several workflow runs for one commit ("123,456"): show the first, then a count. */
function runLabel(runId: string): string {
  const ids = runId.split(',').map((x) => x.trim()).filter(Boolean);
  if (ids.length === 0) return '—';
  return ids.length === 1 ? `#${ids[0]}` : `#${ids[0]} +${ids.length - 1}`;
}

export default function LivePage() {
  const { id, detail, error, reload, setDetail } = useFeaturePage({ label: 'Live runs', to: '/live' });
  const events = useFeatureEvents(id);
  if (error && !detail) return <ErrorState message={error} onRetry={() => reload(false)} />;
  if (!detail) return <Loading label="Loading live run" />;
  return <LiveView d={detail} events={events ?? []} eventsLoading={events === null} setDetail={setDetail} />;
}

function verdictOf(e: Event): string {
  return String(e.data?.verdict ?? '').toUpperCase();
}

function LiveView({ d, events, eventsLoading, setDetail }: { d: FeatureDetail; events: Event[]; eventsLoading: boolean; setDetail: (d: FeatureDetail) => void }) {
  const f = d.feature;
  const { settings } = useApp();
  const tk = useTokensMode();
  const maxAttempts = settings?.max_attempts ?? 4;
  const models = settings?.models;
  const [sel, setSel] = useState<NodeKey | null>(null);
  const [filter, setFilter] = useState<AgentKey | 'all'>('all');
  const [confirmStop, setConfirmStop] = useState(false);
  const [msgFor, setMsgFor] = useState<AgentKey | null>(null);
  const logRef = useRef<HTMLElement>(null);
  const { busy, run } = useAction(setDetail);

  const current = d.tasks.find((t) => t.id === f.current_task_id) ?? d.tasks.find((t) => t.status === 'running' || t.status === 'testing') ?? null;
  const paused = f.status === 'paused' || f.paused;
  const terminal = ['merged', 'stopped', 'failed'].includes(f.status);

  const spendOf = (a: AgentKey) => d.spend_by_agent.filter((s) => s.agent === a).reduce((x, s) => x + (tk ? s.tokens ?? 0 : s.cost_usd), 0);
  const spendLabel = tk ? 'Tokens' : 'Spend';
  const fmtSpend = (n: number) => (tk ? compactNum(n) : money(n));
  const modelOf = (a: AgentKey) =>
    d.spend_by_agent.find((s) => s.agent === a)?.model ?? (models && a in models ? models[a as keyof typeof models] : a === 'human' ? 'human' : '—');
  const byAgent = (a: AgentKey) => events.filter((e) => e.agent === a);
  const latest = (a: AgentKey) => byAgent(a)[0];

  const nodes = useMemo<Record<NodeKey, NodeInfo>>(() => {
    const st = f.stages;
    const pauseIt = (s: NState): NState => (paused && s === 'run' ? 'wait' : s);
    const fromStage = (s: (typeof st)[number]): NState => (s === 'pend' ? 'todo' : s === 'run' ? 'run' : s);
    const curEvents = current ? events.filter((e) => e.task_id === current.id) : [];
    const lastTesterVerdict = curEvents.find((e) => e.agent === 'tester' && e.kind === 'verdict');
    const testerVerdicts = byAgent('tester').filter((e) => e.kind === 'verdict');
    const toolCount = (a: AgentKey) => byAgent(a).filter((e) => e.kind === 'tool').length;

    // build loop
    let swe: NState = 'todo';
    let tst: NState = 'todo';
    if (st[1] === 'done') {
      swe = 'done';
      tst = 'done';
    } else if (st[1] !== 'pend') {
      if (current?.status === 'testing') {
        swe = 'done';
        tst = 'run';
      } else if (current) {
        swe = 'run';
        tst = lastTesterVerdict && verdictOf(lastTesterVerdict) === 'FAIL' ? 'fail' : 'todo';
      } else swe = fromStage(st[1]);
    }
    const acc = d.acceptance;
    const pa2: NState = f.status === 'accepting' ? 'run' : acc ? (acc.verdict === 'ACCEPT' ? 'done' : 'fail') : 'todo';
    const openBlockers = d.findings.filter((x) => x.severity === 'Blocker' && x.status === 'open').length;
    const rounds = d.findings.reduce((m, x) => Math.max(m, x.round), 0);
    const rev: NState = f.status === 'reviewing' ? 'run' : st[2] === 'done' ? 'done' : openBlockers ? 'fail' : d.findings.length ? 'done' : 'todo';
    const lastRun = d.ci_runs[0];
    const onc: NState = st[3] === 'fail' ? 'run' : st[3] === 'run' ? 'run' : st[3] === 'done' ? 'done' : 'todo';
    const you: NState = st[4] === 'wait' ? 'wait' : st[4] === 'done' ? 'done' : 'todo';
    const pa1 = fromStage(st[0]);
    const lastVerdict = testerVerdicts[0] ? verdictOf(testerVerdicts[0]) : '—';

    const text = (a: AgentKey, fallback: string) => latest(a)?.message ?? fallback;
    const planTasks = d.tasks.filter((t) => t.kind === 'plan').length;

    return {
      pa1: {
        key: 'pa1', name: 'Product Architect', model: modelOf('product_architect'), state: pa1,
        sub: pa1 === 'done' ? 'grooming · done' : pa1 === 'wait' ? 'waiting on you' : pa1 === 'run' ? 'grooming' : 'plan',
        text: pa1 === 'done' ? `Turned your spec into ${plural(planTasks, 'task')}${f.adr ? ` and an ADR (${f.adr.title})` : ''}. You approved the plan.` : text('product_architect', 'Planning the feature.'),
        metrics: [['Tasks', String(planTasks)], ['ADRs', f.adr ? '1' : '0'], ['Questions', String(d.questions.length)], [spendLabel, fmtSpend(spendOf('product_architect'))]],
      },
      swe: {
        key: 'swe', name: 'Software Engineer', model: modelOf('software_engineer'), state: pauseIt(swe),
        sub: swe === 'run' && current ? `task ${pad3(current.seq)} · attempt ${Math.max(1, current.attempts)}` : swe === 'done' ? `${f.tasks_done} tasks committed` : 'build · later',
        text: text('software_engineer', 'Writes code and tests for one task at a time. Never commits on its own.'),
        metrics: [['Attempt', current ? `${Math.max(1, current.attempts)} / ${maxAttempts}` : '—'], ['Files', f.diff_stats ? String(f.diff_stats.files) : '—'], ['Tool calls', String(toolCount('software_engineer'))], [spendLabel, fmtSpend(spendOf('software_engineer'))]],
      },
      tst: {
        key: 'tst', name: 'Tester', model: modelOf('tester'), state: pauseIt(tst),
        sub: tst === 'fail' ? 'last check · fail' : tst === 'run' ? `checking task ${current ? pad3(current.seq) : ''}` : tst === 'done' ? 'all checks passed' : current ? 'next · re-check' : 'build · later',
        text: text('tester', 'Runs the suite plus adversarial checks and returns PASS or FAIL.'),
        metrics: [['Last verdict', lastVerdict], ['Checks', String(testerVerdicts.length)], ['Fails', String(testerVerdicts.filter((e) => verdictOf(e) === 'FAIL').length)], [spendLabel, fmtSpend(spendOf('tester'))]],
      },
      pa2: {
        key: 'pa2', name: 'Product Architect', model: modelOf('product_architect'), state: pauseIt(pa2),
        sub: pa2 === 'run' ? 'acceptance · checking' : pa2 === 'done' ? 'acceptance · accepted' : pa2 === 'fail' ? 'acceptance · rejected' : 'acceptance · later',
        text: acc?.summary ?? 'Will check the finished feature from a real user’s point of view.',
        metrics: [['Verdict', acc ? (acc.verdict === 'ACCEPT' ? 'Accept' : 'Reject') : '—'], ['Criteria', acc ? `${acc.criteria.filter((c) => c.met).length}/${acc.criteria.length}` : '—'], ['Issues', acc ? String(acc.issues.length) : '—'], [spendLabel, fmtSpend(spendOf('product_architect'))]],
      },
      rev: {
        key: 'rev', name: 'PR Reviewer', model: modelOf('pr_reviewer'), state: pauseIt(rev),
        sub: rev === 'run' ? 'reviewing the diff' : d.findings.length ? `${plural(d.findings.length, 'finding')}` : 'review · later',
        text: text('pr_reviewer', 'Will read the full diff and tag every finding as Blocker or Nit.'),
        metrics: [['Findings', String(d.findings.length)], ['Open blockers', String(openBlockers)], ['Rounds', String(rounds || '—')], [spendLabel, fmtSpend(spendOf('pr_reviewer'))]],
      },
      onc: {
        key: 'onc', name: 'On-Call Engineer', model: modelOf('oncall_engineer'), state: pauseIt(onc),
        sub: st[3] === 'fail' ? 'CI red · diagnosing' : st[3] === 'run' ? 'watching CI' : st[3] === 'done' ? 'CI green' : 'CI · later',
        text: text('oncall_engineer', 'Will watch GitHub Actions after the push and fix anything red.'),
        metrics: [['CI runs', String(d.ci_runs.length)], ['Failing', lastRun ? String(lastRun.jobs.filter((j) => j.conclusion === 'failure').length) : '—'], ['Last run', lastRun ? runLabel(lastRun.run_id) : '—'], [spendLabel, fmtSpend(spendOf('oncall_engineer'))]],
      },
      you: {
        key: 'you', name: 'You', model: 'human', state: you,
        sub: you === 'wait' ? 'gate 2 · waiting on you' : you === 'done' ? 'merged' : 'gate 2 · merge',
        text: you === 'wait' ? 'Everything passed. Review the summary and decide to merge.' : you === 'done' ? `Merged${f.merged_commit ? ` as ${f.merged_commit}` : ''}.` : 'You review the summary and decide to merge.',
        metrics: [['Gate', '2'], ['Status', you === 'wait' ? 'Ready' : you === 'done' ? 'Merged' : '—'], [tk ? 'Run tokens' : 'Run cost', tk ? compactNum((f.tokens_in ?? 0) + (f.tokens_out ?? 0)) : money(f.cost_usd)], ['Elapsed', duration(f.elapsed_seconds)]],
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, events, paused, maxAttempts, models]);

  // default selection: the node that is working (or waiting)
  const order: NodeKey[] = ['pa1', 'swe', 'tst', 'pa2', 'rev', 'onc', 'you'];
  const selected = sel ?? order.find((k) => nodes[k].state === 'run') ?? order.find((k) => nodes[k].state === 'wait' || nodes[k].state === 'fail') ?? 'pa1';
  const s = nodes[selected];

  const cols: { label: string; color: string; nodes: NodeKey[]; note?: string }[] = [
    { label: '01 Plan', color: '#FC6D26', nodes: ['pa1'] },
    { label: '02 Build', color: '#E24329', nodes: ['swe', 'tst'], note: current && f.stages[1] !== 'done' && current.attempts > 1 ? `⇄ loop · attempt ${current.attempts}` : current ? '⇄ loop' : undefined },
    { label: '03 Verify', color: '#A989F5', nodes: ['pa2', 'rev'] },
    { label: '04 Ship', color: '#5943B6', nodes: ['onc', 'you'] },
  ];

  const chip = featureChip(f);
  const eyebrow = f.stage === 'build' ? ['02 · Build', '#E24329'] : f.stage === 'verify' ? ['03 · Verify', '#A989F5'] : f.stage === 'ci' || f.stage === 'merge' ? ['04 · Ship', '#5943B6'] : ['01 · Plan', '#FC6D26'];
  const worktree = f.worktree_path ? f.worktree_path.split('/').filter(Boolean).pop() : null;

  const togglePause = async () => {
    const ok = await run('pause', () => (paused ? api.resume(f.id) : api.pause(f.id)));
    if (ok) toast.info(paused ? 'Run resumed.' : 'Run paused. Agents stop after their current step.');
  };

  const openLog = (a: AgentKey) => {
    setFilter(a === 'human' ? 'all' : a);
    logRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    logRef.current?.focus({ preventScroll: true });
  };

  return (
    <>
      <FeatureHeader
        eyebrow={eyebrow[0]}
        eyebrowColor={eyebrow[1]}
        title={f.title}
        feature={f}
        chip={
          <Chip kind={paused ? 'wait' : chip.kind} lg>
            {paused ? 'Paused' : chip.label}
          </Chip>
        }
        meta={
          <MetaLine>
            <span>{f.branch ?? 'no branch yet'}</span>
            {worktree && <span>worktree ../{worktree}</span>}
            <span>
              started {clock(f.created_at)} · {duration(f.elapsed_seconds)}
            </span>
          </MetaLine>
        }
        actions={
          <>
            <button type="button" className="btn" onClick={togglePause} disabled={terminal || busy !== null || f.status === 'awaiting_merge'} aria-pressed={paused}>
              {busy === 'pause' ? '…' : paused ? 'Resume' : 'Pause'}
            </button>
            <button type="button" className="btn btn-danger" onClick={() => setConfirmStop(true)} disabled={terminal || busy !== null}>
              Stop run
            </button>
          </>
        }
      />

      <section
        aria-labelledby="map-h"
        style={{
          border: '1px solid #E4E3E7',
          borderRadius: 10,
          padding: 20,
          display: 'flex',
          flexWrap: 'wrap',
          gap: 20,
          alignItems: 'flex-start',
          background: 'radial-gradient(circle, #E4E3E7 1px, transparent 1.2px) 0 0 / 18px 18px, #FFFFFF',
        }}
      >
        <div style={{ flex: '999 1 560px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14, alignSelf: 'stretch' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
            <h2 id="map-h" className="h2">
              Pipeline map
            </h2>
            <span style={{ fontSize: 12, color: '#74717A' }}>Click an agent to see what it's doing</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 18, minWidth: 760 }}>
              {cols.map((c) => (
                <div key={c.label} style={{ display: 'flex', flexDirection: 'column', gap: 14 }} role="group" aria-label={c.label}>
                  <span className="mono" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#45424D' }}>
                    <span style={{ width: 10, height: 10, background: c.color }} aria-hidden="true" />
                    {c.label}
                  </span>
                  {c.nodes.map((k) => {
                    const n = nodes[k];
                    const on = selected === k;
                    const bc = on ? '#7759C2' : n.state === 'fail' ? '#F4B3A6' : '#D9D8DC';
                    return (
                      <button
                        key={k}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setSel(k)}
                        style={{
                          width: '100%',
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'flex-start',
                          gap: 4,
                          padding: on ? '11px 13px' : '12px 14px',
                          borderRadius: 10,
                          background: '#FFFFFF',
                          cursor: 'pointer',
                          textAlign: 'left',
                          border: `${on ? 2 : 1}px solid ${bc}`,
                          boxShadow: on ? '0 0 0 4px rgba(119,89,194,0.12)' : '0 1px 2px rgba(23,19,33,0.05)',
                        }}
                      >
                        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <Dot color={NC[n.state]} size={8} style={n.state === 'run' ? { animation: 'pulse 1.6s ease-in-out infinite' } : undefined} />
                          <span style={{ fontSize: 14, fontWeight: 600, color: '#171321' }}>{n.name}</span>
                        </span>
                        <span className="mono" style={{ fontSize: 12, color: '#74717A' }}>
                          {n.sub}
                        </span>
                      </button>
                    );
                  })}
                  {c.note && (
                    <span
                      className="mono"
                      style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', height: 28, padding: '0 12px', border: '2px dashed #7759C2', borderRadius: 999, background: '#FFFFFF', fontSize: 12, color: '#171321' }}
                    >
                      {c.note}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
          <div
            aria-label="Status legend"
            style={{
              marginTop: 'auto',
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: '8px 20px',
              padding: '10px 14px',
              border: '1px solid #E4E3E7',
              borderRadius: 10,
              background: '#FFFFFF',
              fontSize: 12,
              color: '#45424D',
            }}
          >
            <span className="mono" style={{ color: '#74717A' }}>
              Status
            </span>
            {(
              [
                ['done', 'Done'],
                ['run', 'Working'],
                ['wait', 'Waiting / paused'],
                ['fail', 'Failed last check'],
                ['todo', 'Not started'],
              ] as [NState, string][]
            ).map(([k, l]) => (
              <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap', lineHeight: 1 }}>
                <Dot color={NC[k]} size={8} style={{ flex: 'none' }} />
                {l}
              </span>
            ))}
          </div>
        </div>

        <div
          aria-live="polite"
          style={{ flex: '1 1 300px', minWidth: 0, border: '1px solid #D9D8DC', borderRadius: 10, background: '#FFFFFF', padding: 18, display: 'flex', flexDirection: 'column', gap: 12, boxShadow: '0 4px 16px rgba(23,19,33,0.06)' }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 600 }}>
              <Dot color={NC[s.state]} size={9} />
              {s.name}
              <span className="sr-only"> ({s.sub})</span>
            </h3>
            <span className="label">{s.model}</span>
          </div>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: '#45424D' }}>{s.text}</p>
          <span className="label">Metrics</span>
          <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
            {s.metrics.map(([k, v]) => (
              <div key={k} style={{ minWidth: 0, gridColumn: v.length > 9 ? '1 / -1' : undefined, border: '1px solid #E4E3E7', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                <dt className="label">{k}</dt>
                <dd title={v} style={{ margin: 0, fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</dd>
              </div>
            ))}
          </dl>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <button type="button" className="btn btn-primary" style={{ minHeight: 40, borderRadius: 8, fontSize: 13, padding: '0 10px' }} onClick={() => openLog(NODE_AGENT[selected])}>
              Open log
            </button>
            {selected === 'you' ? (
              <Link to={`/features/${f.id}/merge`} className="btn" style={{ minHeight: 40, borderRadius: 8, fontSize: 13, padding: '0 10px' }}>
                Go to merge
              </Link>
            ) : (
              <button type="button" className="btn" style={{ minHeight: 40, borderRadius: 8, fontSize: 13, padding: '0 10px' }} onClick={() => setMsgFor(NODE_AGENT[selected])} disabled={terminal}>
                Message agent
              </button>
            )}
          </div>
        </div>
      </section>

      <div className="row">
        <div className="col-main" style={{ flexBasis: 520 }}>
          <LoopCard d={d} task={current} events={events} maxAttempts={maxAttempts} paused={paused} />
          <LogCard sectionRef={logRef} events={events} loading={eventsLoading} filter={filter} setFilter={setFilter} />
        </div>
        <aside aria-label="Run details" className="col-side" style={{ flexBasis: 320 }}>
          <TasksCard tasks={d.tasks} />
          <SpendCard d={d} />
          <FilesCard d={d} events={events} />
        </aside>
      </div>

      {confirmStop && (
        <Modal title="Stop this run?" onClose={() => setConfirmStop(false)}>
          <p>The agents stop right away. Committed work stays on the branch {f.branch ? <span className="mono">{f.branch}</span> : null}; you can't resume a stopped run.</p>
          <div className="actions">
            <button type="button" className="btn" onClick={() => setConfirmStop(false)}>
              Keep running
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy !== null}
              onClick={async () => {
                const ok = await run('stop', () => api.stop(f.id));
                setConfirmStop(false);
                if (ok) toast.info('Run stopped.');
              }}
            >
              {busy === 'stop' ? 'Stopping…' : 'Stop run'}
            </button>
          </div>
        </Modal>
      )}
      {msgFor && <MessageModal featureId={f.id} agent={msgFor} onClose={() => setMsgFor(null)} />}
    </>
  );
}

function MessageModal({ featureId, agent, onClose }: { featureId: number; agent: AgentKey; onClose: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={`Message ${AGENT_NAME[agent]}`} onClose={onClose}>
      <p>Your note is added to the agent's next prompt. It does not interrupt the current step.</p>
      <label className="field">
        Note
        <textarea className="textarea" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Use the existing Redis client in src/cache.py" />
      </label>
      <div className="actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!text.trim() || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.message(featureId, agent, text.trim());
              toast.success(`Note sent to ${AGENT_NAME[agent]}.`);
              onClose();
            } catch {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Sending…' : 'Send note'}
        </button>
      </div>
    </Modal>
  );
}

function LoopCard({ d, task, events, maxAttempts, paused }: { d: FeatureDetail; task: Task | null; events: Event[]; maxAttempts: number; paused: boolean }) {
  const f = d.feature;
  if (!task) {
    const done = d.tasks.filter((t) => t.status === 'committed').length;
    return (
      <section aria-labelledby="loop-h" className="card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h2 id="loop-h" className="h2">
          SWE ⇄ Tester loop
        </h2>
        <p style={{ margin: 0, fontSize: 14, color: '#45424D', lineHeight: 1.55 }}>
          {f.stage === 'plan'
            ? 'The loop starts after you approve the plan.'
            : `No task in progress. ${done} of ${d.tasks.length} tasks committed${f.stage !== 'build' ? `; the feature is in ${f.stage}.` : '.'}`}
        </p>
      </section>
    );
  }
  const steps = events
    .filter((e) => e.task_id === task.id && (e.agent === 'software_engineer' || e.agent === 'tester') && ['handoff', 'verdict', 'status'].includes(e.kind))
    .slice()
    .reverse();
  const items = steps.map((e, i) => {
    const short = AGENT_SHORT[e.agent];
    const attempt = typeof e.data?.attempt === 'number' ? ` · attempt ${e.data.attempt}` : '';
    const v = verdictOf(e);
    const isLast = i === steps.length - 1;
    let title = `${short}${attempt}`;
    let color = '#10B1B1';
    if (e.kind === 'verdict') {
      title = `${short} · ${v || 'verdict'}`;
      color = v === 'FAIL' ? '#E24329' : '#10B1B1';
    } else if (e.kind === 'handoff') title += ' · code written';
    else {
      title += isLast && !paused ? ' · working' : '';
      color = isLast && !paused ? '#7759C2' : '#10B1B1';
    }
    return { key: e.id, title, t: isLast && e.kind === 'status' && !paused ? 'now' : clock(e.ts), text: e.message, color };
  });
  if (task.status === 'running' || task.status === 'testing') {
    const lastFail = steps.some((e) => e.kind === 'verdict' && verdictOf(e) === 'FAIL');
    items.push(
      task.status === 'running'
        ? { key: -1, title: 'Tester · re-check', t: 'next', text: lastFail ? 'Will rerun the full suite and the checks that failed.' : 'Will run the full suite and adversarial checks.', color: '#A2A1A6' }
        : { key: -1, title: 'Commit', t: 'next', text: 'Committed to the branch when the Tester passes it.', color: '#A2A1A6' },
    );
  }
  return (
    <section aria-labelledby="loop-h" className="card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 10 }}>
        <h2 id="loop-h" className="h2">
          Task {pad3(task.seq)} · {task.title}
        </h2>
        <span className="label">
          SWE ⇄ Tester · attempt {Math.max(1, task.attempts)} of {maxAttempts}
        </span>
      </div>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {items.length === 0 && <li className="muted" style={{ fontSize: 13 }}>The SWE just picked this task up.</li>}
        {items.map((l) => (
          <li key={l.key} style={{ display: 'grid', gridTemplateColumns: '20px 1fr', gap: 14 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <span style={{ width: 12, height: 12, borderRadius: '50%', marginTop: 4, border: `2px solid ${l.color}`, background: '#FFFFFF' }} aria-hidden="true" />
              <span className="timeline-line" />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingBottom: 14 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'baseline' }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{l.title}</span>
                <span className="label">{l.t}</span>
              </div>
              <span style={{ fontSize: 13, lineHeight: 1.55, color: '#45424D' }}>{l.text}</span>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

const LOG_ORDER: AgentKey[] = ['software_engineer', 'tester', 'product_architect', 'pr_reviewer', 'oncall_engineer', 'human', 'system'];

const LogCard = ({
  sectionRef,
  events,
  loading,
  filter,
  setFilter,
}: {
  sectionRef: RefObject<HTMLElement>;
  events: Event[];
  loading: boolean;
  filter: AgentKey | 'all';
  setFilter: (a: AgentKey | 'all') => void;
}) => {
  const present = LOG_ORDER.filter((a) => events.some((e) => e.agent === a));
  const shown = (filter === 'all' ? events : events.filter((e) => e.agent === filter)).slice(0, 200);
  const filters: (AgentKey | 'all')[] = ['all', ...present];
  if (filter !== 'all' && !present.includes(filter)) filters.push(filter);
  return (
    <section ref={sectionRef} tabIndex={-1} aria-labelledby="log-h" className="card" style={{ display: 'flex', flexDirection: 'column', scrollMarginTop: 16 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '14px 20px', borderBottom: '1px solid #E4E3E7' }}>
        <h2 id="log-h" className="h2">
          Live log
        </h2>
        <div role="group" aria-label="Filter log by agent" className="seg">
          {filters.map((a) => (
            <button key={a} type="button" aria-pressed={filter === a} onClick={() => setFilter(a)}>
              {a === 'all' ? 'All' : AGENT_SHORT[a]}
            </button>
          ))}
        </div>
      </div>
      <div className="logbox" role="log" aria-live="polite" aria-label="Agent log, newest first" style={{ maxHeight: 460, overflowY: 'auto' }}>
        {loading && <span className="muted">Loading log…</span>}
        {!loading && shown.length === 0 && <span className="muted">No log lines yet.</span>}
        {shown.map((e) => (
          <div
            key={e.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '70px 64px 1fr',
              gap: 10,
              ...(e.kind === 'error' ? { background: '#FCE4DF', margin: '0 -20px', padding: '0 20px' } : {}),
            }}
          >
            <span style={{ color: '#74717A' }}>{clock(e.ts, true)}</span>
            <span style={{ fontWeight: 600, color: e.agent === 'software_engineer' ? '#5943B6' : '#171321', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{AGENT_SHORT[e.agent]}</span>
            <span style={{ color: '#171321', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{e.message}</span>
          </div>
        ))}
      </div>
    </section>
  );
};

function taskState(t: Task): { label: string; color: string } {
  switch (t.status) {
    case 'committed':
      return { label: 'Committed', color: '#171321' };
    case 'running':
      return { label: `Attempt ${Math.max(1, t.attempts)}`, color: '#5943B6' };
    case 'testing':
      return { label: 'Testing', color: '#5943B6' };
    case 'failed':
      return { label: 'Failed', color: '#E24329' };
    default:
      return { label: 'Pending', color: '#74717A' };
  }
}

function TasksCard({ tasks }: { tasks: Task[] }) {
  const sorted = [...tasks].sort((a, b) => a.seq - b.seq);
  const done = tasks.filter((t) => t.status === 'committed').length;
  return (
    <section aria-labelledby="tl-h" className="card" style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 id="tl-h" style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
          Tasks
        </h2>
        <span className="label">
          {done} / {tasks.length} committed
        </span>
      </div>
      {sorted.length === 0 && <span className="muted" style={{ fontSize: 13 }}>No tasks yet.</span>}
      {sorted.map((t) => {
        const s = taskState(t);
        return (
          <div key={t.id} style={{ display: 'grid', gridTemplateColumns: '36px 1fr auto', gap: 10, alignItems: 'center', minHeight: 36, fontSize: 13, borderBottom: '1px solid #F3F2F4' }}>
            <span className="mono" style={{ color: '#74717A' }}>
              {pad3(t.seq)}
            </span>
            <span style={{ color: '#171321' }}>
              {t.title}
              {t.kind !== 'plan' && (
                <span className="mono muted" style={{ fontSize: 11 }}>
                  {' '}
                  · {t.kind}
                </span>
              )}
            </span>
            <span style={{ fontSize: 12, fontWeight: 600, color: s.color }}>{s.label}</span>
          </div>
        );
      })}
    </section>
  );
}

function SpendCard({ d }: { d: FeatureDetail }) {
  const f = d.feature;
  const tk = useTokensMode();
  const est = tk ? null : f.estimate?.cost_max ?? null;
  const pct = est ? Math.min(100, Math.round((f.cost_usd / est) * 100)) : null;
  return (
    <section aria-labelledby="cost-h" className="card" style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h2 id="cost-h" className="label">
        {tk ? 'Tokens used on this run' : 'Spend on this run'}
      </h2>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.045em' }}>{tk ? compactNum(f.tokens_in + f.tokens_out) : money(f.cost_usd)}</span>
        {tk && <span style={{ fontSize: 13, color: '#74717A' }}>tokens · counts against your Claude plan</span>}
        {est != null && <span style={{ fontSize: 13, color: '#74717A' }}>of ${Math.round(est)} estimate</span>}
      </div>
      {pct != null && (
        <div role="meter" aria-label="Spend against estimate" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} style={{ height: 6, background: '#F3F2F4' }}>
          <div style={{ height: 6, width: `${pct}%`, background: 'linear-gradient(90deg, #FCA326, #A989F5)' }} />
        </div>
      )}
      <div className="kv" style={{ fontSize: 13 }}>
        <span>Tokens in / out</span>
        <span>
          {compactNum(f.tokens_in)} / {compactNum(f.tokens_out)}
        </span>
      </div>
      <div className="kv" style={{ fontSize: 13 }}>
        <span>Tool calls</span>
        <span>{f.tool_calls}</span>
      </div>
    </section>
  );
}

function FilesCard({ d, events }: { d: FeatureDetail; events: Event[] }) {
  const files = new Map<string, { add: number; del: number }>();
  events.forEach((e) => {
    const p = e.data?.path;
    if (typeof p !== 'string') return;
    const add = Number(e.data?.additions ?? 0) || 0;
    const del = Number(e.data?.deletions ?? 0) || 0;
    const cur = files.get(p) ?? { add: 0, del: 0 };
    files.set(p, { add: cur.add + add, del: cur.del + del });
  });
  const ds = d.feature.diff_stats;
  if (files.size === 0 && !ds) return null;
  const list = [...files.entries()].sort((a, b) => b[1].add + b[1].del - (a[1].add + a[1].del)).slice(0, 12);
  return (
    <section aria-labelledby="files-h" className="card" style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h2 id="files-h" style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600 }}>
        Files changed so far
      </h2>
      {list.map(([p, s]) => (
        <div key={p} className="mono" style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12 }}>
          <span style={{ color: '#171321', wordBreak: 'break-all' }}>{p}</span>
          <span style={{ whiteSpace: 'nowrap' }}>
            +{s.add} {minus(s.del)}
          </span>
        </div>
      ))}
      {ds && (
        <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12, color: '#74717A', paddingTop: list.length ? 8 : 0, borderTop: list.length ? '1px solid #F3F2F4' : undefined }}>
          <span>{plural(ds.files, 'file')} on the branch</span>
          <span style={{ color: '#171321' }}>
            +{ds.additions} {minus(ds.deletions)}
          </span>
        </div>
      )}
    </section>
  );
}
