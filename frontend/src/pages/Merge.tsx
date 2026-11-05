import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { ChecklistLink, FeatureDetail } from '../api/types';
import { Chip, ErrorState, ExtLink, FeatureHeader, Loading, Modal, NumBox } from '../components/ui';
import { duration, minus, plural } from '../lib/format';
import { numColor } from '../lib/status';
import { toast } from '../lib/toast';
import { CostText, useApp } from '../state/app';
import { useAction, useFeaturePage } from './shared';

export default function MergePage() {
  const { detail, error, reload, setDetail } = useFeaturePage({ label: 'Merge queue', to: '/merge' });
  if (error && !detail) return <ErrorState message={error} onRetry={() => reload(false)} />;
  if (!detail) return <Loading label="Loading merge" />;
  return <MergeView key={detail.feature.id} d={detail} setDetail={setDetail} />;
}

const LINK_LABEL: Record<ChecklistLink, string> = { plan: 'Plan', live: 'Run', review: 'Review', ci: 'CI', merge: 'Diff' };

function defaultMessage(d: FeatureDetail): string {
  const f = d.feature;
  const prefix = f.branch?.split('/')[0];
  const type = prefix && ['feat', 'fix', 'chore', 'docs', 'refactor', 'perf', 'test'].includes(prefix) ? prefix : 'feat';
  const title = f.title.charAt(0).toLowerCase() + f.title.slice(1);
  return `${type}: ${title}${f.pr_number ? ` (#${f.pr_number})` : ''}`;
}

function MergeView({ d, setDetail }: { d: FeatureDetail; setDetail: (d: FeatureDetail) => void }) {
  const f = d.feature;
  const nav = useNavigate();
  const { projects } = useApp();
  const base = projects?.find((p) => p.id === f.project_id)?.default_branch ?? 'main';
  const [message, setMessage] = useState(() => defaultMessage(d));
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [admin, setAdmin] = useState(false);
  const [followUp, setFollowUp] = useState(false);
  const [sendBack, setSendBack] = useState(false);
  const [note, setNote] = useState('');
  const { busy, run } = useAction(setDetail);

  const ready = f.status === 'awaiting_merge';
  const merged = f.status === 'merged';
  const passed = d.checklist.filter((c) => c.ok).length;
  const nits = d.findings.filter((x) => x.severity === 'Nit' && x.status !== 'fixed');
  const planTasks = d.tasks.filter((t) => t.kind === 'plan');
  const loops = planTasks.reduce((a, t) => a + Math.max(t.attempts, t.status === 'pending' ? 0 : 1), 0);

  const chip = merged ? <Chip kind="done" lg>Merged</Chip> : ready ? <Chip kind="wait" lg>Ready to merge</Chip> : <Chip kind="pend" lg>Not ready yet</Chip>;

  const doMerge = async () => {
    const ok = await run('merge', () => api.merge(f.id, { commit_message: message.trim(), delete_branch: deleteBranch, follow_up_nits: followUp && nits.length > 0, admin }));
    if (ok) toast.success(`Merged into ${base}.`);
  };

  return (
    <>
      <FeatureHeader
        eyebrow="Gate 02 · Merge"
        eyebrowColor="#5943B6"
        title={f.title}
        chip={chip}
        feature={f}
        meta={
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14 }}>
            <p style={{ margin: 0, fontSize: 15, color: '#45424D' }}>Everything the agents did, in one place. You make the final call.</p>
            {f.pr_url && <ExtLink href={f.pr_url}>PR #{f.pr_number}</ExtLink>}
          </div>
        }
      />

      <div className="row" style={{ gap: 24 }}>
        <div className="col-main">
          <section aria-labelledby="chk-h" className="card" style={{ padding: 22, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, paddingBottom: 12, borderBottom: '1px solid #E4E3E7' }}>
              <h2 id="chk-h" className="label" style={{ color: '#45424D' }}>
                Pre-merge checklist
              </h2>
              <span className="mono" style={{ fontSize: 12, color: '#171321' }}>
                {passed} / {d.checklist.length} passed
              </span>
            </div>
            {d.checklist.length === 0 && (
              <p style={{ margin: '16px 0 0', fontSize: 14, color: '#74717A', lineHeight: 1.55 }}>
                The checklist fills in as the feature passes plan, build, review and CI. It is complete when the feature reaches Gate 2.
              </p>
            )}
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {d.checklist.map((c, i) => (
                <li key={c.title} style={{ display: 'grid', gridTemplateColumns: '40px 1fr auto', gap: 18, alignItems: 'center', padding: '16px 0', borderBottom: '1px solid #EFEEF1' }}>
                  <NumBox n={i + 1} color={numColor(i)} />
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span style={{ fontSize: 15, fontWeight: 600 }}>
                      {c.title}{' '}
                      <span style={{ color: c.ok ? '#10B1B1' : '#E24329' }} aria-hidden="true">
                        {c.ok ? '✓' : '✗'}
                      </span>
                      <span className="sr-only">{c.ok ? '(passed)' : '(not passed)'}</span>
                    </span>
                    <span style={{ fontSize: 13, color: '#74717A' }}>{c.sub}</span>
                  </span>
                  <ExtLink href={`/features/${f.id}/${c.link}`}>{LINK_LABEL[c.link]}</ExtLink>
                </li>
              ))}
            </ul>
          </section>

          {nits.length > 0 && (
            <section aria-labelledby="nits-h" className="card" style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <h2 id="nits-h" style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>
                {plural(nits.length, 'nit')} left for you to judge
              </h2>
              <p style={{ margin: 0, fontSize: 14, color: '#74717A' }}>Not blocking. Merge as-is, or turn them into a follow-up task.</p>
              {nits.map((n) => (
                <span key={n.id} style={{ fontSize: 14, color: '#171321' }}>
                  <span className="mono" style={{ fontSize: 12, color: '#7759C2' }}>
                    {n.file.split('/').pop()}
                    {n.line != null ? `:${n.line}` : ''}
                  </span>{' '}
                  · {n.text}
                </span>
              ))}
              {!merged && (
                <label className="check">
                  <input type="checkbox" checked={followUp} onChange={(e) => setFollowUp(e.target.checked)} disabled={!ready} />
                  Create a follow-up task for the nits after merge
                </label>
              )}
            </section>
          )}
        </div>

        <aside aria-label="Merge" className="col-side" style={{ flexBasis: 340 }}>
          {merged ? (
            <section style={{ border: '1px solid #6FDAC9', borderRadius: 10, background: '#EEFCF9', padding: 22, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: '#171321' }}>Merged into {base}</h2>
              <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: '#45424D' }}>
                {f.merged_commit ? `Commit ${f.merged_commit}` : 'Merged'}
                {f.pr_number ? ` · PR #${f.pr_number}` : ''}
                {d.tasks.some((t) => t.title.toLowerCase().startsWith('follow-up')) ? ' · follow-up task created for the nits' : ''}.
              </p>
              <Link to="/" className="btn" style={{ minHeight: 44, borderColor: '#6FDAC9' }}>
                Back to overview
              </Link>
            </section>
          ) : (
            <section
              aria-labelledby="call-h"
              style={{ border: '1px solid #D9D8DC', borderRadius: 10, padding: 22, display: 'flex', flexDirection: 'column', gap: 14, boxShadow: '0 4px 16px rgba(23,19,33,0.06)', overflow: 'hidden' }}
            >
              <div style={{ height: 4, margin: '-22px -22px 4px', background: 'linear-gradient(90deg, #FCA326, #A989F5)' }} aria-hidden="true" />
              <h2 id="call-h" style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
                Your call
              </h2>
              {!ready && (
                <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: '#45424D' }}>
                  Merge opens when every check passes and the feature reaches Gate 2. Right now: {f.stage_text.toLowerCase()}.
                </p>
              )}
              <label className="field">
                Squash commit message
                <textarea className="textarea mono" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} disabled={!ready} style={{ background: '#FAFAFA', fontSize: 13 }} />
              </label>
              <label className="check">
                <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} disabled={!ready} />
                Delete branch and worktree after merge
              </label>
              {f.pr_number != null && (
                <label className="check">
                  <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} disabled={!ready} />
                  <span>
                    Merge as admin <span style={{ color: '#74717A' }}>· bypass GitHub branch rules (required reviews or checks)</span>
                  </span>
                </label>
              )}
              <button type="button" className="btn btn-primary btn-lg" disabled={!ready || !message.trim() || busy !== null} onClick={doMerge}>
                {busy === 'merge' ? 'Merging…' : 'Squash & merge'}
              </button>
              <button type="button" className="btn" style={{ minHeight: 44 }} disabled={!ready || busy !== null} onClick={() => setSendBack(true)}>
                Send back with a note
              </button>
            </section>
          )}

          <section aria-labelledby="sum-h" className="card" style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
            <h2 id="sum-h" className="label">
              Run summary
            </h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.045em' }}>{duration(f.elapsed_seconds)}</span>
                <span style={{ fontSize: 13, color: '#74717A' }}>spec to PR</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.045em' }}>
                  {f.tasks_done}/{f.tasks_total}
                </span>
                <span style={{ fontSize: 13, color: '#74717A' }}>tasks committed</span>
              </div>
            </div>
            <div className="kv" style={{ paddingTop: 12, borderTop: '1px solid #EFEEF1' }}>
              <span>Spec cost</span>
              <CostText usd={f.cost_usd} tokens={f.tokens_in + f.tokens_out} />
            </div>
            <div className="kv">
              <span>SWE ⇄ Tester loops</span>
              <span>
                {loops} over {plural(planTasks.length, 'task')}
              </span>
            </div>
            {f.diff_stats && (
              <div className="kv">
                <span>Diff</span>
                <span>
                  +{f.diff_stats.additions} {minus(f.diff_stats.deletions)} · {plural(f.diff_stats.files, 'file')}
                </span>
              </div>
            )}
          </section>
        </aside>
      </div>

      {sendBack && (
        <Modal title="Send back with a note" onClose={() => setSendBack(false)}>
          <p>Your note becomes a rollup task for the Software Engineer. The feature goes back through build, review and CI, then returns here.</p>
          <label className="field">
            What should change?
            <textarea className="textarea" rows={4} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Rename “Bill” to “Invoice” everywhere before merging" />
          </label>
          <div className="actions">
            <button type="button" className="btn" onClick={() => setSendBack(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!note.trim() || busy !== null}
              onClick={async () => {
                const ok = await run('sendback', () => api.sendBack(f.id, note.trim()));
                if (ok) {
                  setSendBack(false);
                  toast.info('Sent back to the Software Engineer.');
                  nav(`/features/${f.id}/live`);
                }
              }}
            >
              {busy === 'sendback' ? 'Sending…' : 'Send back'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
