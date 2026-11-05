import { Link } from 'react-router-dom';
import type { FeatureSummary } from '../api/types';
import { Chip, EmptyCard, Loading, StageBar } from '../components/ui';
import { IconPlus } from '../components/icons';
import { duration, relTime } from '../lib/format';
import { PLAN_STATUSES, featureChip } from '../lib/status';
import { CostText, useApp, useCrumbs } from '../state/app';
import { useFeatures } from '../state/hooks';

interface ListSpec {
  crumb: string;
  eyebrow: string;
  eyebrowColor: string;
  title: string;
  intro: string;
  filter: (f: FeatureSummary) => boolean;
  cta: (f: FeatureSummary) => { label: string; to: string; primary: boolean };
  empty: string;
}

function FeatureList({ spec }: { spec: ListSpec }) {
  useCrumbs([{ label: spec.crumb }]);
  const { projects } = useApp();
  const all = useFeatures();
  if (projects && projects.length === 0)
    return (
      <EmptyCard title="Add a project first" action={<Link className="btn btn-primary" to="/settings#projects">Open settings</Link>}>
        CowCrew works on git repositories on this computer. Add one in Settings to start.
      </EmptyCard>
    );
  const list = all?.filter(spec.filter).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span className="mono" style={{ fontSize: 12, color: spec.eyebrowColor }}>
            {spec.eyebrow}
          </span>
          <h1 className="title" style={{ fontSize: 28 }}>
            {spec.title}
          </h1>
          <p style={{ margin: 0, fontSize: 14, color: '#74717A' }}>{spec.intro}</p>
        </div>
        <Link to="/new" className="btn btn-primary">
          <IconPlus />
          New feature spec
        </Link>
      </div>
      {!list ? (
        <Loading />
      ) : list.length === 0 ? (
        <EmptyCard title="Nothing here right now">{spec.empty}</EmptyCard>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 14 }}>
          {list.map((f) => (
            <FeatureCard key={f.id} f={f} cta={spec.cta(f)} />
          ))}
        </ul>
      )}
    </>
  );
}

function FeatureCard({ f, cta }: { f: FeatureSummary; cta: { label: string; to: string; primary: boolean } }) {
  const c = featureChip(f);
  return (
    <li className="card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14, borderColor: f.waiting_on_you ? '#F9D29A' : undefined, background: f.waiting_on_you ? '#FFFBF4' : undefined }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, letterSpacing: '-0.02em' }}>
            <Link to={cta.to} style={{ color: '#171321', textDecoration: 'none' }}>
              {f.title}
            </Link>
          </h2>
          <span className="mono muted" style={{ fontSize: 12 }}>
            {f.branch ?? 'branch not created yet'}
          </span>
        </div>
        <Chip kind={c.kind}>{c.label}</Chip>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <StageBar stages={f.stages} />
        <span style={{ fontSize: 13, color: '#45424D' }}>{f.stage_text}</span>
      </div>
      <div className="mono" style={{ display: 'flex', flexWrap: 'wrap', gap: 16, fontSize: 12, color: '#74717A' }}>
        <span>
          {f.tasks_done}/{f.tasks_total} tasks
        </span>
        <span>{duration(f.elapsed_seconds)}</span>
        <CostText usd={f.cost_usd} tokens={f.tokens} />
        <span>updated {relTime(f.updated_at)} ago</span>
      </div>
      <Link to={cta.to} className={'btn' + (cta.primary ? ' btn-primary' : '')} style={{ alignSelf: 'flex-start' }}>
        {cta.label}
      </Link>
    </li>
  );
}

const inStage = (f: FeatureSummary, ...stages: FeatureSummary['stage'][]) => stages.includes(f.stage);

export function PlansList() {
  return (
    <FeatureList
      spec={{
        crumb: 'Plans',
        eyebrow: 'Gate 01 · plans',
        eyebrowColor: '#FC6D26',
        title: 'Plans',
        intro: 'Specs being grilled and groomed by the Product Architect. You answer questions and approve plans here.',
        filter: (f) => PLAN_STATUSES.includes(f.status) || (f.status === 'paused' && f.stage === 'plan'),
        cta: (f) =>
          f.status === 'awaiting_answers'
            ? { label: 'Answer questions', to: `/features/${f.id}/plan`, primary: true }
            : f.status === 'awaiting_plan_approval'
              ? { label: 'Review the plan', to: `/features/${f.id}/plan`, primary: true }
              : { label: 'Watch planning', to: `/features/${f.id}/plan`, primary: false },
        empty: 'No specs are in planning. Write a new feature spec to start one.',
      }}
    />
  );
}

export function LiveList() {
  return (
    <FeatureList
      spec={{
        crumb: 'Live runs',
        eyebrow: '02 · Build',
        eyebrowColor: '#E24329',
        title: 'Live runs',
        intro: 'Features the agents are building, verifying or shipping right now. Newest first.',
        filter: (f) => inStage(f, 'build', 'verify', 'ci') && !['stopped', 'failed'].includes(f.status),
        cta: (f) => ({ label: 'Open live run', to: `/features/${f.id}/live`, primary: f.status !== 'paused' }),
        empty: 'Nothing is running. Approve a plan to start a run.',
      }}
    />
  );
}

export function ReviewsList() {
  return (
    <FeatureList
      spec={{
        crumb: 'Reviews',
        eyebrow: '03 · Verify',
        eyebrowColor: '#A989F5',
        title: 'Reviews',
        intro: 'Acceptance by the Product Architect and PR review findings, per feature.',
        filter: (f) => inStage(f, 'verify', 'ci', 'merge'),
        cta: (f) => ({ label: 'Open review', to: `/features/${f.id}/review`, primary: f.stage === 'verify' }),
        empty: 'No feature has reached review yet.',
      }}
    />
  );
}

export function CiList() {
  return (
    <FeatureList
      spec={{
        crumb: 'CI & On-Call',
        eyebrow: '04 · Ship · CI',
        eyebrowColor: '#A989F5',
        title: 'CI & On-Call',
        intro: 'GitHub Actions runs for each pushed branch. When CI goes red, the On-Call Engineer diagnoses it and hands a fix to the SWE.',
        filter: (f) => f.stages[3] !== 'pend' || f.stage === 'ci',
        cta: (f) => ({ label: f.stages[3] === 'fail' ? 'See the diagnosis' : 'Open CI', to: `/features/${f.id}/ci`, primary: f.stages[3] === 'fail' }),
        empty: 'No branch has been pushed yet. CI shows up here after the PR Reviewer is done.',
      }}
    />
  );
}

export function MergeList() {
  return (
    <FeatureList
      spec={{
        crumb: 'Merge queue',
        eyebrow: 'Gate 02 · Merge',
        eyebrowColor: '#5943B6',
        title: 'Merge queue',
        intro: 'PRs that passed every check and are waiting for your call, plus recent merges.',
        filter: (f) => f.status === 'awaiting_merge' || f.status === 'merged',
        cta: (f) => (f.status === 'merged' ? { label: 'View summary', to: `/features/${f.id}/merge`, primary: false } : { label: 'Review & merge', to: `/features/${f.id}/merge`, primary: true }),
        empty: 'Nothing is waiting to merge.',
      }}
    />
  );
}
