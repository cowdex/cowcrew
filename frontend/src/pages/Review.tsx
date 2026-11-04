import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { FeatureDetail, Finding } from '../api/types';
import { Chip, EmptyCard, ErrorState, ExtLink, FeatureHeader, Loading, MetaLine, NumBox } from '../components/ui';
import { minus, plural } from '../lib/format';
import { useApp } from '../state/app';
import { useFeaturePage } from './shared';

export default function ReviewPage() {
  const { detail, error, reload } = useFeaturePage({ label: 'Reviews', to: '/reviews' });
  if (error && !detail) return <ErrorState message={error} onRetry={() => reload(false)} />;
  if (!detail) return <Loading label="Loading review" />;
  return <ReviewView d={detail} />;
}

const NIT_COLORS = ['#A989F5', '#A989F5', '#5943B6', '#7759C2'];

function ReviewView({ d }: { d: FeatureDetail }) {
  const f = d.feature;
  const { projects } = useApp();
  const base = projects?.find((p) => p.id === f.project_id)?.default_branch ?? 'main';
  const [tab, setTab] = useState<'all' | 'Blocker' | 'Nit'>('all');
  const acc = d.acceptance;
  const blockers = d.findings.filter((x) => x.severity === 'Blocker');
  const nits = d.findings.filter((x) => x.severity === 'Nit');
  const openBlockers = blockers.filter((x) => x.status === 'open').length;
  const rounds = d.findings.reduce((m, x) => Math.max(m, x.round), 0);
  const notYet = f.stage === 'plan' || f.stage === 'build';

  const chip = acc
    ? acc.verdict === 'ACCEPT'
      ? openBlockers
        ? <Chip kind="fail" lg>Accepted · {plural(openBlockers, 'open blocker')}</Chip>
        : f.status === 'reviewing'
          ? <Chip kind="run" lg>Accepted · PR review running</Chip>
          : <Chip kind="done" lg>Accepted · 0 open blockers</Chip>
      : <Chip kind="fail" lg>Rejected · back to the SWE</Chip>
    : f.status === 'accepting'
      ? <Chip kind="run" lg>Acceptance running</Chip>
      : <Chip kind="pend" lg>Not reviewed yet</Chip>;

  const shown = d.findings.filter((x) => tab === 'all' || x.severity === tab);

  return (
    <>
      <FeatureHeader
        eyebrow="03 · Verify"
        eyebrowColor="#A989F5"
        title={f.title}
        chip={chip}
        feature={f}
        meta={
          <MetaLine>
            <span>
              {f.branch ?? 'no branch yet'} → {base}
            </span>
            {f.diff_stats && (
              <span>
                {plural(f.diff_stats.files, 'file')} · <span style={{ color: '#171321' }}>+{f.diff_stats.additions}</span>{' '}
                <span style={{ color: '#171321' }}>{minus(f.diff_stats.deletions)}</span>
              </span>
            )}
            {rounds > 0 && <span>{plural(rounds, 'review round')}</span>}
            {f.pr_url && <ExtLink href={f.pr_url}>Open on GitHub</ExtLink>}
          </MetaLine>
        }
      />

      {notYet && !acc && d.findings.length === 0 ? (
        <EmptyCard title="Review starts after the build" action={<Link className="btn" to={`/features/${f.id}/live`}>Watch the live run</Link>}>
          When every task is committed, the Product Architect checks the feature as a user would, then the PR Reviewer reads the full diff.
        </EmptyCard>
      ) : (
        <>
          <section aria-labelledby="acc-h" className="card" style={{ padding: 24, display: 'flex', flexWrap: 'wrap', gap: 28 }}>
            <div style={{ flex: '1 1 280px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <span className="label">Acceptance · Product Architect</span>
              <h2 id="acc-h" style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.3 }}>
                Does it make sense to a real user?
              </h2>
              <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, color: '#45424D' }}>
                {acc?.summary ?? (f.status === 'accepting' ? 'The Product Architect is checking the feature right now.' : 'No acceptance verdict yet.')}
              </p>
              {acc && (
                <span
                  className="mono"
                  style={{ display: 'inline-flex', alignItems: 'center', height: 30, padding: '0 12px', border: `1.5px solid ${acc.verdict === 'ACCEPT' ? '#10B1B1' : '#E24329'}`, color: '#171321', fontSize: 12, width: 'fit-content' }}
                >
                  {acc.verdict === 'ACCEPT' ? 'Accept' : 'Reject'}
                </span>
              )}
            </div>
            <div style={{ flex: '2 1 480px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16, justifyContent: 'center' }}>
              {acc && acc.criteria.length > 0 && (
                <>
                  <span className="label">Criteria checked · {acc.criteria.filter((c) => c.met).length} of {acc.criteria.length} met</span>
                  <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '10px 20px' }}>
                    {acc.criteria.map((c) => (
                      <li key={c.text} style={{ fontSize: 14, color: '#171321', display: 'flex', gap: 8, padding: '10px 12px', borderRadius: 8, background: c.met ? '#FAFAFA' : '#FFF6F3' }}>
                        <span style={{ color: c.met ? '#10B1B1' : '#E24329', fontWeight: 700 }} aria-hidden="true">
                          {c.met ? '✓' : '✗'}
                        </span>
                        <span>
                          <span className="sr-only">{c.met ? 'Met: ' : 'Not met: '}</span>
                          {c.text}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {acc && acc.issues.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span className="label">Issues raised</span>
                  {acc.issues.map((i) => (
                    <span key={i} style={{ fontSize: 14, color: '#171321' }}>
                      <span style={{ color: '#E24329', fontWeight: 700 }} aria-hidden="true">
                        !
                      </span>{' '}
                      {i}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </section>

          <div className="row">
            <section aria-labelledby="find-h" className="card" style={{ flex: '999 1 540px', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '16px 22px', borderBottom: '1px solid #E4E3E7' }}>
                <h2 id="find-h" className="h2">
                  PR Reviewer findings
                </h2>
                <div role="group" aria-label="Filter findings" className="seg">
                  {(
                    [
                      ['all', `All ${d.findings.length}`],
                      ['Blocker', `Blockers ${blockers.length}`],
                      ['Nit', `Nits ${nits.length}`],
                    ] as const
                  ).map(([k, l]) => (
                    <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k)}>
                      {l}
                    </button>
                  ))}
                </div>
              </div>
              {shown.length === 0 && (
                <div className="empty">{d.findings.length === 0 ? (f.status === 'reviewing' ? 'The PR Reviewer is reading the diff…' : 'No findings.') : 'Nothing in this filter.'}</div>
              )}
              {shown.map((x) => (
                <FindingRow key={x.id} x={x} n={d.findings.indexOf(x) + 1} nitIndex={nits.indexOf(x)} />
              ))}
            </section>

            <aside aria-label="Review rounds" className="card" style={{ flex: '1 1 320px', minWidth: 0, padding: 22, display: 'flex', flexDirection: 'column', gap: 16 }}>
              <h2 className="label">How this review went</h2>
              <Rounds d={d} />
              <Link to={`/features/${f.id}/ci`} className="btn" style={{ minHeight: 44 }}>
                Next: CI checks →
              </Link>
            </aside>
          </div>
        </>
      )}
    </>
  );
}

function FindingRow({ x, n, nitIndex }: { x: Finding; n: number; nitIndex: number }) {
  const blocker = x.severity === 'Blocker';
  const color = blocker ? '#E24329' : NIT_COLORS[Math.max(0, nitIndex) % NIT_COLORS.length];
  const status = x.status === 'fixed' ? 'Fixed' : x.status === 'noted' ? 'In PR notes' : 'Open';
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '40px 1fr auto', gap: 16, alignItems: 'start', padding: '18px 22px', borderBottom: '1px solid #EFEEF1' }}>
      <NumBox n={n} color={color} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
          <span className="mono" style={{ display: 'inline-flex', alignItems: 'center', height: 22, padding: '0 8px', fontSize: 12, background: blocker ? '#FCE4DF' : '#F3F2F4', color: blocker ? '#171321' : '#45424D' }}>
            {x.severity}
          </span>
          <span className="mono" style={{ fontSize: 12, color: '#7759C2', wordBreak: 'break-all' }}>
            {x.file}
            {x.line != null ? `:${x.line}` : ''}
          </span>
          {x.round > 0 && <span className="label">round {x.round}</span>}
        </div>
        <span style={{ fontSize: 14, lineHeight: 1.55, color: '#171321' }}>{x.text}</span>
      </div>
      <span style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', color: x.status === 'fixed' ? '#171321' : x.status === 'open' && blocker ? '#E24329' : '#74717A' }}>{status}</span>
    </div>
  );
}

function Rounds({ d }: { d: FeatureDetail }) {
  const maxRound = d.findings.reduce((m, x) => Math.max(m, x.round), 0);
  const rollups = d.tasks.filter((t) => t.kind === 'rollup').sort((a, b) => a.seq - b.seq);
  const items: { color: string; title: string; sub: string }[] = [];
  let r = 0;
  for (let round = 1; round <= maxRound; round++) {
    const inRound = d.findings.filter((x) => x.round === round);
    const b = inRound.filter((x) => x.severity === 'Blocker').length;
    const n = inRound.length - b;
    const rollup = b ? rollups[r++] : undefined;
    items.push({
      color: b ? '#E24329' : '#10B1B1',
      title: `Round ${round} · ${plural(b, 'blocker')}${n ? `, ${plural(n, 'nit')}` : ''}`,
      sub: b ? (rollup ? `Rollup task ${String(rollup.seq).padStart(3, '0')} filed → back to SWE` : 'Blockers go back to the SWE') : n ? `${plural(n, 'nit')} added to the PR description for you` : 'Clean',
    });
    if (rollup && rollup.status === 'committed') {
      items.push({ color: '#7759C2', title: `Fix${rollup.commit_sha ? ` · commit ${rollup.commit_sha}` : ''}`, sub: 'SWE fixed it; Tester re-passed' });
    } else if (rollup) {
      items.push({ color: '#7759C2', title: 'Fix in progress', sub: `Rollup task ${rollup.status}` });
    }
  }
  if (items.length === 0)
    return <p style={{ margin: 0, fontSize: 14, color: '#74717A', lineHeight: 1.55 }}>No review rounds yet. Blockers send a rollup task back to the SWE; nits go to the PR description for you.</p>;
  return (
    <>
      {items.map((it, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '32px 1fr', gap: 12, alignItems: 'start' }}>
          <NumBox n={i + 1} color={it.color} size="sm" />
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>{it.title}</span>
            <span style={{ fontSize: 13, color: '#74717A' }}>{it.sub}</span>
          </span>
        </div>
      ))}
    </>
  );
}
