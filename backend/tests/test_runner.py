"""AgentRunner against a fake SDK `query`: event conversion, accounting, guard wiring, parsing."""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any

import claude_agent_sdk
import pytest
from claude_agent_sdk import (
    AssistantMessage,
    PermissionResultAllow,
    PermissionResultDeny,
    ResultMessage,
    TextBlock,
    ThinkingBlock,
    ToolPermissionContext,
    ToolUseBlock,
)

from cowcrew import models
from cowcrew.agents.runner import (
    AgentError,
    AgentJob,
    AgentRunner,
    describe_tool,
    parse_output,
)
from cowcrew.api import AppState
from cowcrew.models import SweOutput
from tests.conftest import add_project


def result(**kw: Any) -> ResultMessage:
    base = dict(subtype="success", duration_ms=10, duration_api_ms=8, is_error=False,
                num_turns=3, session_id="s1", total_cost_usd=0.42,
                usage={"input_tokens": 1200, "cache_read_input_tokens": 800,
                       "output_tokens": 300}, result=None, structured_output=None)
    return ResultMessage(**{**base, **kw})


@pytest.fixture
def setup(make_state: Callable[..., AppState], tmp_path: Path) -> tuple[AgentRunner, int, Path]:
    state = make_state()
    runner = AgentRunner(state.db, state.bus, state.settings)
    project = add_project(state, tmp_path)
    fid = state.db.insert("features", project_id=project, title="F", slug="f", spec="s",
                          status="building", created_at="2026-01-01T00:00:00Z",
                          updated_at="2026-01-01T00:00:00Z")
    worktree = tmp_path / "wt"
    worktree.mkdir()
    return runner, fid, worktree


def job(fid: int, cwd: Path, output: type = SweOutput,
        agent: str = "software_engineer") -> AgentJob:
    return AgentJob(agent=agent, phase="implement", feature_id=fid, task_id=None,
                    title="Task 001", prompt="do it", cwd=cwd, output=output,
                    tools=frozenset({"Read", "Edit", "Write", "Bash"}), write_scope="any")


def fake_query(messages: list[Any], seen: dict[str, Any]) -> Callable[..., AsyncIterator[Any]]:
    async def query(*, prompt: Any, options: Any, transport: Any = None) -> AsyncIterator[Any]:
        seen["options"] = options
        seen["prompt"] = [m async for m in prompt]
        for message in messages:
            yield message

    return query


async def test_events_cost_and_structured_output(setup: tuple[AgentRunner, int, Path],
                                                 monkeypatch: pytest.MonkeyPatch) -> None:
    runner, fid, wt = setup
    seen: dict[str, Any] = {}
    messages = [
        AssistantMessage(content=[
            ThinkingBlock(thinking="hmm", signature="x"),
            TextBlock(text="Writing the failing test first. " * 30),
            ToolUseBlock(id="t1", name="Edit", input={"file_path": str(wt / "src/x.py")}),
            ToolUseBlock(id="t2", name="Bash", input={"command": "uv run   pytest -q"}),
        ], model="claude-opus", usage={"input_tokens": 50_000, "cache_read_input_tokens": 50_000}),
        result(structured_output={"summary": "done", "files_changed": ["src/x.py"]}),
    ]
    monkeypatch.setattr(claude_agent_sdk, "query", fake_query(messages, seen))
    out = await runner.run(job(fid, wt))
    assert out == SweOutput(summary="done", files_changed=["src/x.py"])

    options = seen["options"]
    assert options.allowed_tools == [] and options.permission_mode == "default"
    assert sorted(options.tools) == ["Bash", "Edit", "Read", "Write"]
    assert options.setting_sources == [] and options.cwd == str(wt)
    assert options.output_format["type"] == "json_schema"
    assert options.output_format["schema"]["properties"].keys() >= {"summary", "files_changed"}
    assert options.model == "opus" and "Software Engineer" in options.system_prompt
    assert seen["prompt"][0]["message"]["content"] == "do it"

    events = runner.db.all("SELECT kind, message, data FROM events WHERE feature_id = ? "
                           "ORDER BY id", (fid,))
    kinds = [e["kind"] for e in events]
    assert kinds == ["log", "tool", "tool", "cost"]
    assert len(events[0]["message"]) <= 401
    assert events[1]["message"] == "Edit src/x.py"
    assert events[2]["message"] == "Bash: uv run pytest -q"
    import json
    cost = json.loads(events[3]["data"])
    assert cost == {"cost_usd": 0.42, "model": "opus", "input_tokens": 2000,
                    "output_tokens": 300, "num_turns": 3, "context_pct": 50.0}
    row = runner.db.one("SELECT * FROM features WHERE id = ?", (fid,))
    assert (row["cost_usd"], row["tokens_in"], row["tokens_out"], row["tool_calls"]) == (
        0.42, 2000, 300, 2)
    assert runner.active == {}


async def test_falls_back_to_last_json_in_result_text(setup: tuple[AgentRunner, int, Path],
                                                      monkeypatch: pytest.MonkeyPatch) -> None:
    runner, fid, wt = setup
    text = ('Verdict below.\n```json\n{"verdict": "PASS", "tests_passed": 5, '
            '"tests_total": 5, "report": "ok {fine}"}\n```')
    monkeypatch.setattr(claude_agent_sdk, "query", fake_query([result(result=text)], {}))
    out = await runner.run(job(fid, wt, models.TesterOutput, "tester"))
    assert isinstance(out, models.TesterOutput) and out.verdict == "PASS"


@pytest.mark.parametrize("message", [
    result(result="no json here"),
    result(structured_output={"verdict": "MAYBE"}),
    result(is_error=True, subtype="error_max_turns", errors=["max turns"]),
])
async def test_bad_results_raise_agent_error(setup: tuple[AgentRunner, int, Path],
                                             monkeypatch: pytest.MonkeyPatch,
                                             message: ResultMessage) -> None:
    runner, fid, wt = setup
    monkeypatch.setattr(claude_agent_sdk, "query", fake_query([message], {}))
    with pytest.raises(AgentError):
        await runner.run(job(fid, wt, models.TesterOutput, "tester"))


async def test_missing_result_raises(setup: tuple[AgentRunner, int, Path],
                                     monkeypatch: pytest.MonkeyPatch) -> None:
    runner, fid, wt = setup
    monkeypatch.setattr(claude_agent_sdk, "query", fake_query([], {}))
    with pytest.raises(AgentError, match="without a result"):
        await runner.run(job(fid, wt))


async def test_guard_hook_and_permission_callback(setup: tuple[AgentRunner, int, Path]) -> None:
    runner, fid, wt = setup
    from cowcrew.agents.runner import ActiveRun, RunRecorder

    j = job(fid, wt)
    rec = RunRecorder(runner, j, "opus", ActiveRun(j.agent, fid, j.title))
    options = runner.build_options(j, "opus", rec)
    hook = options.hooks["PreToolUse"][0].hooks[0]
    assert options.hooks["PreToolUse"][0].on_failure == "block"

    denied = await hook({"tool_name": "Bash", "tool_input": {"command": "git push"}}, "tu1", {})
    assert denied["hookSpecificOutput"]["permissionDecision"] == "deny"
    allowed = await hook({"tool_name": "Bash", "tool_input": {"command": "pytest"}}, "tu2", {})
    assert allowed == {}

    ctx = ToolPermissionContext(tool_use_id="tu1")
    assert isinstance(await options.can_use_tool("Bash", {"command": "git push"}, ctx),
                      PermissionResultDeny)
    ctx2 = ToolPermissionContext(tool_use_id="tu3")
    assert isinstance(await options.can_use_tool("Write", {"file_path": str(wt / "a.py")}, ctx2),
                      PermissionResultAllow)
    errors = runner.db.all("SELECT agent, message FROM events WHERE kind = 'error'")
    assert [(e["agent"], e["message"]) for e in errors] == [
        ("software_engineer", "Blocked: git push is reserved for the orchestrator")]


def test_parse_output_and_describe_tool(tmp_path: Path) -> None:
    out = parse_output(SweOutput, None, 'x {"a": 1} then {"summary": "s", "files_changed": []}')
    assert out.summary == "s"
    assert describe_tool("Grep", {"pattern": "TODO"}, tmp_path) == "Grep TODO"
    outside = describe_tool("Read", {"file_path": "/elsewhere/f.py"}, tmp_path)
    assert outside == "Read /elsewhere/f.py"
    assert describe_tool("TodoWrite", {}, tmp_path) == "TodoWrite"
