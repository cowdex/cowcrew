/* Mock backend used when VITE_MOCK=1. Data is shaped exactly like docs/CONTRACT.md and mirrors the
 * sample content of the approved designs. It keeps state in memory and simulates transitions so the
 * whole UI (gates, pause/resume, merge, WebSocket log streaming) can be exercised without the backend. */
import { ApiError } from './client';
import type {
  AgentCard,
  AgentKey,
  CIRun,
  Event,
  EventKind,
  FeatureDetail,
  FeatureFull,
  FeatureStatus,
  FeatureSummary,
  Overview,
  Project,
  Question,
  Settings,
  StageState,
  Task,
  WorkerAgentKey,
  WsMessage,
} from './types';

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const ago = (min: number) => iso(NOW - min * 60_000);
const empty = typeof location !== 'undefined' && new URLSearchParams(location.search).has('mock-empty');

// ---------------------------------------------------------------- projects & settings
let projects: Project[] = empty
  ? []
  : [
      { id: 1, name: 'orbit-api', repo_path: '/Users/you/code/orbit-api', default_branch: 'main', github_repo: 'acme/orbit-api', created_at: ago(60 * 24 * 12) },
      { id: 2, name: 'billing-web', repo_path: '/Users/you/code/billing-web', default_branch: 'main', github_repo: null, created_at: ago(60 * 24 * 3) },
    ];

let settings: Settings = {
  budget_usd_week: 60,
  max_attempts: 4,
  models: { product_architect: 'fable', software_engineer: 'opus', tester: 'sonnet', pr_reviewer: 'fable', oncall_engineer: 'sonnet' },
  simulate: true,
  has_credentials: false,
  gh_available: true,
};

// ---------------------------------------------------------------- helpers
let idSeq = 1000;
const nextId = () => ++idSeq;

function task(id: number, seq: number, title: string, description: string, label: string, ac: string[], status: Task['status'], extra: Partial<Task> = {}): Task {
  return {
    id, seq, title, description, acceptance_criteria: ac, depends_on: label.includes('needs') ? label.split('needs ')[1] : '', label,
    status, attempts: status === 'pending' ? 0 : 1, commit_sha: status === 'committed' ? Math.random().toString(16).slice(2, 9) : null, kind: 'plan', ...extra,
  };
}

interface Store {
  feature: FeatureFull;
  questions: Question[];
  tasks: Task[];
  detail: Omit<FeatureDetail, 'feature' | 'questions' | 'tasks'>;
}

function full(s: Omit<FeatureSummary, 'stage' | 'waiting_on_you'> & Partial<FeatureFull>): FeatureFull {
  return {
    spec: '', worktree_path: null, current_task_id: null, adr: null, glossary_terms: [], estimate: null, tokens_in: 0, tokens_out: 0,
    tool_calls: 0, diff_stats: null, merged_commit: null, paused: false,
    stage: 'plan', waiting_on_you: false,
    ...s,
  } as FeatureFull;
}

const emptyDetail = (): Store['detail'] => ({ acceptance: null, findings: [], ci_runs: [], spend_by_agent: [], checklist: [] });

// ---------------------------------------------------------------- features
const features: Store[] = [];

// 1 · Rate limiting — building
features.push({
  feature: full({
    id: 1, project_id: 1, title: 'Rate limiting for public API', status: 'building', stages: ['done', 'run', 'pend', 'pend', 'pend'],
    stage_text: 'Build · task 4 of 7 · SWE ⇄ Tester', branch: 'feat/rate-limit', pr_number: null, pr_url: null, tasks_done: 3, tasks_total: 7,
    elapsed_seconds: 2 * 3600 + 14 * 60, cost_usd: 6.8, created_at: ago(134), updated_at: ago(1),
    spec: 'Limit public API requests per API key, per plan. Return 429 with Retry-After when a client goes over. Limits must hold across deploys and multiple instances.',
    worktree_path: '/Users/you/code/orbit-api-rate-limit', current_task_id: 104,
    adr: { title: 'Sliding-window limiter backed by Redis', body: 'Counters live in Redis so every instance shares one view of usage. A sliding window avoids bursts at window edges.' },
    glossary_terms: ['RateLimitPolicy'], estimate: { hours_min: 3, hours_max: 5, cost_min: 9, cost_max: 14, files: 12 },
    tokens_in: 1_900_000, tokens_out: 212_000, tool_calls: 346, diff_stats: { files: 5, additions: 274, deletions: 7 },
  }),
  questions: [
    { id: 11, question: 'Should limits be per API key or per account?', answer: 'Per API key, with plan defaults.' },
    { id: 12, question: 'What should happen when Redis is down?', answer: 'Fail open and log a warning.' },
  ],
  tasks: [
    task(101, 1, 'Limits config per plan', 'Free, Team and Enterprise limits live in config.', 'backend · no deps', ['Defaults per plan', 'Override via env'], 'committed'),
    task(102, 2, 'Sliding-window counter', 'Redis sorted-set counter per key.', 'backend · needs 01', ['Accurate within 1%'], 'committed', { attempts: 2 }),
    task(103, 3, '429 response format', 'JSON body explains the limit and reset time.', 'api · needs 02', ['Matches error schema'], 'committed'),
    task(104, 4, 'Limiter state survives deploys', 'Window start persists in Redis; nothing in process memory.', 'backend · needs 02', ['Burst after redeploy is still limited', '429 has Retry-After'], 'running', { attempts: 2 }),
    task(105, 5, 'Per-key overrides', 'Admins can raise the limit for one key.', 'api · needs 04', ['Audit-logged'], 'pending'),
    task(106, 6, 'Admin usage view', 'Usage per key over the last 24 hours.', 'ui · needs 05', ['Works at phone width'], 'pending'),
    task(107, 7, 'Load test e2e', 'k6 script proves limits under load.', 'tests · needs 04–06', ['p95 under 20 ms overhead'], 'pending'),
  ],
  detail: { ...emptyDetail(), spend_by_agent: [
    { agent: 'product_architect', model: 'fable', cost_usd: 0.9 },
    { agent: 'software_engineer', model: 'opus', cost_usd: 3.1 },
    { agent: 'tester', model: 'sonnet', cost_usd: 2.8 },
  ] },
});

// 2 · SSO — awaiting plan approval
features.push({
  feature: full({
    id: 2, project_id: 1, title: 'SSO with Google Workspace', status: 'awaiting_plan_approval', stages: ['wait', 'pend', 'pend', 'pend', 'pend'],
    stage_text: 'Plan · waiting for your approval', branch: null, pr_number: null, pr_url: null, tasks_done: 0, tasks_total: 6,
    elapsed_seconds: 18 * 60, cost_usd: 1.1, created_at: ago(70), updated_at: ago(58),
    spec: 'Let users sign in with their Google Workspace account. Admins can require SSO for their whole organization. Keep email and password for everyone else.',
    adr: {
      title: 'Identity through an OIDC provider interface',
      body: 'Google is the first implementation of an IdentityProvider interface, so Microsoft can be added later without touching the callback. Sessions stay server-side.\n\nLogin page → /auth/google → Google OIDC → /auth/callback → users · org_settings',
    },
    glossary_terms: ['IdentityProvider', 'SsoPolicy'], estimate: { hours_min: 4, hours_max: 6, cost_min: 9, cost_max: 14, files: 16 },
    tokens_in: 240_000, tokens_out: 31_000, tool_calls: 42,
  }),
  questions: [
    { id: 21, question: 'What happens to a password account when its org turns on required SSO?', answer: 'It links by email on the next Google sign-in; the password stops working.' },
    { id: 22, question: 'Should we support other identity providers now?', answer: 'Google only, but design it so Microsoft can be added later.' },
    { id: 23, question: 'Who can turn on required SSO?', answer: 'Org owners only.' },
  ],
  tasks: [
    task(201, 1, 'Google OIDC client and config', 'Client ID and secret come from env; the discovery document is cached.', 'backend · no deps', ['No secrets in code or logs', 'Startup fails clearly if config is missing'], 'pending'),
    task(202, 2, 'Sign in with Google button', 'Shown on the login page; hidden when SSO is turned off.', 'ui · needs 01', ['Button follows Google branding rules', 'Keyboard and screen-reader accessible', 'Works at phone width'], 'pending'),
    task(203, 3, 'Callback and account linking', 'Links to an existing user by verified email, or creates a new one.', 'api · needs 01', ['Rejects unverified emails', 'State and nonce checked on every callback'], 'pending'),
    task(204, 4, 'Org setting: require SSO', 'Only org owners can turn it on; every change is audit-logged.', 'api · needs 03', ['Non-owners get 403', 'Audit entry names who changed it'], 'pending'),
    task(205, 5, 'Block password login when required', 'Users see a clear message with a link to sign in with Google.', 'ui · needs 04', ['Password reset also blocked for those users'], 'pending'),
    task(206, 6, 'End-to-end: sign in, link, enforce', 'Runs against a mock identity provider in CI.', 'tests · needs 02–05', ['Covers new user, linked user and blocked password login'], 'pending'),
  ],
  detail: { ...emptyDetail(), spend_by_agent: [{ agent: 'product_architect', model: 'fable', cost_usd: 1.1 }] },
});

// 3 · Invoice PDF — awaiting merge
const invoiceRuns: CIRun[] = [
  {
    id: 31, run_id: '322', status: 'success', failing_job: null, failing_log: null, diagnosis: null, created_at: ago(75),
    jobs: [
      { name: 'lint', conclusion: 'success', duration_seconds: 21 }, { name: 'unit', conclusion: 'success', duration_seconds: 66 },
      { name: 'integration', conclusion: 'success', duration_seconds: 98 }, { name: 'e2e-chromium', conclusion: 'success', duration_seconds: 131 },
      { name: 'e2e-webkit', conclusion: 'success', duration_seconds: 170 }, { name: 'build', conclusion: 'success', duration_seconds: 55 },
    ],
  },
];
features.push({
  feature: full({
    id: 3, project_id: 1, title: 'Invoice PDF export', status: 'awaiting_merge', stages: ['done', 'done', 'done', 'done', 'wait'],
    stage_text: 'Merge · PR #42 ready', branch: 'feat/invoice-pdf', pr_number: 42, pr_url: 'https://github.com/acme/orbit-api/pull/42',
    tasks_done: 6, tasks_total: 6, elapsed_seconds: 5 * 3600 + 2 * 60, cost_usd: 11.4, created_at: ago(400), updated_at: ago(60),
    spec: 'Customers can download any invoice as a PDF from the billing page and from the invoice email.',
    worktree_path: '/Users/you/code/orbit-api-invoice-pdf', glossary_terms: ['Invoice'],
    estimate: { hours_min: 4, hours_max: 6, cost_min: 8, cost_max: 12, files: 10 },
    tokens_in: 3_100_000, tokens_out: 350_000, tool_calls: 512, diff_stats: { files: 12, additions: 684, deletions: 91 },
  }),
  questions: [{ id: 31, question: 'Which currencies must be supported?', answer: 'EUR, USD and MAD.' }],
  tasks: [
    task(301, 1, 'PDF renderer service', 'Render invoice HTML to PDF with WeasyPrint.', 'backend · no deps', ['Fonts embedded'], 'committed', { attempts: 2 }),
    task(302, 2, 'Totals and VAT per currency', 'Reuse the billing totals module.', 'backend · needs 01', ['EUR, USD, MAD correct'], 'committed', { attempts: 2 }),
    task(303, 3, 'Download endpoint', 'GET /invoices/{id}/pdf streams the file.', 'api · needs 01', ['File named invoice-{number}.pdf'], 'committed'),
    task(304, 4, 'Billing page button', 'Download button on each invoice row.', 'ui · needs 03', ['Works at phone width'], 'committed'),
    task(305, 5, 'Email link', 'Invoice email links to the PDF.', 'api · needs 03', ['Signed link expires in 7 days'], 'committed'),
    task(306, 6, 'Check invoice ownership on download', 'Rollup from PR review round 1.', 'rollup · round 1', ['Other accounts get 404'], 'committed', { kind: 'rollup', commit_sha: 'a3f9e1c' }),
  ],
  detail: {
    acceptance: {
      verdict: 'ACCEPT',
      summary: 'Checked as a customer: the PDF matches the invoice page, totals are right in three currencies, and the download works from the email link.',
      criteria: [
        { text: 'PDF matches the on-screen invoice', met: true },
        { text: 'Totals and VAT right in EUR, USD, MAD', met: true },
        { text: 'File named invoice-{number}.pdf', met: true },
        { text: 'Works at phone width', met: true },
      ],
      issues: [],
    },
    findings: [
      { id: 1, round: 1, severity: 'Blocker', file: 'api/invoices/pdf.py', line: 48, text: 'Returns any invoice by ID without checking it belongs to the signed-in account.', status: 'fixed' },
      { id: 2, round: 2, severity: 'Nit', file: 'templates/invoice.html', line: 112, text: 'Label says “Bill”; the glossary term is “Invoice”.', status: 'noted' },
      { id: 3, round: 2, severity: 'Nit', file: 'api/invoices/pdf.py', line: 30, text: 'Font path is hard-coded; read it from config.', status: 'noted' },
      { id: 4, round: 2, severity: 'Nit', file: 'tests/test_pdf.py', line: 9, text: 'Fixture name test_data is vague; prefer three_currency_invoices.', status: 'noted' },
    ],
    ci_runs: invoiceRuns,
    spend_by_agent: [
      { agent: 'product_architect', model: 'fable', cost_usd: 2.2 }, { agent: 'software_engineer', model: 'opus', cost_usd: 5.9 },
      { agent: 'tester', model: 'sonnet', cost_usd: 1.4 }, { agent: 'pr_reviewer', model: 'fable', cost_usd: 1.9 },
    ],
    checklist: [
      { title: 'Plan approved by you', sub: 'Gate 1 · 5 tasks · 1 ADR', ok: true, link: 'plan' },
      { title: 'All tasks committed', sub: '6 of 6 · each passed the Tester', ok: true, link: 'live' },
      { title: 'Product Architect accepted', sub: 'Checked as a customer, 4 of 4 criteria met', ok: true, link: 'review' },
      { title: 'PR Reviewer: 0 open blockers', sub: '1 blocker fixed in round 1 · 3 nits', ok: true, link: 'review' },
      { title: 'CI green', sub: 'Run #322 · 6 of 6 jobs passed', ok: true, link: 'ci' },
      { title: 'Separation of duties', sub: 'Code by the SWE; judged by Tester, Architect and Reviewer', ok: true, link: 'live' },
      { title: 'Protected checks untouched', sub: 'No agent changed .github/ or test config', ok: true, link: 'merge' },
    ],
  },
});

// 4 · Flaky checkout — CI red
features.push({
  feature: full({
    id: 4, project_id: 1, title: 'Fix flaky checkout test', status: 'ci', stages: ['done', 'done', 'done', 'fail', 'pend'],
    stage_text: 'CI red · On-Call diagnosing', branch: 'fix/checkout-flake', pr_number: 44, pr_url: 'https://github.com/acme/orbit-api/pull/44',
    tasks_done: 2, tasks_total: 3, elapsed_seconds: 3600 + 37 * 60, cost_usd: 3.9, created_at: ago(120), updated_at: ago(24),
    spec: 'The checkout e2e test fails about once in ten runs. Make it reliable without slowing the suite.',
    worktree_path: '/Users/you/code/orbit-api-checkout-flake', current_task_id: 403,
    tokens_in: 820_000, tokens_out: 90_000, tool_calls: 141, diff_stats: { files: 4, additions: 58, deletions: 22 },
  }),
  questions: [],
  tasks: [
    task(401, 1, 'Stabilise test data', 'Seed a fixed cart per test.', 'tests · no deps', ['No shared state between tests'], 'committed'),
    task(402, 2, 'Wait for coupon before enabling Pay', 'Pay stays disabled until the coupon request returns.', 'ui · needs 01', ['No race on slow networks'], 'committed', { commit_sha: '7c21d04' }),
    task(403, 3, 'Fix: wait for coupon in the e2e test', 'Wait for the coupon response in the test, and add WebKit to the local end-to-end set.', 'fix · from CI #318', ['Passes on WebKit 20 runs in a row'], 'running', { kind: 'fix' }),
  ],
  detail: {
    ...emptyDetail(),
    acceptance: { verdict: 'ACCEPT', summary: 'Checkout passes reliably in local runs.', criteria: [{ text: 'Checkout test passes 50 runs in a row', met: true }], issues: [] },
    findings: [{ id: 41, round: 1, severity: 'Nit', file: 'tests/e2e/checkout.spec.ts', line: 12, text: 'Prefer getByRole over CSS selectors.', status: 'noted' }],
    ci_runs: [
      {
        id: 43, run_id: '318', status: 'failure', failing_job: 'e2e-webkit', created_at: ago(26),
        failing_log: [
          'Running 18 tests using 2 workers · project webkit',
          '✓ checkout.spec.ts › pays with saved card (2.1s)',
          '✗ checkout.spec.ts › applies coupon then pays (30.0s)',
          "    TimeoutError: locator.click: Timeout 30000ms exceeded",
          "    waiting for getByRole('button', { name: 'Pay' }) to be enabled",
          '    at tests/e2e/checkout.spec.ts:57',
          '17 passed, 1 failed',
        ].join('\n'),
        diagnosis: {
          root_cause: 'The Pay button stays disabled until the coupon request returns. On slower WebKit runners the test clicks before that, then waits until it times out.',
          responsible_task: '002 Wait for coupon before enabling Pay · commit 7c21d04',
          why_missed: 'Local tests ran on Chromium only. CI is the first place WebKit runs.',
          fix_task: 'Wait for the coupon response in the test, and add WebKit to the local end-to-end set.',
        },
        jobs: [
          { name: 'lint', conclusion: 'success', duration_seconds: 22 }, { name: 'unit', conclusion: 'success', duration_seconds: 64 },
          { name: 'integration', conclusion: 'success', duration_seconds: 101 }, { name: 'e2e-chromium', conclusion: 'success', duration_seconds: 132 },
          { name: 'e2e-webkit', conclusion: 'failure', duration_seconds: 232 }, { name: 'build', conclusion: 'success', duration_seconds: 58 },
        ],
      },
      { id: 42, run_id: '311', status: 'success', failing_job: null, failing_log: null, diagnosis: null, created_at: ago(70), jobs: [{ name: 'lint', conclusion: 'success', duration_seconds: 20 }, { name: 'unit', conclusion: 'success', duration_seconds: 60 }] },
      { id: 41, run_id: '305', status: 'success', failing_job: null, failing_log: null, diagnosis: null, created_at: ago(100), jobs: [{ name: 'lint', conclusion: 'success', duration_seconds: 19 }] },
    ],
    spend_by_agent: [
      { agent: 'software_engineer', model: 'opus', cost_usd: 2.1 }, { agent: 'tester', model: 'sonnet', cost_usd: 0.6 },
      { agent: 'pr_reviewer', model: 'fable', cost_usd: 0.9 }, { agent: 'oncall_engineer', model: 'sonnet', cost_usd: 0.3 },
    ],
  },
});

// 5 · Audit log export — merged
features.push({
  feature: full({
    id: 5, project_id: 1, title: 'Audit log export', status: 'merged', stages: ['done', 'done', 'done', 'done', 'done'],
    stage_text: 'Merged yesterday', branch: 'feat/audit-log-export', pr_number: 39, pr_url: 'https://github.com/acme/orbit-api/pull/39',
    tasks_done: 4, tasks_total: 4, elapsed_seconds: 3 * 3600 + 48 * 60, cost_usd: 8.2, created_at: ago(60 * 30), updated_at: ago(60 * 24),
    spec: 'Org owners can export the audit log as CSV for a date range.', merged_commit: '5be81f0',
    diff_stats: { files: 9, additions: 402, deletions: 38 }, tokens_in: 2_000_000, tokens_out: 240_000, tool_calls: 300,
  }),
  questions: [],
  tasks: [
    task(501, 1, 'CSV writer', 'Streams rows.', 'backend', [], 'committed'), task(502, 2, 'Export endpoint', 'Date range filter.', 'api', [], 'committed'),
    task(503, 3, 'Export button', 'In audit log page.', 'ui', [], 'committed'), task(504, 4, 'E2E export test', 'Checks CSV columns.', 'tests', [], 'committed'),
  ],
  detail: {
    ...emptyDetail(),
    acceptance: { verdict: 'ACCEPT', summary: 'Export opens cleanly in Excel and Numbers.', criteria: [{ text: 'CSV opens in Excel', met: true }], issues: [] },
    ci_runs: [{ id: 51, run_id: '301', status: 'success', jobs: [{ name: 'lint', conclusion: 'success', duration_seconds: 20 }, { name: 'unit', conclusion: 'success', duration_seconds: 61 }], failing_job: null, failing_log: null, diagnosis: null, created_at: ago(60 * 25) }],
    checklist: [{ title: 'Plan approved by you', sub: 'Gate 1', ok: true, link: 'plan' }, { title: 'CI green', sub: 'Run #301', ok: true, link: 'ci' }],
  },
});

// 6 · billing-web · Webhook retries — awaiting answers
features.push({
  feature: full({
    id: 6, project_id: 2, title: 'Webhook retries with backoff', status: 'awaiting_answers', stages: ['wait', 'pend', 'pend', 'pend', 'pend'],
    stage_text: 'Plan · 3 questions for you', branch: null, pr_number: null, pr_url: null, tasks_done: 0, tasks_total: 0,
    elapsed_seconds: 6 * 60, cost_usd: 0.4, created_at: ago(9), updated_at: ago(3),
    spec: 'Retry failed outgoing webhooks with exponential backoff. Merchants can see each attempt and replay a delivery by hand.',
  }),
  questions: [
    { id: 61, question: 'How many attempts before a delivery is marked failed?', answer: null },
    { id: 62, question: 'Should a replay by hand reset the retry schedule, or count as one more attempt?', answer: null },
    { id: 63, question: 'Do merchants need an email when a webhook endpoint keeps failing?', answer: null },
  ],
  tasks: [],
  detail: { ...emptyDetail(), spend_by_agent: [{ agent: 'product_architect', model: 'fable', cost_usd: 0.4 }] },
});

if (empty) features.length = 0;

// ---------------------------------------------------------------- events
const events: Event[] = [];
function ev(feature_id: number | null, minAgo: number, agent: AgentKey, kind: EventKind, message: string, data: Record<string, unknown> = {}, task_id: number | null = null): Event {
  const e: Event = { id: nextId(), feature_id, task_id, ts: ago(minAgo), agent, kind, message, data };
  events.push(e);
  return e;
}
const sec = (m: number, s: number) => m + s / 60;

if (!empty) {
  // feature 1 history
  ev(1, 134, 'human', 'status', 'Spec submitted');
  ev(1, 128, 'product_architect', 'status', 'Asked 2 questions about scope');
  ev(1, 124, 'product_architect', 'gate', 'Plan ready: Rate limiting for public API', { detail: '7 tasks · 1 ADR' });
  ev(1, 120, 'human', 'gate', 'Plan approved', { detail: 'Gate 1' });
  ev(1, 119, 'product_architect', 'status', 'Turned your spec into 7 tasks and ADR-0006. You approved the plan.');
  ev(1, 110, 'software_engineer', 'handoff', 'Task 001 ready for the Tester', { attempt: 1 }, 101);
  ev(1, 104, 'tester', 'verdict', 'Task 001 passed 12 of 12', { verdict: 'PASS' }, 101);
  ev(1, 95, 'software_engineer', 'handoff', 'Task 002 ready for the Tester', { attempt: 1 }, 102);
  ev(1, 90, 'tester', 'verdict', 'Task 002 failed: counter drifts at window edges', { verdict: 'FAIL' }, 102);
  ev(1, 82, 'tester', 'verdict', 'Task 002 passed 18 of 18', { verdict: 'PASS' }, 102);
  ev(1, 66, 'tester', 'verdict', 'Task 003 passed 22 of 22', { verdict: 'PASS' }, 103);
  ev(1, sec(30, 0), 'software_engineer', 'handoff', 'Moved counters from memory to Redis with a sliding window. +142 −8 across 4 files.', { attempt: 1, detail: 'attempt 1' }, 104);
  ev(1, sec(19, 0), 'software_engineer', 'log', 'handoff → Tester: task 004 ready for review', {}, 104);
  ev(1, sec(5, 30), 'tester', 'tool', 'run  uv run pytest  → 29 passed, 2 failed', {}, 104);
  ev(1, sec(5, 9), 'tester', 'log', 'FAIL tests/test_rate_limit.py::test_429_has_retry_after', {}, 104);
  ev(1, sec(5, 2), 'tester', 'log', 'FAIL tests/e2e/test_burst.py::test_limit_survives_redeploy', {}, 104);
  ev(1, 5, 'tester', 'verdict', '29 of 31 tests pass. After a redeploy the window resets and a burst of 120 requests gets through; 429 responses are missing Retry-After.', { verdict: 'FAIL', detail: 'limiter resets on redeploy', tests_passed: 29, tests_total: 31 }, 104);
  ev(1, sec(2, 0), 'software_engineer', 'status', 'Fixing 2 failing tests on task 004', { attempt: 2, detail: 'attempt 2' }, 104);
  ev(1, sec(1, 52), 'software_engineer', 'tool', 'read tasks/004-survive-deploys.md (Tester report appended)', {}, 104);
  ev(1, sec(1, 45), 'software_engineer', 'tool', 'edit src/middleware/rate_limit.py  +18 −4', { path: 'src/middleware/rate_limit.py', additions: 18, deletions: 4 }, 104);
  ev(1, sec(1, 20), 'software_engineer', 'tool', 'run  uv run pytest tests/test_rate_limit.py  → 9 passed', {}, 104);
  ev(1, sec(1, 5), 'software_engineer', 'log', 'Persisting the window start in Redis and adding Retry-After to 429 responses.', {}, 104);
  // file stats (aggregated by the Live page from tool events with data.path)
  ev(1, 100, 'software_engineer', 'tool', 'edit src/middleware/rate_limit.py  +78 −0', { path: 'src/middleware/rate_limit.py', additions: 78, deletions: 0 }, 102);
  ev(1, 99, 'software_engineer', 'tool', 'edit src/config/limits.py  +31 −2', { path: 'src/config/limits.py', additions: 31, deletions: 2 }, 101);
  ev(1, 98, 'software_engineer', 'tool', 'edit tests/test_rate_limit.py  +77 −0', { path: 'tests/test_rate_limit.py', additions: 77, deletions: 0 }, 102);
  ev(1, 31, 'software_engineer', 'tool', 'edit tests/e2e/test_burst.py  +64 −0', { path: 'tests/e2e/test_burst.py', additions: 64, deletions: 0 }, 104);
  ev(1, 31, 'software_engineer', 'tool', 'edit docker-compose.yml  +6 −1', { path: 'docker-compose.yml', additions: 6, deletions: 1 }, 104);

  // feature 2
  ev(2, 70, 'human', 'status', 'Spec submitted');
  ev(2, 66, 'product_architect', 'status', 'Asked 3 questions about SSO scope');
  ev(2, 62, 'human', 'status', 'Answered 3 questions');
  ev(2, 58, 'product_architect', 'gate', 'Plan ready: SSO with Google Workspace', { detail: '6 tasks · 1 ADR' });

  // feature 3
  ev(3, 180, 'pr_reviewer', 'verdict', 'Round 1 · 1 blocker, 0 nits', { verdict: 'BLOCKERS', round: 1 });
  ev(3, 150, 'software_engineer', 'handoff', 'Rollup task 006 fixed', {}, 306);
  ev(3, 140, 'tester', 'verdict', 'Rollup 006 passed 44 of 44', { verdict: 'PASS' }, 306);
  ev(3, 60, 'pr_reviewer', 'verdict', 'PR #42 reviewed · 0 blockers', { verdict: 'APPROVE', round: 2, detail: '3 nits for you' });
  ev(3, 59, 'system', 'gate', 'PR #42 ready to merge', { detail: 'Gate 2' });

  // feature 4
  ev(4, 26, 'oncall_engineer', 'error', 'CI red on fix/checkout-flake', { detail: 'reading e2e-webkit logs' });
  ev(4, 22, 'oncall_engineer', 'handoff', 'Fix task 003 handed to the SWE', { detail: 'root cause found' }, 403);

  // feature 5
  ev(5, 60 * 24, 'human', 'status', 'Merged #39 Audit log export', { detail: 'squash merge' });

  // feature 6
  ev(6, 9, 'human', 'status', 'Spec submitted');
  ev(6, 3, 'product_architect', 'gate', 'Questions ready: Webhook retries with backoff', { detail: '3 questions' });
}

// ---------------------------------------------------------------- derived views
const stageOf = (s: FeatureStatus, prev: FeatureFull['stage']): FeatureFull['stage'] => {
  if (['grilling', 'awaiting_answers', 'grooming', 'awaiting_plan_approval'].includes(s)) return 'plan';
  if (s === 'building') return 'build';
  if (s === 'accepting' || s === 'reviewing') return 'verify';
  if (s === 'ci') return 'ci';
  if (s === 'awaiting_merge' || s === 'merged') return 'merge';
  return prev;
};

function sync(st: Store) {
  const f = st.feature;
  f.stage = stageOf(f.status, f.stage);
  f.waiting_on_you = ['awaiting_answers', 'awaiting_plan_approval', 'awaiting_merge'].includes(f.status);
  f.tasks_total = st.tasks.length;
  f.tasks_done = st.tasks.filter((t) => t.status === 'committed').length;
}
features.forEach(sync);

function summary(st: Store): FeatureSummary {
  const f = st.feature;
  return {
    id: f.id, project_id: f.project_id, title: f.title, status: f.status, stage: f.stage, stages: [...f.stages], stage_text: f.stage_text,
    branch: f.branch, pr_number: f.pr_number, pr_url: f.pr_url, tasks_done: f.tasks_done, tasks_total: f.tasks_total,
    elapsed_seconds: f.elapsed_seconds, cost_usd: f.cost_usd, waiting_on_you: f.waiting_on_you, created_at: f.created_at, updated_at: f.updated_at,
  };
}

function detail(st: Store): FeatureDetail {
  return JSON.parse(JSON.stringify({ feature: st.feature, questions: st.questions, tasks: st.tasks, ...st.detail })) as FeatureDetail;
}

function boardCells(st: Store): StageState[] {
  const f = st.feature;
  if (f.stage === 'plan') return Array.from({ length: Math.max(st.tasks.length, 1) }, () => (f.waiting_on_you ? 'wait' : 'run'));
  return st.tasks.map((t) => {
    if (t.status === 'committed') return 'done';
    if (t.status === 'failed') return 'fail';
    if (t.kind === 'fix' && f.stages[3] === 'fail') return 'fail';
    if (t.status === 'running' || t.status === 'testing') return f.status === 'paused' ? 'wait' : 'run';
    return 'pend';
  });
}

function boardSummary(st: Store): string {
  const f = st.feature;
  if (f.stage === 'plan') return 'plan';
  if (f.status === 'merged') return 'merged';
  if (f.status === 'ci' && f.stages[3] === 'fail') return 'CI red';
  return `${f.tasks_done}/${f.tasks_total}`;
}

function agentCards(list: Store[]): AgentCard[] {
  const by = (s: FeatureStatus) => list.find((x) => x.feature.status === s);
  const building = by('building');
  const planWait = by('awaiting_plan_approval') ?? by('awaiting_answers');
  const ciFail = list.find((x) => x.feature.status === 'ci' && x.feature.stages[3] === 'fail');
  const reviewing = by('reviewing');
  const cur = building?.tasks.find((t) => t.id === building.feature.current_task_id);
  const m = settings.models;
  return [
    {
      key: 'product_architect', name: 'Product Architect', model: m.product_architect, state: planWait ? 'waiting' : by('grooming') || by('grilling') || by('accepting') ? 'working' : 'idle',
      job: planWait ? `${planWait.feature.title} ${planWait.feature.status === 'awaiting_answers' ? 'has questions for you' : 'plan is ready for Gate 1'}` : 'Last: plan for Rate limiting', context_pct: 38, spend_usd: 9.4, feature_id: planWait?.feature.id ?? null,
    },
    {
      key: 'software_engineer', name: 'Software Engineer', model: m.software_engineer, state: building && cur?.status === 'running' ? 'working' : 'idle',
      job: cur ? `Task ${String(cur.seq).padStart(3, '0')} · ${cur.title.toLowerCase()}` : 'Idle', context_pct: 71, spend_usd: 18.6, feature_id: building?.feature.id ?? null,
    },
    {
      key: 'tester', name: 'Tester', model: m.tester, state: building ? (cur?.status === 'testing' ? 'working' : 'queued') : 'idle',
      job: cur ? `Re-checks task ${String(cur.seq).padStart(3, '0')} after hand-off` : 'Idle', context_pct: 22, spend_usd: 4.3, feature_id: building?.feature.id ?? null,
    },
    { key: 'pr_reviewer', name: 'PR Reviewer', model: m.pr_reviewer, state: reviewing ? 'working' : 'idle', job: 'Last: PR #42 · 0 blockers', context_pct: 0, spend_usd: 7.1, feature_id: reviewing?.feature.id ?? null },
    {
      key: 'oncall_engineer', name: 'On-Call Engineer', model: m.oncall_engineer, state: ciFail ? 'working' : 'idle',
      job: ciFail ? `CI run #${ciFail.detail.ci_runs[0]?.run_id} · ${ciFail.detail.ci_runs[0]?.failing_job}` : 'All CI green', context_pct: 46, spend_usd: 1.8, feature_id: ciFail?.feature.id ?? null,
    },
  ];
}

function overview(projectId: number | null): Overview {
  const list = features.filter((s) => projectId == null || s.feature.project_id === projectId).sort((a, b) => b.feature.id - a.feature.id);
  const ordered = [...list].sort((a, b) => a.feature.id - b.feature.id);
  const ids = new Set(list.map((s) => s.feature.id));
  const spend = list.reduce((a, s) => a + s.feature.cost_usd, 0) + (projectId === 1 ? 0 : 0);
  const total = Math.round(spend * 100) / 100 || 0;
  return {
    kpis: {
      in_flight: list.filter((s) => !['plan', 'merge'].includes(s.feature.stage) || s.feature.status === 'awaiting_merge').length,
      waiting_on_you: list.filter((s) => s.feature.waiting_on_you).length,
      committed_7d: list.reduce((a, s) => a + s.tasks.filter((t) => t.status === 'committed').length, 0),
      first_try_pass_pct: 77, first_try_pass_num: 10,
      ci_failing: list.filter((s) => s.feature.stages[3] === 'fail').length,
      spend_7d_usd: total, budget_usd: settings.budget_usd_week,
    },
    board: ordered.map((s) => ({ feature_id: s.feature.id, title: s.feature.title, cells: boardCells(s), summary: boardSummary(s) })),
    spend: {
      total_usd: total, wow_pct: list.length ? 8.2 : null,
      by_model: list.length
        ? [
            { model: 'fable', agents: 'planner, reviewer', usd: +(total * 0.4).toFixed(2), pct: 40 },
            { model: 'opus', agents: 'engineer', usd: +(total * 0.45).toFixed(2), pct: 45 },
            { model: 'sonnet', agents: 'tester, on-call', usd: +(total * 0.15).toFixed(2), pct: 15 },
          ]
        : [],
      projected_usd: +(total * 1.26).toFixed(2), budget_used_pct: Math.round((total / settings.budget_usd_week) * 100),
    },
    trends: list.length
      ? [
          { key: 'lead_time', label: 'Lead time · spec to PR', value: '4h 52m', delta: '−12%', good: true, points: [0.7, 0.75, 0.6, 0.65, 0.55, 0.6, 0.5, 0.45, 0.5, 0.42, 0.38, 0.4] },
          { key: 'loops_per_task', label: 'SWE ⇄ Tester loops per task', value: '1.4', delta: '−0.3', good: true, points: [0.6, 0.7, 0.65, 0.8, 0.6, 0.55, 0.62, 0.5, 0.45, 0.48, 0.4, 0.36] },
          { key: 'blockers_per_pr', label: 'Review blockers per PR', value: '0.6', delta: '+0.2', good: false, points: [0.2, 0.25, 0.2, 0.3, 0.28, 0.35, 0.3, 0.42, 0.38, 0.5, 0.45, 0.55] },
        ]
      : [],
    features: ordered.map(summary),
    agents: agentCards(list),
    activity: events
      .filter((e) => {
        if (e.feature_id == null || !ids.has(e.feature_id)) return false;
        if (!['status', 'handoff', 'verdict', 'gate', 'error'].includes(e.kind)) return false;
        return e.agent !== 'human' || e.message.startsWith('Merged');
      })
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts) || b.id - a.id)
      .slice(0, 8),
  };
}

// ---------------------------------------------------------------- stream
let emit: ((m: WsMessage) => void) | null = null;
function push(e: Omit<Event, 'id' | 'ts'> & { ts?: string }) {
  const full: Event = { id: nextId(), ts: e.ts ?? iso(Date.now()), ...e } as Event;
  events.push(full);
  emit?.({ type: 'event', event: full });
  return full;
}
function touch(st: Store) {
  st.feature.updated_at = iso(Date.now());
  sync(st);
  emit?.({ type: 'feature', feature: summary(st) });
}
function later(ms: number, fn: () => void) {
  window.setTimeout(fn, ms);
}

const script: [AgentKey, EventKind, string][] = [
  ['software_engineer', 'tool', 'edit src/middleware/rate_limit.py  +6 −2'],
  ['software_engineer', 'tool', 'run  uv run pytest tests/test_rate_limit.py -k retry_after  → 3 passed'],
  ['software_engineer', 'log', 'Retry-After now uses the window reset time, rounded up to whole seconds'],
  ['software_engineer', 'tool', 'read src/middleware/redis_store.py'],
  ['software_engineer', 'tool', 'edit src/middleware/redis_store.py  +12 −0'],
  ['software_engineer', 'tool', 'run  docker compose restart api && uv run pytest tests/e2e/test_burst.py  → 1 passed'],
  ['software_engineer', 'log', 'Window start survives the restart; burst of 120 now gets 100 × 200 and 20 × 429'],
];
let scriptIdx = 0;

export function startMockStream(dispatch: (m: WsMessage) => void): () => void {
  emit = dispatch;
  dispatch({ type: 'hello', version: '0.1.0-mock' });
  const timer = window.setInterval(() => {
    const st = features.find((s) => s.feature.status === 'building' && !s.feature.paused);
    if (!st) return;
    const [agent, kind, message] = script[scriptIdx % script.length];
    scriptIdx++;
    push({ feature_id: st.feature.id, task_id: st.feature.current_task_id, agent, kind, message, data: {} });
    st.feature.cost_usd = Math.round((st.feature.cost_usd + 0.03) * 100) / 100;
    st.feature.elapsed_seconds += 4;
    st.feature.tool_calls += kind === 'tool' ? 1 : 0;
    if (scriptIdx % 3 === 0) touch(st);
  }, 4000);
  return () => {
    window.clearInterval(timer);
    emit = null;
  };
}

// ---------------------------------------------------------------- request router
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function get(id: number): Store {
  const st = features.find((s) => s.feature.id === id);
  if (!st) throw new ApiError(404, `Feature ${id} not found`);
  return st;
}
function expect(st: Store, ...allowed: FeatureStatus[]) {
  if (!allowed.includes(st.feature.status)) throw new ApiError(409, `Not allowed while the feature is ${st.feature.status.replace(/_/g, ' ')}`);
}

function startBuilding(st: Store) {
  const f = st.feature;
  f.status = 'building';
  f.stages = ['done', 'run', 'pend', 'pend', 'pend'];
  f.branch = f.branch ?? 'feat/' + f.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
  f.worktree_path = f.worktree_path ?? `/Users/you/code/${f.branch.replace('/', '-')}`;
  const next = st.tasks.find((t) => t.status !== 'committed');
  if (next) {
    next.status = 'running';
    next.attempts = Math.max(1, next.attempts);
    f.current_task_id = next.id;
    f.stage_text = `Build · task ${next.seq} of ${st.tasks.length} · SWE ⇄ Tester`;
  }
}

export async function mockRequest(method: string, rawPath: string, body: unknown): Promise<unknown> {
  await delay(120);
  const [path, query] = rawPath.split('?');
  const q = new URLSearchParams(query ?? '');
  const b = (body ?? {}) as Record<string, unknown>;
  const parts = path.split('/').filter(Boolean);

  if (path === '/health') return { ok: true, version: '0.1.0-mock' };
  if (path === '/projects' && method === 'GET') return projects;
  if (path === '/projects' && method === 'POST') {
    const repo = String(b.repo_path ?? '');
    if (!repo.startsWith('/')) throw new ApiError(400, 'repo_path must be an absolute path to a git repository');
    const p: Project = { id: nextId(), name: String(b.name || repo.split('/').pop()), repo_path: repo, default_branch: 'main', github_repo: (b.github_repo as string) || null, created_at: iso(Date.now()) };
    projects = [...projects, p];
    return p;
  }
  if (parts[0] === 'projects' && method === 'DELETE') {
    projects = projects.filter((p) => p.id !== Number(parts[1]));
    return { ok: true };
  }
  if (path === '/overview') return overview(q.get('project_id') ? Number(q.get('project_id')) : null);
  if (path.startsWith('/claude-usage')) {
    const t = Date.now() / 1000;
    return {
      limits: [
        { kind: 'five_hour', label: 'Current session', used_pct: 34, status: 'allowed', resets_at: t + 2.2 * 3600, seen_at: t - 60, source: 'claude_code' },
        { kind: 'seven_day', label: 'All models', used_pct: 62, status: 'allowed', resets_at: t + 3.5 * 86400, seen_at: t - 60, source: 'claude_code' },
      ],
      updated_at: t - 60,
      daily: [3, 9, 0, 14, 11, 17, 8].map((v, i) => ({ date: new Date(Date.now() - (6 - i) * 86400000).toISOString().slice(0, 10), weekly_pct: v })),
      statusline_connected: false,
    };
  }
  if (path.startsWith('/models') && method === 'GET')
    return {
      source: 'builtin',
      fetched_at: Date.now() / 1000,
      models: [
        { id: 'fable', name: 'Fable (latest)', group: 'Latest (alias)', note: 'Most capable; best for planning and review' },
        { id: 'opus', name: 'Opus (latest)', group: 'Latest (alias)', note: 'Strong all-rounder for coding' },
        { id: 'sonnet', name: 'Sonnet (latest)', group: 'Latest (alias)', note: 'Fast and cheaper; good for tests and CI logs' },
        { id: 'haiku', name: 'Haiku (latest)', group: 'Latest (alias)', note: 'Fastest and cheapest' },
        { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', group: 'Current', note: '$10 / $50 per MTok' },
        { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', group: 'Current', note: '$4 / $20 per MTok' },
        { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', group: 'Current', note: '$2 / $10 per MTok' },
        { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', group: 'Current', note: 'from $0.10 / $0.50 per MTok' },
      ],
    };
  if (path === '/settings' && method === 'GET') return settings;
  if (path === '/settings' && method === 'PUT') {
    settings = { ...settings, ...(b as Partial<Settings>), models: { ...settings.models, ...((b.models as Record<WorkerAgentKey, string>) ?? {}) } };
    return settings;
  }
  if (path === '/features' && method === 'GET') {
    const pid = q.get('project_id');
    const statuses = q.get('status')?.split(',');
    return features
      .filter((s) => (!pid || s.feature.project_id === Number(pid)) && (!statuses || statuses.includes(s.feature.status)))
      .sort((a, b2) => Date.parse(b2.feature.created_at) - Date.parse(a.feature.created_at))
      .map(summary);
  }
  if (path === '/features' && method === 'POST') {
    const title = String(b.title ?? '').trim();
    if (!title) throw new ApiError(422, 'Title is required');
    const id = Math.max(0, ...features.map((s) => s.feature.id)) + 1;
    const st: Store = {
      feature: full({
        id, project_id: Number(b.project_id), title, status: 'grilling', stages: ['run', 'pend', 'pend', 'pend', 'pend'], stage_text: 'Plan · Product Architect is reading your spec',
        branch: null, pr_number: null, pr_url: null, tasks_done: 0, tasks_total: 0, elapsed_seconds: 0, cost_usd: 0, created_at: iso(Date.now()), updated_at: iso(Date.now()), spec: String(b.spec ?? ''),
      }),
      questions: [], tasks: [], detail: emptyDetail(),
    };
    features.push(st);
    sync(st);
    push({ feature_id: id, task_id: null, agent: 'human', kind: 'status', message: 'Spec submitted', data: {} });
    later(1500, () => push({ feature_id: id, task_id: null, agent: 'product_architect', kind: 'tool', message: 'read README.md, docs/glossary.md, src/ (42 files)', data: {} }));
    later(3000, () => push({ feature_id: id, task_id: null, agent: 'product_architect', kind: 'log', message: 'Looking for edge cases the spec does not cover', data: {} }));
    later(5000, () => {
      st.feature.status = 'awaiting_answers';
      st.feature.stages = ['wait', 'pend', 'pend', 'pend', 'pend'];
      st.feature.stage_text = 'Plan · 2 questions for you';
      st.questions = [
        { id: nextId(), question: 'Who is this for: every user, or only admins?', answer: null },
        { id: nextId(), question: 'What should happen when this fails halfway?', answer: null },
      ];
      push({ feature_id: id, task_id: null, agent: 'product_architect', kind: 'gate', message: `Questions ready: ${title}`, data: { detail: '2 questions' } });
      touch(st);
    });
    return summary(st);
  }

  if (parts[0] === 'features' && parts[1]) {
    const st = get(Number(parts[1]));
    const f = st.feature;
    const action = parts[2];
    if (!action && method === 'GET') return detail(st);
    if (action === 'events') {
      const agent = q.get('agent');
      const before = q.get('before_id') ? Number(q.get('before_id')) : Infinity;
      const limit = Number(q.get('limit') ?? 200);
      return events
        .filter((e) => e.feature_id === f.id && (!agent || e.agent === agent) && e.id < before)
        .sort((a, b2) => Date.parse(b2.ts) - Date.parse(a.ts) || b2.id - a.id)
        .slice(0, limit);
    }
    if (action === 'answers') {
      expect(st, 'awaiting_answers');
      const answers = (b.answers as { id: number; answer: string }[]) ?? [];
      st.questions = st.questions.map((qq) => ({ ...qq, answer: answers.find((a) => a.id === qq.id)?.answer ?? qq.answer }));
      f.status = 'grooming';
      f.stages = ['run', 'pend', 'pend', 'pend', 'pend'];
      f.stage_text = 'Plan · Product Architect is grooming';
      push({ feature_id: f.id, task_id: null, agent: 'human', kind: 'status', message: `Answered ${answers.length} questions`, data: {} });
      later(1200, () => push({ feature_id: f.id, task_id: null, agent: 'product_architect', kind: 'log', message: 'Splitting the work into tasks that can be tested on their own', data: {} }));
      later(2600, () => push({ feature_id: f.id, task_id: null, agent: 'product_architect', kind: 'tool', message: 'write tasks/001-*.md … tasks/003-*.md', data: {} }));
      later(4500, () => {
        if (!st.tasks.length) {
          st.tasks = [
            task(nextId(), 1, 'Data model and migration', 'Store what the feature needs.', 'backend · no deps', ['Migration is reversible'], 'pending'),
            task(nextId(), 2, 'API endpoint', 'Expose it to the app.', 'api · needs 01', ['Errors follow the error schema'], 'pending'),
            task(nextId(), 3, 'End-to-end test', 'Covers the happy path and one failure.', 'tests · needs 02', ['Runs in CI'], 'pending'),
          ];
        }
        f.estimate = f.estimate ?? { hours_min: 2, hours_max: 3, cost_min: 4, cost_max: 7, files: 8 };
        f.status = 'awaiting_plan_approval';
        f.stages = ['wait', 'pend', 'pend', 'pend', 'pend'];
        f.stage_text = 'Plan · waiting for your approval';
        push({ feature_id: f.id, task_id: null, agent: 'product_architect', kind: 'gate', message: `Plan ready: ${f.title}`, data: { detail: `${st.tasks.length} tasks` } });
        touch(st);
      });
      touch(st);
      return detail(st);
    }
    if (action === 'approve') {
      expect(st, 'awaiting_plan_approval');
      startBuilding(st);
      push({ feature_id: f.id, task_id: null, agent: 'human', kind: 'gate', message: 'Plan approved', data: { detail: 'Gate 1' } });
      push({ feature_id: f.id, task_id: f.current_task_id, agent: 'software_engineer', kind: 'status', message: `Picked up task 001 · ${st.tasks[0]?.title ?? ''}`, data: { attempt: 1 } });
      touch(st);
      return detail(st);
    }
    if (action === 'request-changes') {
      expect(st, 'awaiting_plan_approval');
      f.status = 'grooming';
      f.stages = ['run', 'pend', 'pend', 'pend', 'pend'];
      f.stage_text = 'Plan · re-grooming with your note';
      push({ feature_id: f.id, task_id: null, agent: 'human', kind: 'status', message: `Asked for changes: ${String(b.note ?? '')}`, data: {} });
      later(4000, () => {
        f.status = 'awaiting_plan_approval';
        f.stages = ['wait', 'pend', 'pend', 'pend', 'pend'];
        f.stage_text = 'Plan · waiting for your approval';
        push({ feature_id: f.id, task_id: null, agent: 'product_architect', kind: 'gate', message: `Revised plan ready: ${f.title}`, data: {} });
        touch(st);
      });
      touch(st);
      return detail(st);
    }
    if (action === 'pause') {
      if (['merged', 'stopped', 'failed', 'paused'].includes(f.status)) throw new ApiError(409, 'Nothing is running');
      (f as FeatureFull & { _resume?: FeatureStatus })._resume = f.status;
      f.status = 'paused';
      f.paused = true;
      push({ feature_id: f.id, task_id: null, agent: 'human', kind: 'status', message: 'Run paused', data: {} });
      touch(st);
      return detail(st);
    }
    if (action === 'resume') {
      expect(st, 'paused');
      f.status = (f as FeatureFull & { _resume?: FeatureStatus })._resume ?? 'building';
      f.paused = false;
      push({ feature_id: f.id, task_id: null, agent: 'human', kind: 'status', message: 'Run resumed', data: {} });
      touch(st);
      return detail(st);
    }
    if (action === 'stop') {
      f.status = 'stopped';
      f.paused = false;
      f.stage_text = 'Stopped by you';
      push({ feature_id: f.id, task_id: null, agent: 'human', kind: 'status', message: 'Run stopped', data: {} });
      touch(st);
      return detail(st);
    }
    if (action === 'merge') {
      expect(st, 'awaiting_merge');
      f.status = 'merged';
      f.stages = ['done', 'done', 'done', 'done', 'done'];
      f.stage_text = 'Merged just now';
      f.merged_commit = '9d02b7a';
      push({ feature_id: f.id, task_id: null, agent: 'human', kind: 'status', message: `Merged #${f.pr_number} ${f.title}`, data: { detail: 'squash merge', ...b } });
      if (b.follow_up_nits) st.tasks.push(task(nextId(), st.tasks.length + 1, 'Follow-up: review nits', 'Address the nits left on the PR.', 'follow-up', [], 'pending', { kind: 'rollup' }));
      touch(st);
      return detail(st);
    }
    if (action === 'send-back') {
      expect(st, 'awaiting_merge');
      st.tasks.push(task(nextId(), st.tasks.length + 1, 'Rollup: your merge note', String(b.note ?? ''), 'rollup · gate 2', [], 'pending', { kind: 'rollup' }));
      f.stages = ['done', 'run', 'done', 'done', 'pend'];
      startBuilding(st);
      push({ feature_id: f.id, task_id: null, agent: 'human', kind: 'status', message: `Sent back: ${String(b.note ?? '')}`, data: {} });
      touch(st);
      return detail(st);
    }
    if (action === 'message') {
      push({ feature_id: f.id, task_id: null, agent: 'human', kind: 'log', message: `Note to ${String(b.agent).replace(/_/g, ' ')}: ${String(b.text ?? '')}`, data: {} });
      return { ok: true };
    }
  }
  throw new ApiError(404, `No mock for ${method} ${rawPath}`);
}
