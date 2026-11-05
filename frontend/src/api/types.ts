// Mirrors docs/CONTRACT.md exactly. Do not drift.

export type AgentKey =
  | 'product_architect'
  | 'software_engineer'
  | 'tester'
  | 'pr_reviewer'
  | 'oncall_engineer'
  | 'human'
  | 'system';
export type WorkerAgentKey = Exclude<AgentKey, 'human' | 'system'>;

export type FeatureStatus =
  | 'grilling'
  | 'awaiting_answers'
  | 'grooming'
  | 'awaiting_plan_approval'
  | 'building'
  | 'accepting'
  | 'reviewing'
  | 'ci'
  | 'awaiting_merge'
  | 'merged'
  | 'paused'
  | 'stopped'
  | 'failed';
export type Stage = 'plan' | 'build' | 'verify' | 'ci' | 'merge';
export type StageState = 'done' | 'run' | 'wait' | 'fail' | 'pend';

export interface Project {
  id: number;
  name: string;
  repo_path: string;
  default_branch: string;
  github_repo: string | null;
  created_at: string;
}

export interface FeatureSummary {
  id: number;
  project_id: number;
  title: string;
  status: FeatureStatus;
  stage: Stage;
  stages: StageState[];
  stage_text: string;
  branch: string | null;
  pr_number: number | null;
  pr_url: string | null;
  tasks_done: number;
  tasks_total: number;
  elapsed_seconds: number;
  cost_usd: number;
  tokens?: number;
  waiting_on_you: boolean;
  created_at: string;
  updated_at: string;
}

export interface Question {
  id: number;
  question: string;
  answer: string | null;
}

export interface Task {
  id: number;
  seq: number;
  title: string;
  description: string;
  acceptance_criteria: string[];
  depends_on: string;
  label: string;
  status: 'pending' | 'running' | 'testing' | 'committed' | 'failed';
  attempts: number;
  commit_sha: string | null;
  kind: 'plan' | 'rollup' | 'fix';
}

export interface Finding {
  id: number;
  round: number;
  severity: 'Blocker' | 'Nit';
  file: string;
  line: number | null;
  text: string;
  status: 'open' | 'fixed' | 'noted';
}

export interface Acceptance {
  verdict: 'ACCEPT' | 'REJECT';
  summary: string;
  criteria: { text: string; met: boolean }[];
  issues: string[];
}

export interface CIJob {
  name: string;
  conclusion: 'success' | 'failure' | 'in_progress' | 'queued' | 'skipped';
  duration_seconds: number | null;
}

export interface CIRun {
  id: number;
  run_id: string;
  status: 'queued' | 'in_progress' | 'success' | 'failure';
  jobs: CIJob[];
  failing_job: string | null;
  failing_log: string | null;
  diagnosis: { root_cause: string; responsible_task: string; why_missed: string; fix_task: string } | null;
  created_at: string;
}

export type EventKind = 'log' | 'tool' | 'status' | 'handoff' | 'verdict' | 'cost' | 'gate' | 'error';

export interface Event {
  id: number;
  feature_id: number | null;
  task_id: number | null;
  ts: string;
  agent: AgentKey;
  kind: EventKind;
  message: string;
  data: Record<string, unknown>;
}

export type ChecklistLink = 'plan' | 'live' | 'review' | 'ci' | 'merge';

export interface FeatureFull extends FeatureSummary {
  spec: string;
  worktree_path: string | null;
  current_task_id: number | null;
  adr: { title: string; body: string } | null;
  glossary_terms: string[];
  estimate: { hours_min: number; hours_max: number; cost_min: number; cost_max: number; files: number } | null;
  tokens_in: number;
  tokens_out: number;
  tool_calls: number;
  diff_stats: { files: number; additions: number; deletions: number } | null;
  merged_commit: string | null;
  paused: boolean;
}

export interface FeatureDetail {
  feature: FeatureFull;
  questions: Question[];
  tasks: Task[];
  acceptance: Acceptance | null;
  findings: Finding[];
  ci_runs: CIRun[];
  spend_by_agent: { agent: AgentKey; model: string; cost_usd: number; tokens?: number }[];
  checklist: { title: string; sub: string; ok: boolean; link: ChecklistLink }[];
}

export interface AgentCard {
  key: AgentKey;
  name: string;
  model: string;
  state: 'working' | 'waiting' | 'queued' | 'idle';
  job: string;
  context_pct: number;
  spend_usd: number;
  spend_tokens?: number;
  feature_id: number | null;
}

export interface Overview {
  kpis: {
    in_flight: number;
    waiting_on_you: number;
    committed_7d: number;
    first_try_pass_pct: number;
    first_try_pass_num: number;
    ci_failing: number;
    spend_7d_usd: number;
    budget_usd: number;
    spend_7d_tokens?: number;
    budget_tokens?: number;
  };
  board: { feature_id: number; title: string; cells: StageState[]; summary: string }[];
  spend: {
    unit?: 'usd' | 'tokens';
    total_usd: number;
    total_tokens?: number;
    wow_pct: number | null;
    by_model: { model: string; agents: string; usd: number; tokens?: number; pct: number }[];
    projected_usd: number;
    projected_tokens?: number;
    budget_used_pct: number;
    plan?: string | null;
    plan_cost_usd?: number | null;
    plan_week_usd?: number | null;
    plan_used_pct?: number | null;
  };
  trends: {
    key: 'lead_time' | 'loops_per_task' | 'blockers_per_pr';
    label: string;
    value: string;
    delta: string;
    good: boolean;
    points: number[];
  }[];
  features: FeatureSummary[];
  agents: AgentCard[];
  activity: Event[];
}

export type Billing = 'api' | 'subscription';

export interface ModelOption {
  id: string;
  name: string;
  group: string;
  note: string;
}

export interface ModelCatalog {
  source: 'anthropic' | 'builtin';
  fetched_at: number;
  models: ModelOption[];
}

export interface Settings {
  budget_usd_week: number;
  budget_tokens_week?: number;
  billing?: Billing;
  plan?: 'pro' | 'max' | 'ultra' | null;
  max_attempts: number;
  models: Record<WorkerAgentKey, string>;
  simulate: boolean;
  has_credentials: boolean;
  gh_available: boolean;
}

export type WsMessage =
  | { type: 'event'; event: Event }
  | { type: 'feature'; feature: FeatureSummary }
  | { type: 'hello'; version: string };
