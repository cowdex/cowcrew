"""Pydantic schemas: the API contract (docs/CONTRACT.md) plus the agents' structured outputs."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

AgentKey = Literal[
    "product_architect", "software_engineer", "tester", "pr_reviewer", "oncall_engineer",
    "human", "system",
]
WorkerAgent = Literal[
    "product_architect", "software_engineer", "tester", "pr_reviewer", "oncall_engineer"
]
FeatureStatus = Literal[
    "grilling", "awaiting_answers", "grooming", "awaiting_plan_approval", "building",
    "accepting", "reviewing", "ci", "awaiting_merge", "merged", "paused", "stopped", "failed",
]
Stage = Literal["plan", "build", "verify", "ci", "merge"]
StageState = Literal["done", "run", "wait", "fail", "pend"]
EventKind = Literal["log", "tool", "status", "handoff", "verdict", "cost", "gate", "error"]
TaskStatus = Literal["pending", "running", "testing", "committed", "failed"]
TaskKind = Literal["plan", "rollup", "fix"]
Link = Literal["plan", "live", "review", "ci", "merge"]

WORKER_AGENTS: tuple[WorkerAgent, ...] = (
    "product_architect", "software_engineer", "tester", "pr_reviewer", "oncall_engineer",
)
AGENT_NAMES: dict[str, str] = {
    "product_architect": "Product Architect",
    "software_engineer": "Software Engineer",
    "tester": "Tester",
    "pr_reviewer": "PR Reviewer",
    "oncall_engineer": "On-Call Engineer",
    "human": "You",
    "system": "CowCrew",
}
AGENT_SHORT: dict[str, str] = {
    "product_architect": "PA",
    "software_engineer": "SWE",
    "tester": "Tester",
    "pr_reviewer": "PR Reviewer",
    "oncall_engineer": "On-Call",
}
DEFAULT_MODELS: dict[str, str] = {
    "product_architect": "fable",
    "software_engineer": "opus",
    "tester": "sonnet",
    "pr_reviewer": "fable",
    "oncall_engineer": "sonnet",
}

RUNNING_STATES: frozenset[str] = frozenset(
    {"grilling", "grooming", "building", "accepting", "reviewing", "ci"}
)
GATE_STATES: frozenset[str] = frozenset(
    {"awaiting_answers", "awaiting_plan_approval", "awaiting_merge"}
)
TERMINAL_STATES: frozenset[str] = frozenset({"merged", "stopped", "failed"})


# --------------------------------------------------------------------------- contract


class Project(BaseModel):
    id: int
    name: str
    repo_path: str
    default_branch: str
    github_repo: str | None
    created_at: str


class FeatureSummary(BaseModel):
    id: int
    project_id: int
    title: str
    status: FeatureStatus
    stage: Stage
    stages: list[StageState]
    stage_text: str
    branch: str | None
    pr_number: int | None
    pr_url: str | None
    tasks_done: int
    tasks_total: int
    elapsed_seconds: int
    cost_usd: float
    tokens: int = 0
    waiting_on_you: bool
    created_at: str
    updated_at: str


class Adr(BaseModel):
    title: str
    body: str


class Estimate(BaseModel):
    hours_min: float
    hours_max: float
    cost_min: float
    cost_max: float
    files: int


class DiffStats(BaseModel):
    files: int
    additions: int
    deletions: int


class FeatureFull(FeatureSummary):
    spec: str
    worktree_path: str | None
    current_task_id: int | None
    adr: Adr | None
    glossary_terms: list[str]
    estimate: Estimate | None
    tokens_in: int
    tokens_out: int
    tool_calls: int
    diff_stats: DiffStats | None
    merged_commit: str | None
    paused: bool


class Question(BaseModel):
    id: int
    question: str
    answer: str | None


class Task(BaseModel):
    id: int
    seq: int
    title: str
    description: str
    acceptance_criteria: list[str]
    depends_on: str
    label: str
    status: TaskStatus
    attempts: int
    commit_sha: str | None
    kind: TaskKind


class Finding(BaseModel):
    id: int
    round: int
    severity: Literal["Blocker", "Nit"]
    file: str
    line: int | None
    text: str
    status: Literal["open", "fixed", "noted"]


class Criterion(BaseModel):
    text: str
    met: bool


class Acceptance(BaseModel):
    verdict: Literal["ACCEPT", "REJECT"]
    summary: str
    criteria: list[Criterion]
    issues: list[str]


class CIJob(BaseModel):
    name: str
    conclusion: Literal["success", "failure", "in_progress", "queued", "skipped"]
    duration_seconds: int | None


class Diagnosis(BaseModel):
    root_cause: str
    responsible_task: str
    why_missed: str
    fix_task: str


class CIRun(BaseModel):
    id: int
    run_id: str
    status: Literal["queued", "in_progress", "success", "failure"]
    jobs: list[CIJob]
    failing_job: str | None
    failing_log: str | None
    diagnosis: Diagnosis | None
    created_at: str


class Event(BaseModel):
    id: int
    feature_id: int | None
    task_id: int | None
    ts: str
    agent: AgentKey
    kind: EventKind
    message: str
    data: dict[str, Any]


class SpendByAgent(BaseModel):
    agent: AgentKey
    model: str
    cost_usd: float
    tokens: int = 0


class ChecklistItem(BaseModel):
    title: str
    sub: str
    ok: bool
    link: Link


class FeatureDetail(BaseModel):
    feature: FeatureFull
    questions: list[Question]
    tasks: list[Task]
    acceptance: Acceptance | None
    findings: list[Finding]
    ci_runs: list[CIRun]
    spend_by_agent: list[SpendByAgent]
    checklist: list[ChecklistItem]


class AgentCard(BaseModel):
    key: AgentKey
    name: str
    model: str
    state: Literal["working", "waiting", "queued", "idle"]
    job: str
    context_pct: float
    spend_usd: float
    spend_tokens: int = 0
    feature_id: int | None


class Kpis(BaseModel):
    in_flight: int
    waiting_on_you: int
    committed_7d: int
    first_try_pass_pct: float
    first_try_pass_num: int
    ci_failing: int
    spend_7d_usd: float
    budget_usd: float
    spend_7d_tokens: int = 0
    budget_tokens: int = 0


class BoardRow(BaseModel):
    feature_id: int
    title: str
    cells: list[StageState]
    summary: str


class ModelSpend(BaseModel):
    model: str
    agents: str
    usd: float
    tokens: int = 0
    pct: float


class ProjectSpend(BaseModel):
    project_id: int
    name: str
    usd: float  # at API prices
    tokens: int
    features: int


class Spend(BaseModel):
    unit: Literal["usd", "tokens"] = "usd"
    total_usd: float
    total_tokens: int = 0
    wow_pct: float | None
    by_model: list[ModelSpend]
    projected_usd: float
    projected_tokens: int = 0
    budget_used_pct: float
    # Subscription only: what this week's usage really cost, as a share of the plan (estimate).
    by_project: list[ProjectSpend] = []
    month_usd: float = 0.0
    month_tokens: int = 0
    plan: str | None = None
    plan_cost_usd: tuple[float, float] | None = None  # rough range, low-high
    plan_week_usd: float | None = None
    plan_used_pct: tuple[float, float] | None = None


class Trend(BaseModel):
    key: Literal["lead_time", "loops_per_task", "blockers_per_pr"]
    label: str
    value: str
    delta: str
    good: bool
    points: list[float]


class PlanLimit(BaseModel):
    """One Claude plan usage window (session or weekly), as reported by Claude."""

    kind: str
    label: str
    used_pct: float | None
    status: str  # allowed | allowed_warning | rejected
    resets_at: float | None
    seen_at: float
    source: str = "agent"  # agent | claude_code | refresh | simulated


class DailyUsage(BaseModel):
    date: str  # local day, YYYY-MM-DD
    weekly_pct: float  # share of the weekly limit used that day


class ClaudeUsage(BaseModel):
    """The Claude apps' usage page, as far as Claude reports it to its tools."""

    limits: list[PlanLimit]
    updated_at: float | None
    daily: list[DailyUsage]
    statusline_connected: bool
    statusline_seen_at: float | None = None  # last time Claude Code's status line called in
    statusline_version: str | None = None
    statusline_has_limits: bool | None = None  # did that call include usage numbers?
    statusline_raw: str | None = None  # last `rate_limits` as received, for troubleshooting


class Overview(BaseModel):
    kpis: Kpis
    board: list[BoardRow]
    spend: Spend
    trends: list[Trend]
    features: list[FeatureSummary]
    agents: list[AgentCard]
    activity: list[Event]
    limits: list[PlanLimit] = []


class Settings(BaseModel):
    budget_usd_week: float
    budget_tokens_week: int = 0
    billing: Literal["api", "subscription"] = "api"
    plan: Literal["pro", "max", "ultra"] | None = None
    # Real subscription dollars per dollar of API-priced usage (None without a plan).
    plan_usd_per_api_usd: tuple[float, float] | None = None  # rough range, low-high
    max_attempts: int
    models: dict[WorkerAgent, str]
    simulate: bool
    has_credentials: bool
    gh_available: bool


# --------------------------------------------------------------------------- request bodies


class _Body(BaseModel):
    """Request bodies ignore unknown fields (e.g. read-only Settings fields sent back)."""

    model_config = ConfigDict(extra="ignore")


class ProjectCreate(_Body):
    name: str = Field(min_length=1, max_length=120)
    repo_path: str = Field(min_length=1)
    github_repo: str | None = Field(default=None, pattern=r"^[\w.-]+/[\w.-]+$")


class FeatureCreate(_Body):
    project_id: int
    title: str = Field(min_length=1, max_length=200)
    spec: str = Field(min_length=1, max_length=50_000)


class AnswerItem(_Body):
    id: int
    answer: str = Field(max_length=10_000)


class AnswersBody(_Body):
    answers: list[AnswerItem]


class NoteBody(_Body):
    note: str = Field(min_length=1, max_length=10_000)


class MergeBody(_Body):
    commit_message: str = Field(min_length=1, max_length=2_000)
    delete_branch: bool = False
    follow_up_nits: bool = False


class MessageBody(_Body):
    agent: WorkerAgent
    text: str = Field(min_length=1, max_length=10_000)


class SettingsUpdate(_Body):
    budget_usd_week: float | None = Field(default=None, ge=0)
    budget_tokens_week: int | None = Field(default=None, ge=0)
    max_attempts: int | None = Field(default=None, ge=1, le=20)
    models: dict[WorkerAgent, str] | None = None
    plan: Literal["pro", "max", "ultra"] | None = None


# --------------------------------------------------------------------------- agent outputs


class GrillOutput(BaseModel):
    questions: list[str] = Field(max_length=5)


class PlanTask(BaseModel):
    title: str
    description: str
    acceptance_criteria: list[str]
    depends_on: str = ""
    label: str = ""


class GroomOutput(BaseModel):
    tasks: list[PlanTask] = Field(min_length=1)
    adr: Adr | None = None
    glossary_terms: list[str] = Field(default_factory=list)
    estimate: Estimate


class SweOutput(BaseModel):
    summary: str
    files_changed: list[str] = Field(default_factory=list)


class TesterOutput(BaseModel):
    verdict: Literal["PASS", "FAIL"]
    tests_passed: int
    tests_total: int
    report: str


class AcceptOutput(BaseModel):
    verdict: Literal["ACCEPT", "REJECT"]
    summary: str
    criteria: list[Criterion]
    issues: list[str] = Field(default_factory=list)


class ReviewFinding(BaseModel):
    severity: Literal["Blocker", "Nit"]
    file: str
    line: int | None = None
    text: str


class ReviewOutput(BaseModel):
    findings: list[ReviewFinding]


class FixTask(BaseModel):
    title: str
    description: str
    acceptance_criteria: list[str]


class OnCallOutput(BaseModel):
    root_cause: str
    responsible_task: str
    why_missed: str
    fix_task: FixTask
