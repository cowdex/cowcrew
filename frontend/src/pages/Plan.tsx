import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { FeatureDetail, Question, Task } from '../api/types';
import { Chip, Dot, ErrorState, FeatureHeader, Loading, NumBox } from '../components/ui';
import { clock, duration, pad2, plural } from '../lib/format';
import { numColor } from '../lib/status';
import { toast } from '../lib/toast';
import { useApp } from '../state/app';
import { useFeatureEvents } from '../state/hooks';
import { splitSpec, useAction, useFeaturePage } from './shared';

export default function PlanPage() {
  const { id, detail, error, reload, setDetail } = useFeaturePage({ label: 'Plans', to: '/plans' });
  if (error && !detail) return <ErrorState message={error} onRetry={() => reload(false)} />;
  if (!detail) return <Loading label="Loading plan" />;
  return <PlanView key={id} d={detail} setDetail={setDetail} />;
}

function PlanView({ d, setDetail }: { d: FeatureDetail; setDetail: (d: FeatureDetail) => void }) {
  const f = d.feature;
  const { settings } = useApp();
  const model = settings?.models.product_architect ?? 'fable';
  const status = f.status;
  const working = status === 'grilling' || status === 'grooming';
  const planTasks = d.tasks.filter((t) => t.kind === 'plan');

  const chip =
    status === 'grilling' ? (
      <Chip kind="run" lg>Reading your spec</Chip>
    ) : status === 'awaiting_answers' ? (
      <Chip kind="wait" lg>Waiting for your answers</Chip>
    ) : status === 'grooming' ? (
      <Chip kind="run" lg>Grooming the plan</Chip>
    ) : status === 'awaiting_plan_approval' ? (
      <Chip kind="wait" lg>Waiting for your approval</Chip>
    ) : status === 'stopped' || status === 'failed' ? (
      <Chip kind={status === 'failed' ? 'fail' : 'pend'} lg>{status === 'failed' ? 'Failed' : 'Stopped'}</Chip>
    ) : (
      <Chip kind="done" lg>Plan approved</Chip>
    );

  const sub =
    status === 'grilling'
      ? `Product Architect (${model}) is reading the spec and the repo · ${duration(f.elapsed_seconds)} so far`
      : status === 'awaiting_answers'
        ? `Product Architect (${model}) has ${plural(d.questions.filter((q) => !q.answer).length, 'question')} before it can plan`
        : status === 'grooming'
          ? `Product Architect (${model}) is writing tasks with your answers · ${duration(f.elapsed_seconds)} so far`
          : [
              `Groomed by Product Architect (${model}) in ${duration(f.elapsed_seconds)}`,
              plural(planTasks.length, 'task'),
              f.adr ? '1 ADR' : null,
              f.glossary_terms.length ? `glossary +${f.glossary_terms.length} ${f.glossary_terms.length === 1 ? 'term' : 'terms'}` : null,
            ]
              .filter(Boolean)
              .join(' · ');

  return (
    <>
      <FeatureHeader
        eyebrow={status === 'awaiting_answers' || working ? 'Gate 01 · planning' : 'Gate 01 · plan approval'}
        eyebrowColor="#FC6D26"
        title={f.title}
        chip={chip}
        feature={f}
        meta={<p style={{ margin: 0, fontSize: 14, color: '#74717A' }}>{sub}</p>}
      />

      <div className="row" style={{ gap: 24 }}>
        <div className="col-main">
          <SpecCard spec={f.spec} />
          {status === 'awaiting_answers' ? (
            <QuestionsForm d={d} setDetail={setDetail} />
          ) : (
            d.questions.length > 0 && <QAList questions={d.questions} />
          )}
          {working && <WorkingCard featureId={f.id} grooming={status === 'grooming'} />}
          {!working && status !== 'awaiting_answers' && d.tasks.length > 0 && <TasksAccordion tasks={d.tasks} />}
          {!working && f.adr && <AdrCard adr={f.adr} />}
        </div>

        <aside aria-label="Decision" className="col-side">
          <DecisionPanel d={d} setDetail={setDetail} />
          {f.estimate && !working && status !== 'awaiting_answers' && (
            <section aria-labelledby="est-h" className="card" style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <h2 id="est-h" className="label">
                Estimate
              </h2>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span className="big">
                    {f.estimate.hours_min}–{f.estimate.hours_max} h
                  </span>
                  <span style={{ fontSize: 13, color: '#74717A' }}>run time</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span className="big">
                    ${Math.round(f.estimate.cost_min)}–{Math.round(f.estimate.cost_max)}
                  </span>
                  <span style={{ fontSize: 13, color: '#74717A' }}>agent cost</span>
                </div>
              </div>
              <div style={{ height: 6, background: 'linear-gradient(90deg, #FCA326, #A989F5)' }} aria-hidden="true" />
              <div className="kv">
                <span>Files likely touched</span>
                <span>~{f.estimate.files}</span>
              </div>
              {f.glossary_terms.length > 0 && (
                <div className="kv">
                  <span>New glossary terms</span>
                  <span>{f.glossary_terms.join(', ')}</span>
                </div>
              )}
            </section>
          )}
          <Guardrails />
        </aside>
      </div>
    </>
  );
}

function SpecCard({ spec }: { spec: string }) {
  const { lead, rest } = splitSpec(spec || 'No spec text.');
  return (
    <section aria-labelledby="spec-h" className="card" style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <span className="label">Your spec</span>
      <h2 id="spec-h" style={{ margin: 0, fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.35 }}>
        {lead}
      </h2>
      {rest && <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, color: '#45424D', whiteSpace: 'pre-wrap' }}>{rest}</p>}
    </section>
  );
}

function QAList({ questions }: { questions: Question[] }) {
  const answered = questions.filter((q) => q.answer).length;
  return (
    <section aria-labelledby="grill-h" className="card" style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingBottom: 12, borderBottom: '1px solid #E4E3E7' }}>
        <h2 id="grill-h" className="label" style={{ color: '#45424D' }}>
          Grilling · questions the planner asked
        </h2>
        <span style={{ fontSize: 12, color: '#74717A' }}>{answered} answered</span>
      </div>
      {questions.map((q) => (
        <div key={q.id} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '14px 0', borderBottom: '1px solid #EFEEF1' }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: '#171321' }}>{q.question}</span>
          <span style={{ fontSize: 14, lineHeight: 1.55, color: '#45424D' }}>
            <span className="mono" style={{ fontSize: 12, color: '#A989F5' }}>
              You ·{' '}
            </span>
            {q.answer ?? <em className="muted">not answered</em>}
          </span>
        </div>
      ))}
    </section>
  );
}

function QuestionsForm({ d, setDetail }: { d: FeatureDetail; setDetail: (d: FeatureDetail) => void }) {
  const [answers, setAnswers] = useState<Record<number, string>>(() => Object.fromEntries(d.questions.map((q) => [q.id, q.answer ?? ''])));
  const { busy, run } = useAction(setDetail);
  const open = d.questions.filter((q) => !(answers[q.id] ?? '').trim()).length;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run('answers', () =>
      api.answer(
        d.feature.id,
        d.questions.map((q) => ({ id: q.id, answer: (answers[q.id] ?? '').trim() })),
      ),
    );
    if (ok) toast.success('Answers sent. The Product Architect is grooming the plan.');
  };
  return (
    <form aria-labelledby="q-h" className="card" style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 4, borderColor: '#F9D29A' }} onSubmit={submit}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingBottom: 12, borderBottom: '1px solid #E4E3E7' }}>
        <h2 id="q-h" className="label" style={{ color: '#45424D' }}>
          Grilling · the planner has questions for you
        </h2>
        <span style={{ fontSize: 12, color: '#74717A' }}>
          {d.questions.length - open} of {d.questions.length} answered
        </span>
      </div>
      {d.questions.map((q, i) => (
        <div key={q.id} style={{ display: 'grid', gridTemplateColumns: '40px 1fr', gap: 16, padding: '16px 0', borderBottom: '1px solid #EFEEF1' }}>
          <NumBox n={pad2(i + 1)} color={numColor(i)} />
          <label className="field" style={{ gap: 10 }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: '#171321', lineHeight: 1.4 }}>{q.question}</span>
            <textarea
              className="textarea"
              rows={2}
              value={answers[q.id] ?? ''}
              placeholder="Your answer"
              onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
              required
            />
          </label>
        </div>
      ))}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingTop: 16 }}>
        <span style={{ fontSize: 13, color: '#74717A' }}>{open ? `${plural(open, 'question')} left` : 'All answered. The planner takes it from here.'}</span>
        <button type="submit" className="btn btn-primary btn-lg" disabled={open > 0 || busy !== null}>
          {busy ? 'Sending…' : 'Send answers'}
        </button>
      </div>
    </form>
  );
}

function WorkingCard({ featureId, grooming }: { featureId: number; grooming: boolean }) {
  const events = useFeatureEvents(featureId, 50);
  const lines = (events ?? []).filter((e) => e.agent === 'product_architect' || e.agent === 'system').slice(0, 6);
  return (
    <section aria-labelledby="work-h" className="card" style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 14, background: 'radial-gradient(60% 120% at 100% 0%, rgba(169,137,245,0.14), rgba(169,137,245,0) 70%), #FFFFFF' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Dot color="#7759C2" size={9} style={{ animation: 'pulse 1.6s ease-in-out infinite' }} />
        <h2 id="work-h" style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
          {grooming ? 'Turning your answers into a plan' : 'Reading your spec and the repo'}
        </h2>
      </div>
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: '#45424D' }}>
        {grooming
          ? 'The Product Architect is writing tasks with acceptance criteria and, if needed, an architecture decision. It comes back here for your approval.'
          : 'The Product Architect looks for gaps in the spec. If something is unclear it will ask you a few questions here.'}
      </p>
      <div className="logbox" style={{ borderRadius: 8 }} aria-live="polite">
        {lines.length === 0 && <span className="muted">Waiting for the first log line…</span>}
        {lines.map((e) => (
          <div key={e.id} style={{ display: 'grid', gridTemplateColumns: '70px 1fr', gap: 10 }}>
            <span className="muted">{clock(e.ts, true)}</span>
            <span style={{ color: '#171321', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{e.message}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function TasksAccordion({ tasks }: { tasks: Task[] }) {
  const sorted = [...tasks].sort((a, b) => a.seq - b.seq);
  const [open, setOpen] = useState<number | null>(sorted[0]?.id ?? null);
  return (
    <section aria-labelledby="tasks-h" className="card" style={{ padding: 22, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingBottom: 12, borderBottom: '1px solid #E4E3E7' }}>
        <h2 id="tasks-h" className="label" style={{ color: '#45424D' }}>
          Tasks plan · runs in this order
        </h2>
        <span className="label">tasks/*.md</span>
      </div>
      {sorted.map((t, i) => {
        const isOpen = open === t.id;
        const panel = `task-ac-${t.id}`;
        return (
          <div key={t.id} style={{ display: 'grid', gridTemplateColumns: '40px 1fr auto', gap: 18, alignItems: 'start', padding: '18px 0', borderBottom: '1px solid #EFEEF1' }}>
            <NumBox n={pad2(t.seq)} color={numColor(i)} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{t.title}</h3>
              <span style={{ fontSize: 14, lineHeight: 1.55, color: '#74717A' }}>{t.description}</span>
              {t.acceptance_criteria.length > 0 && (
                <>
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-controls={panel}
                    onClick={() => setOpen(isOpen ? null : t.id)}
                    style={{ alignSelf: 'flex-start', minHeight: 32, padding: 0, border: 0, background: 'transparent', color: '#7759C2', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
                  >
                    {isOpen ? 'Hide acceptance criteria' : 'Show acceptance criteria'}
                  </button>
                  {isOpen && (
                    <div id={panel} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 14px', background: '#FAFAFA', borderRadius: 8 }}>
                      <span className="label">Acceptance criteria</span>
                      <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {t.acceptance_criteria.map((c) => (
                          <li key={c} style={{ fontSize: 13, color: '#171321' }}>
                            <span style={{ color: '#10B1B1', fontWeight: 700 }} aria-hidden="true">
                              ✓
                            </span>{' '}
                            {c}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </div>
            <span
              className="mono"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 34, padding: '0 14px', borderRadius: 999, background: '#F3F2F4', fontSize: 12, color: '#171321', whiteSpace: 'nowrap' }}
            >
              {t.label || t.kind}
            </span>
          </div>
        );
      })}
    </section>
  );
}

const CODEY = /^[/.]|[_/]|\(|\)|\.(py|ts|md)$|·/;

function AdrCard({ adr }: { adr: { title: string; body: string } }) {
  const paras = adr.body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return (
    <section aria-labelledby="adr-h" className="card" style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <span className="label">Architecture decision</span>
      </div>
      <h2 id="adr-h" style={{ margin: 0, fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em' }}>
        {adr.title}
      </h2>
      {paras.map((p, i) => {
        const steps = p.split(/\s*→\s*/);
        if (steps.length >= 3 && !p.includes('\n')) return <Flow key={i} steps={steps} />;
        return (
          <p key={i} style={{ margin: 0, fontSize: 15, lineHeight: 1.6, color: '#45424D', whiteSpace: 'pre-wrap' }}>
            {p}
          </p>
        );
      })}
    </section>
  );
}

function Flow({ steps }: { steps: string[] }) {
  const out: ReactNode[] = [];
  steps.forEach((s, i) => {
    const code = CODEY.test(s);
    const accent = /oidc|provider|external|google|github|stripe/i.test(s) && !code;
    if (i > 0)
      out.push(
        <span key={`a${i}`} style={{ color: '#74717A' }} aria-hidden="true">
          →
        </span>,
      );
    out.push(
      <div
        key={i}
        className={code ? 'mono' : undefined}
        style={{
          padding: '10px 14px',
          borderRadius: 8,
          border: accent ? '1.5px solid #A989F5' : '1px solid #D9D8DC',
          background: accent ? '#F1ECFD' : '#FFFFFF',
          fontSize: code ? 12 : 13,
          fontWeight: code ? 400 : 600,
        }}
      >
        {s}
      </div>,
    );
  });
  return (
    <div role="img" aria-label={`Flow: ${steps.join(', then ')}`} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: 18, border: '1px dashed #D1D0D3', borderRadius: 10, background: '#FAFAFA' }}>
      {out}
    </div>
  );
}

function DecisionPanel({ d, setDetail }: { d: FeatureDetail; setDetail: (d: FeatureDetail) => void }) {
  const f = d.feature;
  const nav = useNavigate();
  const [note, setNote] = useState('');
  const { busy, run } = useAction(setDetail);
  const [confirmSent, setConfirmSent] = useState(false);
  useEffect(() => {
    if (f.status === 'awaiting_plan_approval') setConfirmSent(false);
  }, [f.status]);

  if (f.status === 'awaiting_plan_approval') {
    return (
      <section aria-labelledby="dec-h" style={{ border: '1px solid #F9D29A', borderRadius: 10, background: '#FFFBF4', padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h2 id="dec-h" style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
          Your decision
        </h2>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: '#45424D' }}>
          Approving creates {f.branch ? <>branch <span className="mono" style={{ fontSize: 13 }}>{f.branch}</span></> : 'a feature branch'} in its own worktree and starts the run. You
          won't be needed again until the PR.
        </p>
        <button
          type="button"
          className="btn btn-primary btn-lg"
          disabled={busy !== null}
          onClick={async () => {
            const ok = await run('approve', () => api.approve(f.id));
            if (ok) {
              toast.success('Plan approved. The run has started.');
              nav(`/features/${f.id}/live`);
            }
          }}
        >
          {busy === 'approve' ? 'Approving…' : 'Approve plan & start run'}
        </button>
        <label className="field">
          Or ask for changes
          <textarea className="textarea" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Split task 03 in two; keep password reset for SSO users" />
        </label>
        <button
          type="button"
          className="btn"
          style={{ minHeight: 44 }}
          disabled={busy !== null || !note.trim()}
          onClick={async () => {
            const ok = await run('changes', () => api.requestChanges(f.id, note.trim()));
            if (ok) {
              setNote('');
              setConfirmSent(true);
            }
          }}
        >
          {busy === 'changes' ? 'Sending…' : 'Send back to Product Architect'}
        </button>
      </section>
    );
  }
  if (f.status === 'grooming' && confirmSent) {
    return (
      <section className="card" style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Sent back for re-grooming</h2>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: '#45424D' }}>Product Architect is revising the plan. It comes back here for approval.</p>
      </section>
    );
  }
  if (f.status === 'grilling' || f.status === 'grooming' || f.status === 'awaiting_answers') {
    const answering = f.status === 'awaiting_answers';
    return (
      <section className="card" style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 10, borderColor: answering ? '#F9D29A' : undefined, background: answering ? '#FFFBF4' : undefined }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{answering ? 'Your answers shape the plan' : 'Nothing to do yet'}</h2>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: '#45424D' }}>
          {answering
            ? 'Short answers are fine. The planner turns them into tasks with acceptance criteria, then asks you to approve.'
            : 'The plan lands here when it is ready. We will ping you in notifications; you can leave this page.'}
        </p>
      </section>
    );
  }
  if (f.status === 'stopped' || f.status === 'failed') {
    return (
      <section className="card" style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{f.status === 'failed' ? 'This run failed' : 'This run was stopped'}</h2>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: '#45424D' }}>See the live log for the last thing that happened.</p>
        <Link to={`/features/${f.id}/live`} className="btn">
          Open the log
        </Link>
      </section>
    );
  }
  return (
    <section style={{ border: '1px solid #6FDAC9', borderRadius: 10, background: '#EEFCF9', padding: 22, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: '#171321' }}>Plan approved</h2>
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: '#45424D' }}>
        {f.branch ? `Branch ${f.branch} created · ` : ''}
        {f.worktree_path ? 'worktree ready · ' : ''}
        {f.stage_text}.
      </p>
      <Link to={`/features/${f.id}/live`} className="btn btn-primary" style={{ minHeight: 44 }}>
        Watch the live run →
      </Link>
    </section>
  );
}

function Guardrails() {
  const items: [string, string, string][] = [
    ['#FC6D26', 'Isolated worktree', "Agents can't touch main until you merge"],
    ['#E24329', 'Approved tools only', 'Read, Edit, Bash, git, gh · no network installs'],
    ['#A989F5', 'Separation of duties', 'The agent that writes code never approves it'],
  ];
  return (
    <section aria-labelledby="guard-h" className="card" style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <h2 id="guard-h" className="label">
        Guardrails for this run
      </h2>
      {items.map(([c, t, s], i) => (
        <div key={t} style={{ display: 'grid', gridTemplateColumns: '30px 1fr', gap: 12, alignItems: 'start' }}>
          <NumBox n={i + 1} color={c} size="sm" />
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>{t}</span>
            <span style={{ fontSize: 13, color: '#74717A' }}>{s}</span>
          </span>
        </div>
      ))}
    </section>
  );
}
