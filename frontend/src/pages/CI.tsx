import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { CIJob, CIRun, FeatureDetail } from '../api/types';
import { Chip, Dot, EmptyCard, ErrorState, ExtLink, FeatureHeader, Loading, MetaLine, NumBox } from '../components/ui';
import { clock, duration, pad3, relTime } from '../lib/format';
import { useFeaturePage } from './shared';

export default function CIPage() {
  const { detail, error, reload } = useFeaturePage({ label: 'CI & On-Call', to: '/ci' });
  if (error && !detail) return <ErrorState message={error} onRetry={() => reload(false)} />;
  if (!detail) return <Loading label="Loading CI" />;
  return <CIView d={detail} />;
}

const JOB_LOOK: Record<CIJob['conclusion'], { dot: string; label: string; border: string; bg: string }> = {
  success: { dot: '#10B1B1', label: 'Passed', border: '#E4E3E7', bg: '#FFFFFF' },
  failure: { dot: '#E24329', label: 'Failed', border: '#F4B3A6', bg: '#FFF6F3' },
  in_progress: { dot: '#7759C2', label: 'Running', border: '#E4E3E7', bg: '#FFFFFF' },
  queued: { dot: '#A2A1A6', label: 'Queued', border: '#E4E3E7', bg: '#FFFFFF' },
  skipped: { dot: '#A2A1A6', label: 'Skipped', border: '#E4E3E7', bg: '#FAFAFA' },
};

function runLabel(r: CIRun): string {
  return { success: 'Passed', failure: 'Failed', in_progress: 'Running', queued: 'Queued' }[r.status];
}

function CIView({ d }: { d: FeatureDetail }) {
  const f = d.feature;
  const run = d.ci_runs[0] ?? null;
  const fixTask = d.tasks.filter((t) => t.kind === 'fix').sort((a, b) => b.seq - a.seq)[0] ?? null;

  const chip = !run ? (
    <Chip kind="pend" lg>No CI runs yet</Chip>
  ) : run.status === 'failure' ? (
    <Chip kind="fail" lg>{run.diagnosis ? 'CI failing · On-Call is on it' : 'CI failing · On-Call diagnosing'}</Chip>
  ) : run.status === 'success' ? (
    <Chip kind="done" lg>CI green</Chip>
  ) : (
    <Chip kind="run" lg>CI {run.status === 'queued' ? 'queued' : 'running'}</Chip>
  );

  const total = run ? Math.max(0, ...run.jobs.map((j) => j.duration_seconds ?? 0)) : 0;

  return (
    <>
      <FeatureHeader
        eyebrow="04 · Ship · CI"
        eyebrowColor="#A989F5"
        title={f.title}
        chip={chip}
        feature={f}
        meta={
          <MetaLine>
            <span>{f.branch ?? 'no branch yet'}</span>
            {run && <span>GitHub Actions · run #{run.run_id}</span>}
            {run && (
              <span>
                {run.status === 'failure' ? 'failed' : run.status === 'success' ? 'passed' : 'started'} {clock(run.created_at)}
                {total ? ` · ${duration(total)}` : ''}
              </span>
            )}
            {f.pr_url && <ExtLink href={f.pr_url}>PR #{f.pr_number}</ExtLink>}
          </MetaLine>
        }
      />

      {!run ? (
        <EmptyCard title={f.stage === 'merge' ? 'CI was skipped for this feature' : 'CI has not run yet'} action={<Link className="btn" to={`/features/${f.id}/live`}>Open the live run</Link>}>
          {f.stage === 'merge'
            ? 'There is no GitHub remote or no workflow on this repository, so CowCrew went straight to the merge gate.'
            : 'After the PR Reviewer has no open blockers, CowCrew pushes the branch, opens a PR and watches GitHub Actions here. If CI goes red, the On-Call Engineer diagnoses it.'}
        </EmptyCard>
      ) : (
        <>
          <section aria-labelledby="jobs-h" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <h2 id="jobs-h" className="label">
              Run #{run.run_id} · jobs
            </h2>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
              {run.jobs.map((j) => {
                const l = JOB_LOOK[j.conclusion];
                return (
                  <li key={j.name} style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '14px 16px', borderRadius: 10, border: `1px solid ${l.border}`, background: l.bg }}>
                    <span className="label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Dot color={l.dot} size={7} />
                      {j.name}
                    </span>
                    <span style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em', color: '#171321' }}>{l.label}</span>
                    <span style={{ fontSize: 12, color: '#74717A' }}>{j.duration_seconds != null ? duration(j.duration_seconds) : '—'}</span>
                  </li>
                );
              })}
            </ul>
          </section>

          <div className="row">
            <div className="col-main">
              {run.failing_log && <FailingLog run={run} />}
              {run.status === 'failure' && <Diagnosis run={run} fixTaskSeq={fixTask?.seq ?? null} featureId={f.id} />}
              {run.status === 'success' && (
                <section className="card" style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 10, borderColor: '#6FDAC9', background: '#EEFCF9' }}>
                  <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>All {run.jobs.length} jobs passed</h2>
                  <p style={{ margin: 0, fontSize: 14, color: '#45424D', lineHeight: 1.6 }}>
                    {f.status === 'awaiting_merge' ? 'The PR is ready for your call at Gate 2.' : f.status === 'merged' ? 'This feature has been merged.' : 'Nothing for the On-Call Engineer to do.'}
                  </p>
                  {f.status === 'awaiting_merge' && (
                    <Link to={`/features/${f.id}/merge`} className="btn btn-primary" style={{ alignSelf: 'flex-start' }}>
                      Go to merge →
                    </Link>
                  )}
                </section>
              )}
            </div>

            <aside aria-label="Recovery progress" className="col-side" style={{ flexBasis: 320 }}>
              {run.status === 'failure' && <Recovery d={d} run={run} fixTaskSeq={fixTask?.seq ?? null} fixStatus={fixTask?.status ?? null} />}
              <section aria-labelledby="hist-h" className="card" style={{ padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <h2 id="hist-h" style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 600 }}>
                  Recent runs on this branch
                </h2>
                {d.ci_runs.slice(0, 8).map((r) => {
                  const passed = r.jobs.filter((j) => j.conclusion === 'success').length;
                  return (
                    <div key={r.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(52px, 120px) 1fr auto', gap: 10, alignItems: 'center', minHeight: 36, fontSize: 13, borderBottom: '1px solid #F3F2F4' }}>
                      <span className="mono muted" title={`#${r.run_id}`} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>#{r.run_id}</span>
                      <span style={{ color: '#171321' }}>
                        {passed}/{r.jobs.length} jobs · {relTime(r.created_at)} ago
                      </span>
                      <span style={{ fontSize: 12, fontWeight: 600, color: '#171321', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <Dot color={r.status === 'success' ? '#10B1B1' : r.status === 'failure' ? '#E24329' : '#7759C2'} />
                        {runLabel(r)}
                      </span>
                    </div>
                  );
                })}
              </section>
            </aside>
          </div>
        </>
      )}
    </>
  );
}

function FailingLog({ run }: { run: CIRun }) {
  const lines = (run.failing_log ?? '').split('\n');
  return (
    <section aria-labelledby="log-h" className="card" style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 10, padding: '14px 22px', borderBottom: '1px solid #E4E3E7' }}>
        <h2 id="log-h" className="h2">
          Failing step{run.failing_job ? ` · ${run.failing_job}` : ''}
        </h2>
        <span className="label">gh run view {run.run_id} --log-failed</span>
      </div>
      <pre
        className="mono"
        style={{ margin: 0, padding: '14px 22px', background: '#FAFAFA', borderRadius: '0 0 10px 10px', fontSize: 12.5, lineHeight: 1.75, color: '#45424D', overflowX: 'auto', maxHeight: 480, whiteSpace: 'pre' }}
      >
        {lines.map((l, i) => {
          const bad = /^\s*(✗|✘|×|FAIL|Error|ERROR)/.test(l);
          const ok = /^\s*✓/.test(l);
          return (
            <div key={i} style={bad ? { color: '#171321', background: '#FCE4DF', margin: '0 -22px', padding: '0 22px' } : ok ? { color: '#45424D' } : undefined}>
              {ok ? (
                <>
                  <span style={{ color: '#171321' }}>✓</span>
                  {l.replace(/^\s*✓/, '')}
                </>
              ) : (
                l || ' '
              )}
            </div>
          );
        })}
      </pre>
    </section>
  );
}

function Diagnosis({ run, fixTaskSeq, featureId }: { run: CIRun; fixTaskSeq: number | null; featureId: number }) {
  const dg = run.diagnosis;
  if (!dg)
    return (
      <section className="card" style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Dot color="#7759C2" size={9} style={{ animation: 'pulse 1.6s ease-in-out infinite' }} />
          <h2 className="h2">On-Call is reading the logs</h2>
        </div>
        <p style={{ margin: 0, fontSize: 14, color: '#45424D', lineHeight: 1.6 }}>The diagnosis appears here with the root cause and the fix task it hands to the SWE.</p>
      </section>
    );
  const resp = dg.responsible_task.match(/^(\d{1,3})\s+(.*)$/);
  const rows: { color: string; title: string; body: ReactNode }[] = [
    { color: '#E24329', title: 'Root cause', body: dg.root_cause },
    {
      color: '#A989F5',
      title: 'Responsible task',
      body: resp ? (
        <>
          <span className="mono" style={{ color: '#7759C2' }}>
            {resp[1]}
          </span>{' '}
          {resp[2]}
        </>
      ) : (
        dg.responsible_task
      ),
    },
    { color: '#A989F5', title: 'Why the Tester missed it', body: dg.why_missed },
  ];
  return (
    <section aria-labelledby="diag-h" className="card" style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 10, alignItems: 'center', paddingBottom: 10, borderBottom: '1px solid #E4E3E7' }}>
        <h2 id="diag-h" className="h2">
          On-Call diagnosis
        </h2>
        <span className="label">On-Call Engineer</span>
      </div>
      {rows.map((r, i) => (
        <div key={r.title} style={{ display: 'grid', gridTemplateColumns: '40px 1fr', gap: 16, alignItems: 'start', padding: '14px 0', borderBottom: '1px solid #EFEEF1' }}>
          <NumBox n={i + 1} color={r.color} size="md" />
          <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>{r.title}</span>
            <span style={{ fontSize: 14, lineHeight: 1.55, color: '#45424D' }}>{r.body}</span>
          </span>
        </div>
      ))}
      <div style={{ display: 'grid', gridTemplateColumns: '40px 1fr auto', gap: 16, alignItems: 'start', padding: '14px 0 0' }}>
        <NumBox n={4} color="#5943B6" size="md" />
        <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>Fix task handed to the SWE</span>
          <span style={{ fontSize: 14, lineHeight: 1.55, color: '#45424D' }}>{dg.fix_task}</span>
        </span>
        {fixTaskSeq != null && <ExtLink href={`/features/${featureId}/live`}>task {pad3(fixTaskSeq)}-fix</ExtLink>}
      </div>
    </section>
  );
}

function Recovery({ d, run, fixTaskSeq, fixStatus }: { d: FeatureDetail; run: CIRun; fixTaskSeq: number | null; fixStatus: string | null }) {
  type K = 'done' | 'run' | 'todo';
  const later = d.ci_runs.find((r) => r.id !== run.id && Date.parse(r.created_at) > Date.parse(run.created_at));
  const fixDone = fixStatus === 'committed';
  const steps: { title: string; sub: string; k: K }[] = [
    { title: 'CI failure detected', sub: `${clock(run.created_at)} · run #${run.run_id}`, k: 'done' },
    { title: 'Root cause found', sub: run.diagnosis ? `traced to task ${run.diagnosis.responsible_task.split(' ')[0]}` : 'reading logs', k: run.diagnosis ? 'done' : 'run' },
    { title: 'Fix task handed to SWE', sub: fixTaskSeq != null ? `task ${pad3(fixTaskSeq)}-fix` : 'after diagnosis', k: fixTaskSeq != null ? 'done' : 'todo' },
    { title: 'SWE fixes, Tester re-checks', sub: fixDone ? 'done' : fixTaskSeq != null ? 'in progress' : 'waiting', k: fixDone ? 'done' : fixTaskSeq != null ? 'run' : 'todo' },
    { title: 'CI re-run is green', sub: later?.status === 'success' ? `run #${later.run_id}` : 'On-Call re-verifies', k: later?.status === 'success' ? 'done' : later ? 'run' : 'todo' },
  ];
  const c = { done: '#10B1B1', run: '#7759C2', todo: '#A2A1A6' };
  return (
    <section aria-labelledby="rec-h" className="card" style={{ padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 2 }}>
      <h2 id="rec-h" className="label" style={{ marginBottom: 14 }}>
        Getting back to green
      </h2>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {steps.map((s) => (
          <li key={s.title} style={{ display: 'grid', gridTemplateColumns: '22px 1fr', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <span style={{ width: 12, height: 12, marginTop: 4, borderRadius: '50%', border: `2px solid ${c[s.k]}`, background: s.k === 'done' ? c[s.k] : '#FFFFFF' }} aria-hidden="true" />
              <span className="timeline-line" style={{ marginTop: 3 }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingBottom: 14 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>
                {s.title}
                <span className="sr-only"> ({s.k === 'done' ? 'done' : s.k === 'run' ? 'in progress' : 'not started'})</span>
              </span>
              <span className="label">{s.sub}</span>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
