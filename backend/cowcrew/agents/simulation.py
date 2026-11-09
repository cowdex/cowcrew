"""Scripted activity and outputs for SimulatedRunner (demo mode, no network).

Deterministic shape, randomised detail: the Tester fails the second plan task once, the PR
Reviewer raises one Blocker in round 1, and acceptance always passes.
"""

from __future__ import annotations

import random
import re
from dataclasses import dataclass, field
from typing import Any

COSTS: dict[str, tuple[float, float]] = {
    "product_architect": (0.18, 0.55),
    "software_engineer": (0.35, 1.10),
    "tester": (0.08, 0.30),
    "pr_reviewer": (0.20, 0.60),
    "oncall_engineer": (0.06, 0.20),
}


@dataclass
class Step:
    kind: str  # "tool" | "text"
    text: str = ""
    tool: str = ""
    tool_input: dict[str, Any] = field(default_factory=dict)


def _module(title: str) -> str:
    words = re.findall(r"[a-z]+", title.lower())
    stop = {"for", "the", "a", "an", "with", "to", "of", "and", "from", "add", "fix", "on"}
    core = [w for w in words if w not in stop][:2] or ["feature"]
    return "_".join(core)


def _tool(name: str, **tool_input: Any) -> Step:
    return Step(kind="tool", tool=name, tool_input=tool_input)


def _say(text: str) -> Step:
    return Step(kind="text", text=text)


def script_for(phase: str, ctx: dict[str, Any], rng: random.Random) -> list[Step]:
    """The stream of tool calls and narration an agent would plausibly produce."""
    mod = _module(str(ctx.get("task_title") or ctx.get("feature_title") or "feature"))
    src, test = f"src/app/{mod}.py", f"tests/unit/test_{mod}.py"
    scripts: dict[str, list[Step]] = {
        "grill": [
            _tool("Read", file_path="AGENTS.md"),
            _tool("Glob", pattern="docs/adr/*.md"),
            _tool("Grep", pattern=mod.split("_")[0]),
            _say("Reading the spec against the codebase; a few scope decisions are still open."),
        ],
        "groom": [
            _tool("Read", file_path="CLAUDE.md"),
            _tool("Glob", pattern="src/**/*.py"),
            _tool("Read", file_path="src/app/main.py"),
            _tool("Grep", pattern="def create_app"),
            _say("Decomposing into atomic tasks in dependency order, one ADR for the design."),
        ],
        "implement": [
            _tool("Read", file_path=src),
            _say(f"Writing failing tests first for '{ctx.get('task_title', 'the task')}'."),
            _tool("Write", file_path=test),
            _tool("Bash", command=f"uv run pytest {test} -q"),
            _tool("Edit", file_path=src),
            _tool("Bash", command="uv run pytest -q"),
            _tool("Bash", command="uv run ruff check ."),
            _say("Tests green and lint clean; handing to the Tester. Not committing."),
        ],
        "test": [
            _tool("Bash", command="git diff --stat"),
            _tool("Bash", command="uv run pytest -q"),
            _say("Suite green; now the adversarial pass: empty input, oversized payload, "
                 "concurrent calls."),
            _tool("Bash", command=f"uv run python -m app.{mod} --input ''"),
        ],
        "accept": [
            _tool("Bash", command="git log --oneline -10"),
            _tool("Grep", pattern="raise HTTPException"),
            _say("Walking each user story from the user's side: copy, empty states, errors."),
        ],
        "review": [
            _tool("Bash", command="git diff --stat main...HEAD"),
            _tool("Read", file_path=src),
            _tool("Read", file_path=test),
            _say("Reviewed every changed file across performance, clean code, tests, "
                 "standards and simplicity."),
        ],
        "diagnose": [
            _tool("Read", file_path=".github/workflows/ci.yml"),
            _tool("Bash", command="uv run pytest -q -p no:randomly"),
            _say("Reproduced locally; the failure only shows with the CI test ordering."),
        ],
    }
    steps = scripts[phase]
    if phase == "implement" and rng.random() < 0.5:
        steps = [*steps[:3], _tool("Grep", pattern=f"{mod}("), *steps[3:]]
    return steps


def output_for(phase: str, ctx: dict[str, Any], rng: random.Random) -> dict[str, Any]:
    title = str(ctx.get("feature_title", "the feature"))
    mod = _module(title)
    if phase == "grill":
        if ctx.get("skip_questions"):
            return {"questions": []}
        return {"questions": [
            {"question": f"Should '{title}' ship to every user at once, or behind a feature "
                         "flag first?",
             "options": ["Behind a feature flag first", "Every user at once"],
             "recommended": 0},
            {"question": "On failure, should we fail closed with a clear error, or degrade "
                         "gracefully and log a warning?",
             "options": ["Fail closed with a clear error", "Degrade gracefully and log a warning"],
             "recommended": 0},
            {"question": "Any hard constraints to respect — latency budget, supported API "
                         "versions, or data retention?",
             "options": ["None beyond what the repo already does", "Yes, I'll list them"],
             "recommended": 0},
        ]}
    if phase == "groom":
        return {
            "tasks": [
                {"title": f"Configuration and data model for {title.lower()}",
                 "description": "Add settings and persistence the feature needs.",
                 "acceptance_criteria": ["Settings load from env with safe defaults",
                                         "Migration applies and rolls back cleanly"],
                 "depends_on": "", "label": "data"},
                {"title": f"Core {mod.replace('_', ' ')} logic",
                 "description": "Implement the business rules behind the feature.",
                 "acceptance_criteria": ["Happy path returns the documented result",
                                         "Invalid input is rejected with a clear error"],
                 "depends_on": "001", "label": "core"},
                {"title": "Expose it through the public API",
                 "description": "Wire the logic into the HTTP layer with validation.",
                 "acceptance_criteria": ["Endpoint documented in OpenAPI",
                                         "Unauthenticated calls get 401"],
                 "depends_on": "002", "label": "api"},
                {"title": "Docs and end-to-end coverage",
                 "description": "User-facing docs and an e2e test of the main story.",
                 "acceptance_criteria": ["README section explains the feature",
                                         "E2E test covers the main user story"],
                 "depends_on": "003", "label": "docs"},
            ],
            "adr": {"title": f"{title} design",
                    "body": "## Status\nAccepted\n\n## Context\nThe feature needs a clear "
                            "boundary between policy and transport.\n\n## Decision\nKeep the "
                            "logic in one service module, reuse the existing settings loader."
                            "\n\n## Consequences\nOne place to change behaviour; no new "
                            "dependencies."},
            "glossary_terms": [mod.replace("_", " ").title(), "Policy"],
            "estimate": {"hours_min": 2, "hours_max": 4, "cost_min": 6, "cost_max": 14,
                         "files": rng.randint(6, 12)},
        }
    if phase == "implement":
        return {"summary": f"Implemented '{ctx.get('task_title')}' with tests; suite green.",
                "files_changed": [f"src/app/{mod}.py", f"tests/unit/test_{mod}.py"]}
    if phase == "test":
        total = rng.randint(40, 120)
        if ctx.get("seq") == 2 and ctx.get("attempt") == 1 and ctx.get("kind") == "plan":
            return {"verdict": "FAIL", "tests_passed": total - 1, "tests_total": total,
                    "report": "FAIL — empty input raises ValueError instead of the documented "
                              f"400 response (src/app/{mod}.py:42). Add a regression test and "
                              "validate before parsing."}
        return {"verdict": "PASS", "tests_passed": total, "tests_total": total,
                "report": "PASS — all acceptance criteria verified; 3 break paths tried "
                          "(empty, oversized, concurrent), all handled."}
    if phase == "accept":
        criteria = list(ctx.get("criteria") or ["Feature behaves as specified"])[:6]
        return {"verdict": "ACCEPT", "summary": "Does what the spec asked, with clear errors "
                                                "and sensible defaults.",
                "criteria": [{"text": c, "met": True} for c in criteria], "issues": []}
    if phase == "review":
        nits = [{"severity": "Nit", "file": f"src/app/{mod}.py", "line": rng.randint(10, 90),
                 "text": "naming: prefer a verb for this helper"}]
        if int(ctx.get("round", 1)) == 1:
            return {"findings": [
                {"severity": "Blocker", "file": f"src/app/{mod}.py", "line": rng.randint(20, 80),
                 "text": "Untested error branch: the timeout path has no test."},
                *nits,
                {"severity": "Nit", "file": "README.md", "line": None,
                 "text": "doc polish: add an example request"},
            ]}
        return {"findings": nits}
    if phase == "diagnose":
        return {
            "root_cause": "Test relies on dict ordering from a shared fixture; CI runs tests "
                          "in a different order.",
            "responsible_task": str(ctx.get("responsible_task", "002")),
            "why_missed": "Locally the suite runs in file order, so the shared state "
                          "never leaked.",
            "fix_task": {"title": "Isolate shared fixture state in tests",
                         "description": "Make the fixture function-scoped and sort before "
                                        "asserting.",
                         "acceptance_criteria": ["Suite passes with random ordering",
                                                 "No test mutates module-level state"]},
        }
    raise ValueError(f"unknown phase {phase}")


def cost_for(agent: str, rng: random.Random) -> float:
    lo, hi = COSTS.get(agent, (0.1, 0.3))
    return round(rng.uniform(lo, hi), 4)
