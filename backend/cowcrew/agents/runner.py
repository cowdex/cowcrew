"""Agent runners: one interface, two implementations.

* `AgentRunner` drives a real agent through the Claude Agent SDK (`query()`), with the
  `guard.ToolPolicy` enforced on every tool call (PreToolUse hook + can_use_tool callback).
* `SimulatedRunner` produces realistic events and structured outputs with no network, so the
  whole pipeline and UI can be demoed end to end.

Both stream progress as Events through a `RunRecorder` and return a validated pydantic model.
"""

from __future__ import annotations

import asyncio
import json
import random
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, TypeVar

from pydantic import BaseModel, ValidationError

from cowcrew import limits
from cowcrew.agents import simulation
from cowcrew.db import Database
from cowcrew.events import EventBus
from cowcrew.guard import ToolPolicy, WriteScope
from cowcrew.models import AGENT_SHORT
from cowcrew.settings import SettingsStore

T = TypeVar("T", bound=BaseModel)
Phase = Literal["grill", "groom", "implement", "test", "accept", "review", "diagnose"]

PROMPTS_DIR = Path(__file__).parent / "prompts"
CONTEXT_WINDOW = 200_000
LOG_LIMIT = 400
DISALLOWED_TOOLS = ["WebFetch", "WebSearch", "Task", "Agent", "Skill", "KillShell"]


class AgentError(Exception):
    """An agent run failed or returned output that does not match its schema."""


@dataclass
class AgentJob:
    """Everything needed to run one agent once."""

    agent: str
    phase: Phase
    feature_id: int
    task_id: int | None
    title: str  # one line, shown on the agent card while running
    prompt: str
    cwd: Path
    output: type[BaseModel]
    tools: frozenset[str]
    write_scope: WriteScope = "none"
    max_turns: int = 60
    context: dict[str, Any] = field(default_factory=dict)  # facts for the simulator


@dataclass
class ActiveRun:
    agent: str
    feature_id: int
    job: str
    context_pct: float = 0.0


def load_system_prompt(agent: str) -> str:
    return (PROMPTS_DIR / f"{agent}.md").read_text(encoding="utf-8")


def _compact(n: int) -> str:
    """1234 → 1.2k, 4_200_000 → 4.2M."""
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}k"
    return str(n)


def describe_tool(name: str, tool_input: dict[str, Any], cwd: Path) -> str:
    """Compact one-liner for a tool call: 'Edit src/x.py', 'Bash: pytest -q'."""

    def rel(raw: Any) -> str:
        text = str(raw or "")
        try:
            return str(Path(text).resolve().relative_to(cwd.resolve()))
        except (ValueError, OSError):
            return text

    if name == "Bash":
        command = " ".join(str(tool_input.get("command", "")).split())
        return f"Bash: {command[:160]}"
    if name in {"Edit", "Write", "MultiEdit", "Read"}:
        return f"{name} {rel(tool_input.get('file_path'))}"
    if name == "NotebookEdit":
        return f"{name} {rel(tool_input.get('notebook_path'))}"
    if name in {"Grep", "Glob"}:
        return f"{name} {str(tool_input.get('pattern', ''))[:120]}"
    return name


def parse_output(model: type[T], structured: Any, text: str | None) -> T:
    """Validate structured output; fall back to the last JSON object in the result text."""
    if structured is not None:
        try:
            return model.model_validate(structured)
        except ValidationError as exc:
            raise AgentError(f"structured output did not match schema: {exc}") from exc
    decoder = json.JSONDecoder()
    body = text or ""
    for start in reversed([i for i, ch in enumerate(body) if ch == "{"]):
        try:
            candidate, _ = decoder.raw_decode(body[start:])
            return model.model_validate(candidate)
        except (json.JSONDecodeError, ValidationError):
            continue
    raise AgentError("agent returned no valid JSON result")


class RunRecorder:
    """Turns agent activity into Events and accumulates the feature's cost/tokens/tool calls."""

    def __init__(self, runner: BaseRunner, job: AgentJob, model: str, active: ActiveRun) -> None:
        self.runner = runner
        self.job = job
        self.model = model
        self.active = active

    def _emit(self, kind: str, message: str, data: dict[str, Any] | None = None) -> None:
        self.runner.bus.emit(self.job.feature_id, self.job.agent, kind, message, data,
                             task_id=self.job.task_id)

    def text(self, text: str) -> None:
        clean = " ".join(text.split())
        if clean:
            self._emit("log", clean[:LOG_LIMIT] + ("…" if len(clean) > LOG_LIMIT else ""))

    def tool(self, name: str, tool_input: dict[str, Any]) -> None:
        self.runner.db.execute(
            "UPDATE features SET tool_calls = tool_calls + 1 WHERE id = ?", (self.job.feature_id,)
        )
        data: dict[str, Any] = {"tool": name}
        if name in {"Edit", "Write", "MultiEdit", "NotebookEdit"}:
            message = describe_tool(name, tool_input, self.job.cwd)
            data["path"] = message.split(" ", 1)[1] if " " in message else ""
        self._emit("tool", describe_tool(name, tool_input, self.job.cwd), data)

    def blocked(self, reason: str) -> None:
        self._emit("error", f"Blocked: {reason}", {"blocked": True})

    def usage(self, usage: dict[str, Any] | None) -> None:
        if not usage:
            return
        used = sum(int(usage.get(k) or 0) for k in (
            "input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))
        self.active.context_pct = round(min(100.0, used * 100 / CONTEXT_WINDOW), 1)
        self.runner.context_pct[self.job.agent] = self.active.context_pct

    def result(self, cost_usd: float, usage: dict[str, Any] | None, num_turns: int) -> None:
        usage = usage or {}
        tokens_in = sum(int(usage.get(k) or 0) for k in (
            "input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))
        tokens_out = int(usage.get("output_tokens") or 0)
        self.runner.db.execute(
            "UPDATE features SET cost_usd = cost_usd + ?, tokens_in = tokens_in + ?, "
            "tokens_out = tokens_out + ? WHERE id = ?",
            (cost_usd, tokens_in, tokens_out, self.job.feature_id),
        )
        self._emit(
            "cost",
            f"{AGENT_SHORT.get(self.job.agent, self.job.agent)} run: "
            + (f"{_compact(tokens_in + tokens_out)} tokens"
               if self.runner.settings.billing == "subscription" else f"${cost_usd:.2f}")
            + f" · {num_turns} turns",
            {
                "cost_usd": round(cost_usd, 4), "model": self.model,
                "input_tokens": tokens_in, "output_tokens": tokens_out,
                "num_turns": num_turns, "context_pct": self.active.context_pct,
            },
        )
        self.runner.bus.feature_changed(self.job.feature_id)


class BaseRunner:
    """Shared bookkeeping: which agents are active, their context usage, and run accounting."""

    def __init__(self, db: Database, bus: EventBus, settings: SettingsStore) -> None:
        self.db = db
        self.bus = bus
        self.settings = settings
        self.active: dict[tuple[str, int], ActiveRun] = {}
        self.context_pct: dict[str, float] = {}

    async def run(self, job: AgentJob) -> BaseModel:
        model = self.settings.model_for(job.agent)
        active = ActiveRun(job.agent, job.feature_id, job.title)
        self.active[(job.agent, job.feature_id)] = active
        try:
            return await self._execute(job, model, RunRecorder(self, job, model, active))
        finally:
            self.active.pop((job.agent, job.feature_id), None)

    async def _execute(self, job: AgentJob, model: str, rec: RunRecorder) -> BaseModel:
        raise NotImplementedError


class AgentRunner(BaseRunner):
    """Runs agents through the Claude Agent SDK."""

    def __init__(
        self, db: Database, bus: EventBus, settings: SettingsStore,
        remaining_budget: Callable[[], float] | None = None,
    ) -> None:
        super().__init__(db, bus, settings)
        self.remaining_budget = remaining_budget

    def build_options(self, job: AgentJob, model: str, rec: RunRecorder) -> Any:
        from claude_agent_sdk import (
            ClaudeAgentOptions,
            HookMatcher,
            PermissionResultAllow,
            PermissionResultDeny,
        )

        policy = ToolPolicy(job.agent, job.cwd, job.tools, job.write_scope)
        reported: set[str] = set()

        def report(tool_use_id: str | None, reason: str) -> None:
            key = tool_use_id or reason
            if key not in reported:
                reported.add(key)
                rec.blocked(reason)

        async def pre_tool_use(input_data: Any, tool_use_id: str | None, _ctx: Any) -> Any:
            decision = policy.check(input_data["tool_name"], input_data.get("tool_input") or {})
            if decision.allowed:
                return {}
            report(tool_use_id, decision.reason)
            return {"hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": f"Blocked by CowCrew guard: {decision.reason}",
            }}

        async def can_use_tool(name: str, tool_input: dict[str, Any], ctx: Any) -> Any:
            decision = policy.check(name, tool_input)
            if decision.allowed:
                return PermissionResultAllow()
            report(getattr(ctx, "tool_use_id", None), decision.reason)
            return PermissionResultDeny(message=f"Blocked by CowCrew guard: {decision.reason}")

        budget = self.remaining_budget() if self.remaining_budget else None
        return ClaudeAgentOptions(
            system_prompt=load_system_prompt(job.agent),
            model=model,
            cwd=str(job.cwd),
            tools=sorted(job.tools),
            allowed_tools=[],  # nothing pre-approved: every call reaches the guard
            disallowed_tools=DISALLOWED_TOOLS,
            permission_mode="default",
            can_use_tool=can_use_tool,
            hooks={"PreToolUse": [HookMatcher(matcher=None, hooks=[pre_tool_use],
                                              on_failure="block")]},
            setting_sources=[],  # isolation: no user/project settings, hooks or allow rules
            output_format={"type": "json_schema", "schema": job.output.model_json_schema()},
            max_turns=job.max_turns,
            max_budget_usd=budget if budget and budget > 0 else None,
        )

    async def _execute(self, job: AgentJob, model: str, rec: RunRecorder) -> BaseModel:
        from claude_agent_sdk import (
            AssistantMessage,
            ClaudeSDKError,
            RateLimitEvent,
            ResultMessage,
            TextBlock,
            ToolUseBlock,
            query,
        )

        options = self.build_options(job, model, rec)

        async def prompt_stream() -> AsyncIterator[dict[str, Any]]:
            yield {"type": "user", "message": {"role": "user", "content": job.prompt},
                   "parent_tool_use_id": None, "session_id": ""}

        result: Any = None
        try:
            async for message in query(prompt=prompt_stream(), options=options):
                if isinstance(message, AssistantMessage):
                    for block in message.content:
                        if isinstance(block, TextBlock):
                            rec.text(block.text)
                        elif isinstance(block, ToolUseBlock):
                            rec.tool(block.name, block.input)
                    rec.usage(message.usage)
                elif isinstance(message, ResultMessage):
                    result = message
                elif isinstance(message, RateLimitEvent):
                    limits.record(self.db, message.rate_limit_info.raw)
        except ClaudeSDKError as exc:
            raise AgentError(f"Agent SDK error: {exc}") from exc
        if result is None:
            raise AgentError("agent ended without a result")
        rec.result(float(result.total_cost_usd or 0.0), result.usage, result.num_turns)
        if result.is_error:
            detail = "; ".join(result.errors or []) or result.subtype
            raise AgentError(f"agent run failed: {detail}")
        return parse_output(job.output, result.structured_output, result.result)


class SimulatedRunner(BaseRunner):
    """No-network stand-in that streams plausible events and returns plausible outputs."""

    def __init__(
        self, db: Database, bus: EventBus, settings: SettingsStore, speed: float = 1.0,
        seed: int | None = None,
    ) -> None:
        super().__init__(db, bus, settings)
        self.speed = speed
        self.rng = random.Random(seed)

    async def _pause(self, lo: float, hi: float) -> None:
        if self.speed > 0:
            await asyncio.sleep(self.rng.uniform(lo, hi) * self.speed)

    async def _execute(self, job: AgentJob, model: str, rec: RunRecorder) -> BaseModel:
        script = simulation.script_for(job.phase, job.context, self.rng)
        tokens_in = 0
        for step in script:
            await self._pause(0.35, 0.75)
            tokens_in += self.rng.randint(2_000, 9_000)
            rec.usage({"input_tokens": tokens_in})
            if step.kind == "tool":
                rec.tool(step.tool, step.tool_input)
            else:
                rec.text(step.text)
        output = simulation.output_for(job.phase, job.context, self.rng)
        cost = simulation.cost_for(job.agent, self.rng)
        rec.result(cost, {"input_tokens": tokens_in, "output_tokens": tokens_in // 9},
                   num_turns=len(script) + 1)
        if self.settings.billing == "subscription":
            limits.simulate(self.db)
        return job.output.model_validate(output)
