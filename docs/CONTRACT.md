# CowCrew — architecture and API contract

CowCrew is a local web app that turns a feature spec into a merged change using five AI agents
(Claude Agent SDK) with two human gates. One process: a FastAPI backend that also serves the built
React frontend. Everything runs on the user's own computer against git repos on disk.

```
cowcrew/
  backend/                 uv project, package `cowcrew`  (Python 3.11+)
    cowcrew/
      main.py              FastAPI app, serves /api, /ws, and frontend/dist at /
      cli.py               `cowcrew serve|seed|reset` (entry point `cowcrew`)
      settings.py          env + settings table
      db.py                SQLite (sqlite3 or SQLModel), file at ~/.cowcrew/cowcrew.db (COWCREW_HOME overrides)
      models.py            pydantic schemas = this contract
      api.py               REST routes
      events.py            event bus: persist Event + broadcast over /ws
      orchestrator.py      resumable pipeline state machine
      agents/runner.py     AgentRunner (Claude Agent SDK) and SimulatedRunner
      agents/prompts/*.md  role prompts for the five agents (see NOTICE)
      guard.py             can_use_tool policy (worktree-only writes, no push, no .github edits)
      gitops.py            worktree, commit, diff, merge (subprocess git)
      github.py            push, PR, CI runs via `gh` CLI (optional)
      seed.py              demo data matching the designs
    tests/
  frontend/                Vite + React 18 + TypeScript + react-router
  docs/CONTRACT.md         this file
  Makefile, README.md, NOTICE
```

Dev: backend on :8787 (`uv run cowcrew serve --reload`), Vite on :5173 proxying `/api` and `/ws` to :8787.
Prod/local use: `make build` → `npm run build` into `frontend/dist`, then `uv run cowcrew serve` serves everything at http://localhost:8787.

## Agents

| key                | display name       | default model | job |
|--------------------|--------------------|---------------|-----|
| `product_architect`| Product Architect  | `fable`       | grill spec, groom plan, acceptance review |
| `software_engineer`| Software Engineer  | `opus`        | write code + tests for one task (never commits) |
| `tester`           | Tester             | `sonnet`      | run suite + adversarial checks, PASS/FAIL |
| `pr_reviewer`      | PR Reviewer        | `fable`       | review full diff, Blocker/Nit findings |
| `oncall_engineer`  | On-Call Engineer   | `sonnet`      | diagnose red CI, hand fix task to SWE |

`human` and `system` are also valid `agent` values on events.

## Feature lifecycle (`Feature.status`)

```
grilling ─(PA asks questions)→ awaiting_answers ─(user answers)→ grooming
grooming ─(PA writes plan)→ awaiting_plan_approval            ← GATE 1
   ├─ request-changes → grooming (note passed to PA)
   └─ approve → building
building  (per task: SWE → Tester → commit; FAIL retries up to max_attempts)
   → accepting (PA acceptance; REJECT → rollup task → building)
   → reviewing (PR Reviewer; Blockers → rollup task → building → reviewing)
   → ci (push + PR + watch CI; red → On-Call → fix task → building → accepting → reviewing → ci)  [skipped if no GitHub remote / no workflows]
   → awaiting_merge                                           ← GATE 2  [merge is pinned to the reviewed commit (verified_sha); simulate mode always merges locally]
        ├─ merge → merged
        └─ send-back {note} → rollup task → building
any running state ─ pause → paused (resume returns to the stored `resume_status`)
any state ─ stop → stopped ; unrecoverable error → failed (message in last event)
```

`stage` (for the 5-segment progress bar) is derived: plan = grilling|awaiting_answers|grooming|awaiting_plan_approval,
build = building, verify = accepting|reviewing, ci = ci, merge = awaiting_merge|merged.

## Schemas (JSON, snake_case, timestamps ISO-8601 UTC strings)

```ts
type AgentKey = "product_architect"|"software_engineer"|"tester"|"pr_reviewer"|"oncall_engineer"|"human"|"system";
type FeatureStatus = "grilling"|"awaiting_answers"|"grooming"|"awaiting_plan_approval"|"building"|"accepting"|"reviewing"|"ci"|"awaiting_merge"|"merged"|"paused"|"stopped"|"failed";
type Stage = "plan"|"build"|"verify"|"ci"|"merge";
type StageState = "done"|"run"|"wait"|"fail"|"pend";   // colors: teal, purple, orange, red, gray

interface Project { id: number; name: string; repo_path: string; default_branch: string; github_repo: string|null; created_at: string; }

interface FeatureSummary {
  id: number; project_id: number; title: string; status: FeatureStatus; stage: Stage;
  stages: StageState[];            // length 5, plan..merge
  stage_text: string;              // e.g. "Build · task 4 of 7 · SWE ⇄ Tester"
  branch: string|null; pr_number: number|null; pr_url: string|null;
  tasks_done: number; tasks_total: number;
  elapsed_seconds: number; cost_usd: number;
  waiting_on_you: boolean;         // true for awaiting_answers, awaiting_plan_approval, awaiting_merge
  created_at: string; updated_at: string;
}

interface Question { id: number; question: string; answer: string|null;
  options: string[];            // 2–4 suggested answers from the PA; [] for an open question
  recommended: number|null; }   // index into options of the PA's pick

interface Task {
  id: number; seq: number; title: string; description: string; acceptance_criteria: string[];
  depends_on: string; label: string;
  status: "pending"|"running"|"testing"|"committed"|"failed";
  attempts: number; commit_sha: string|null; kind: "plan"|"rollup"|"fix";
}

interface Finding { id: number; round: number; severity: "Blocker"|"Nit"; file: string; line: number|null; text: string; status: "open"|"fixed"|"noted"; }

interface Acceptance { verdict: "ACCEPT"|"REJECT"; summary: string; criteria: {text: string; met: boolean}[]; issues: string[]; }

interface CIJob { name: string; conclusion: "success"|"failure"|"in_progress"|"queued"|"skipped"; duration_seconds: number|null; }
interface CIRun {
  id: number; run_id: string; status: "queued"|"in_progress"|"success"|"failure"; jobs: CIJob[];
  failing_job: string|null; failing_log: string|null;
  diagnosis: { root_cause: string; responsible_task: string; why_missed: string; fix_task: string } | null;
  created_at: string;
}

interface Event {
  id: number; feature_id: number|null; task_id: number|null; ts: string;
  agent: AgentKey; kind: "log"|"tool"|"status"|"handoff"|"verdict"|"cost"|"gate"|"error";
  message: string; data: Record<string, unknown>;
}

interface FeatureDetail {
  feature: FeatureSummary & {
    spec: string; worktree_path: string|null; current_task_id: number|null;
    adr: { title: string; body: string } | null;
    glossary_terms: string[];
    estimate: { hours_min: number; hours_max: number; cost_min: number; cost_max: number; files: number } | null;
    tokens_in: number; tokens_out: number; tool_calls: number;
    diff_stats: { files: number; additions: number; deletions: number } | null;
    merged_commit: string|null; paused: boolean;
  };
  questions: Question[];
  tasks: Task[];
  acceptance: Acceptance | null;
  findings: Finding[];
  ci_runs: CIRun[];
  spend_by_agent: { agent: AgentKey; model: string; cost_usd: number }[];
  checklist: { title: string; sub: string; ok: boolean; link: "plan"|"live"|"review"|"ci"|"merge" }[];  // for Merge page
}

interface AgentCard {
  key: AgentKey; name: string; model: string;
  state: "working"|"waiting"|"queued"|"idle";    // working=purple, waiting=orange, queued/idle=gray
  job: string;                                    // current or last activity, one line
  context_pct: number; spend_usd: number;         // spend this week
  feature_id: number|null;
}

interface Overview {
  kpis: { in_flight: number; waiting_on_you: number; committed_7d: number; first_try_pass_pct: number;
          first_try_pass_num: number; ci_failing: number; spend_7d_usd: number; budget_usd: number; };
  board: { feature_id: number; title: string; cells: StageState[]; summary: string }[];   // one cell per task (or 1 "wait" cell per expected task while planning)
  spend: { total_usd: number; wow_pct: number|null; by_model: { model: string; agents: string; usd: number; pct: number }[];
           projected_usd: number; budget_used_pct: number };
  trends: { key: "lead_time"|"loops_per_task"|"blockers_per_pr"; label: string; value: string; delta: string; good: boolean; points: number[] }[];  // points normalized 0..1, 12 values
  features: FeatureSummary[];
  agents: AgentCard[];
  activity: Event[];   // latest 8 meaningful events (status/handoff/verdict/gate/error)
}

interface Settings {
  budget_usd_week: number; max_attempts: number;
  models: Record<"product_architect"|"software_engineer"|"tester"|"pr_reviewer"|"oncall_engineer", string>;
  simulate: boolean;               // read-only in UI; set by COWCREW_SIMULATE=1 or missing credentials
  has_credentials: boolean;        // ANTHROPIC_API_KEY set (or Claude Code login detected)
  gh_available: boolean;           // `gh auth status` ok
}
```

## REST endpoints (all under `/api`, JSON)

| method | path | body | returns |
|---|---|---|---|
| GET | `/health` | | `{ok: true, version}` |
| GET | `/projects` | | `Project[]` |
| POST | `/projects` | `{name, repo_path, github_repo?}` (validates path is a git repo; detects default branch) | `Project` |
| DELETE | `/projects/{id}` | | `{ok}` |
| GET | `/overview?project_id=` | | `Overview` |
| GET | `/features?project_id=&status=` | status may be comma list | `FeatureSummary[]` newest first |
| POST | `/features` | `{project_id, title, spec}` | `FeatureSummary` (status grilling, orchestration starts) |
| GET | `/features/{id}` | | `FeatureDetail` |
| GET | `/features/{id}/events?agent=&limit=200&before_id=` | | `Event[]` newest first |
| POST | `/features/{id}/answers` | `{answers: {id: number, answer: string}[]}` | `FeatureDetail` |
| POST | `/features/{id}/approve` | | `FeatureDetail` |
| POST | `/features/{id}/request-changes` | `{note}` | `FeatureDetail` |
| POST | `/features/{id}/pause` · `/resume` · `/stop` · `/restart` (stopped or failed → the step it was on) | | `FeatureDetail` |
| POST | `/features/{id}/merge` | `{commit_message, delete_branch: bool, follow_up_nits: bool}` | `FeatureDetail` |
| POST | `/features/{id}/send-back` | `{note}` | `FeatureDetail` |
| POST | `/features/{id}/message` | `{agent, text}` (note appended to that agent's next prompt) | `{ok}` |
| GET | `/settings` · PUT `/settings` | `Partial<Settings>` (only budget, max_attempts, models) | `Settings` |

Errors: HTTP 4xx with `{detail: string}`. Illegal transitions (e.g. approve when not awaiting) → 409.

## WebSocket `/ws`

Server → client JSON messages:
- `{type: "event", event: Event}` for every new event
- `{type: "feature", feature: FeatureSummary}` whenever a feature's summary changes
- `{type: "hello", version}` on connect

Client never needs to send anything. Frontend refetches the open page's data on relevant
`feature` messages and appends `event`s to live logs.

## Frontend notes

Places where the frontend relies on details the contract leaves open (the backend may ignore them; the UI degrades gracefully):

- `Event.data.detail` (string, optional): short second line shown under activity/notification items (e.g. "attempt 2", "3 nits for you").
- `Event.data.verdict` (`"PASS"|"FAIL"|...`) on `verdict` events and `Event.data.attempt` (number) on SWE events build the SWE ⇄ Tester loop timeline; loop events should carry `task_id`.
- `Event.data.path` / `additions` / `deletions` on `tool` events (file edits) feed "Files changed so far" on the Live page; without them only `diff_stats` is shown.
- `Diagnosis.responsible_task` is displayed as is; if it starts with a task number ("002 Wait for…") the number is highlighted.
- An ADR body paragraph made of ≥3 parts joined by " → " is rendered as a flow diagram.
- `Overview.features` (current project) drives the sidebar badges (Plans = awaiting_answers + awaiting_plan_approval, Merge = awaiting_merge) and the search box; CI badge = `kpis.ci_failing`.
- The frontend sends nothing over `/ws`; it reconnects with exponential backoff (max 10 s) and, after a reconnect, refetches overview, lists, feature detail and events over REST, since messages sent while it was down are not replayed.

## Backend notes

Additions made while implementing the backend. All are backwards-compatible; no field or
endpoint above changed.

- **Request bodies** ignore unknown fields, so `PUT /settings` accepts a full `Settings` object.
  Only `budget_usd_week`, `max_attempts` and `models` are applied. `max_attempts` must be 1–20
  and `budget_usd_week` ≥ 0 (422 otherwise).
- **Answers.** A feature leaves `awaiting_answers` only when every question has an answer. An
  empty answer is stored as `"(no preference)"`. An unknown question id returns 409.
- **Legal actions** (409 otherwise):
  - `pause` only from running states (`grilling`, `grooming`, `building`, `accepting`,
    `reviewing`, `ci`). It takes effect when the current agent run finishes.
  - `resume` only from `paused`. Tasks marked `failed` go back to `pending` with
    `attempts` reset to 0.
  - `stop` from any state except `merged` and `stopped`.
  - `message` from any non-terminal state.
- **Merge** returns 409 when the local main checkout has uncommitted changes, isn't on the
  default branch, or the squash merge conflicts. A conflict is rolled back.
- **Retry caps.** When a cap is hit, the feature pauses and an `error` event says why. On
  `resume`, one more round runs. The caps are: a task fails QA `max_attempts` times, 3 PA
  rejections, Blockers in review round 3, red CI after 2 fix rounds. The rollup or fix task is
  already queued.
- **Weekly budget.** Before each agent run, spend over the last 7 days is compared with
  `budget_usd_week`. When it's reached, the feature pauses with an `error` event. Real agent
  runs also get the remaining budget as `max_budget_usd`.
- **Seeded features** (`cowcrew seed`) are display-only. The orchestrator never drives or
  restart-pauses them. Pausing and then resuming one hands it to the orchestrator.
- **Simulate mode** always runs a simulated CI stage: the first push goes red, then green. A PR
  number and URL are set only if `project.github_repo` is set. Nothing is ever pushed.
- **Event `data` conventions** (extra keys may appear):
  - `status`: `{from, to}`
  - `gate`: `{gate: "answers"|"plan"|"merge", approved?: bool}`
  - Tester `verdict`: `{verdict, attempt, report, tests_passed, tests_total}`
  - PA `verdict`: `{verdict, issues}`
  - Reviewer `verdict`: `{blockers, nits, round}`
  - On-Call `verdict`: `{conclusion, job?}`
  - `cost`: also carries `context_pct`
  - guard denials: `error` events with `{blocked: true}` and a message starting `Blocked:`
- **Checklist** always has 7 items in this order: Plan approved, All tasks committed,
  PA accepted, 0 open blockers, CI green / No CI configured, Separation of duties,
  Protected checks untouched.
- **AgentCard.state.**
  - `working` while this process runs the agent. Otherwise it is derived from feature
    statuses, which also covers seeded data.
  - PA is `waiting` at gate 1, and PR Reviewer is `waiting` at gate 2.
  - Tester is `queued` while the SWE works, and On-Call is `queued` while CI runs.
- **Trends.** `delta` looks like `"−18% vs last week"`, `"new this week"` or `"no data"`.
  `good` means the metric went down.
- **Security.**
  - Non-GET requests and `/ws` connections with a foreign `Origin` get 403 or close 1008.
    Same-origin and `http://localhost:5173` are allowed.
  - Requests with a `Host` other than loopback get 400. `cowcrew serve --host X` allows X.
- **Extra environment variables:** `COWCREW_SIM_SPEED`, `COWCREW_CI_POLL_SECONDS`,
  `COWCREW_CI_TIMEOUT_SECONDS`, `COWCREW_FRONTEND_DIST`, `COWCREW_ALLOWED_HOSTS`.

## Billing notes

- `Settings.billing` is `"subscription"` (Claude plan login, usage counted in tokens) or `"api"`
  (API key or cloud provider, billed in dollars). `COWCREW_BILLING` overrides the detection.
- Token figures are input (including cache reads and writes) plus output tokens, summed from
  `cost` events. Added fields: `FeatureSummary.tokens`, `SpendByAgent.tokens`,
  `AgentCard.spend_tokens`, `Kpis.spend_7d_tokens` / `budget_tokens`, `Spend.unit`,
  `Spend.total_tokens`, `Spend.projected_tokens`, `ModelSpend.tokens`,
  `Settings.budget_tokens_week`.
- The weekly budget pauses runs in the unit that matches billing. Projections only extrapolate
  once there are two days of history.
