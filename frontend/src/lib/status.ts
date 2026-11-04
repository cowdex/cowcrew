import type { AgentCard, AgentKey, FeatureStatus, FeatureSummary, Stage, StageState } from '../api/types';

/** dot color, text color, chip background */
export const ST: Record<StageState, [string, string, string]> = {
  done: ['#10B1B1', '#171321', '#C5F4EC'],
  run: ['#7759C2', '#5943B6', '#F1ECFD'],
  wait: ['#FC6D26', '#171321', '#FDF1DD'],
  fail: ['#E24329', '#171321', '#FCE4DF'],
  pend: ['#A2A1A6', '#74717A', '#F3F2F4'],
};

/** Board/segment fill colors (pending uses the lighter gray from the designs). */
export const FILL: Record<StageState, string> = {
  done: '#10B1B1',
  run: '#7759C2',
  wait: '#FC6D26',
  fail: '#E24329',
  pend: '#E3E2E6',
};

export const STATE_WORD: Record<StageState, string> = {
  done: 'done',
  run: 'running',
  wait: 'waiting on you',
  fail: 'failed',
  pend: 'pending',
};

export const AGENT_NAME: Record<AgentKey, string> = {
  product_architect: 'Product Architect',
  software_engineer: 'Software Engineer',
  tester: 'Tester',
  pr_reviewer: 'PR Reviewer',
  oncall_engineer: 'On-Call Engineer',
  human: 'You',
  system: 'System',
};

export const AGENT_SHORT: Record<AgentKey, string> = {
  product_architect: 'PA',
  software_engineer: 'SWE',
  tester: 'Tester',
  pr_reviewer: 'Reviewer',
  oncall_engineer: 'On-Call',
  human: 'You',
  system: 'System',
};

export const WORKER_AGENTS = [
  'product_architect',
  'software_engineer',
  'tester',
  'pr_reviewer',
  'oncall_engineer',
] as const;

export const AGENT_STATE_KIND: Record<AgentCard['state'], StageState> = {
  working: 'run',
  waiting: 'wait',
  queued: 'pend',
  idle: 'pend',
};
export const AGENT_STATE_LABEL: Record<AgentCard['state'], string> = {
  working: 'Working',
  waiting: 'Waiting on you',
  queued: 'Queued',
  idle: 'Idle',
};

export const PLAN_STATUSES: FeatureStatus[] = ['grilling', 'awaiting_answers', 'grooming', 'awaiting_plan_approval'];
export const STAGES: Stage[] = ['plan', 'build', 'verify', 'ci', 'merge'];

export type FeatureTab = 'plan' | 'live' | 'review' | 'ci' | 'merge';
export const TAB_STAGE_INDEX: Record<FeatureTab, number> = { plan: 0, live: 1, review: 2, ci: 3, merge: 4 };

export function featureChip(f: Pick<FeatureSummary, 'status' | 'stages'>): { kind: StageState; label: string } {
  switch (f.status) {
    case 'grilling':
      return { kind: 'run', label: 'Planning' };
    case 'awaiting_answers':
      return { kind: 'wait', label: 'Gate 1 · answer' };
    case 'grooming':
      return { kind: 'run', label: 'Grooming' };
    case 'awaiting_plan_approval':
      return { kind: 'wait', label: 'Gate 1 · approve' };
    case 'building':
      return { kind: 'run', label: 'Running' };
    case 'accepting':
      return { kind: 'run', label: 'Acceptance' };
    case 'reviewing':
      return { kind: 'run', label: 'In review' };
    case 'ci':
      return f.stages[3] === 'fail' ? { kind: 'fail', label: 'CI failing' } : { kind: 'run', label: 'CI running' };
    case 'awaiting_merge':
      return { kind: 'wait', label: 'Gate 2 · merge' };
    case 'merged':
      return { kind: 'done', label: 'Merged' };
    case 'paused':
      return { kind: 'wait', label: 'Paused' };
    case 'stopped':
      return { kind: 'pend', label: 'Stopped' };
    case 'failed':
      return { kind: 'fail', label: 'Failed' };
  }
}

/** Best page for a feature given where it is in the lifecycle. */
export function featureHref(f: Pick<FeatureSummary, 'id' | 'status' | 'stage'>): string {
  const base = `/features/${f.id}`;
  if (f.status === 'merged') return `${base}/merge`;
  switch (f.stage) {
    case 'plan':
      return `${base}/plan`;
    case 'build':
      return `${base}/live`;
    case 'verify':
      return f.status === 'paused' ? `${base}/live` : `${base}/review`;
    case 'ci':
      return `${base}/ci`;
    case 'merge':
      return `${base}/merge`;
  }
}

export const NUM_COLORS = ['#FC6D26', '#E24329', '#A989F5', '#A989F5', '#5943B6', '#7759C2', '#5943B6'];
export function numColor(i: number): string {
  return NUM_COLORS[i % NUM_COLORS.length];
}
