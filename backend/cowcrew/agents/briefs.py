"""Per-run user prompts ("briefs") that the orchestrator hands to each agent.

The role discipline lives in prompts/<agent>.md (system prompt); a brief only carries the facts
of this run: the spec, the task, the previous report, the diff, the CI log, human notes.
"""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path

from cowcrew.models import Task

PREAMBLE = """\
Working directory: {cwd}
Before anything else, read AGENTS.md and CLAUDE.md at the repository root if they exist and
follow their conventions (also docs/adr/ and docs/glossary.md when present).
"""

CLOSING = """
When you are done, reply with the JSON object required by the output schema and nothing else."""


def _bullets(items: Iterable[str]) -> str:
    return "\n".join(f"- {item}" for item in items) or "- (none)"


def _task_block(task: Task) -> str:
    return (
        f"Task {task.seq:03d} ({task.kind}): {task.title}\n"
        f"Label: {task.label or '-'} · Depends on: {task.depends_on or 'none'}\n\n"
        f"Scope:\n{task.description}\n\nAcceptance criteria:\n{_bullets(task.acceptance_criteria)}"
    )


def with_notes(prompt: str, notes: list[str]) -> str:
    """Append queued human notes to a brief."""
    if not notes:
        return prompt
    return f"{prompt}\n\nNotes from the human (take these into account):\n{_bullets(notes)}"


def _wrap(cwd: Path, body: str) -> str:
    return PREAMBLE.format(cwd=cwd) + "\n" + body.strip() + "\n" + CLOSING


def grill(cwd: Path, title: str, spec: str) -> str:
    return _wrap(cwd, f"""
MODE: grilling. Read the feature spec below against the codebase and return the questions that
must be answered before the work can be planned — at most 5, each one specific and decision-
shaped (offer your recommended answer in the question). Anything you can answer by reading the
code or docs, explore instead of asking. If nothing is genuinely open, return an empty list.

Feature: {title}

Spec:
{spec}
""")


def groom(
    cwd: Path, title: str, spec: str, qa: list[tuple[str, str]], change_note: str | None
) -> str:
    answers = "\n".join(f"Q: {q}\nA: {a}" for q, a in qa) or "(no questions were asked)"
    note = (f"\nThe human requested changes to the previous plan:\n{change_note}\n"
            if change_note else "")
    return _wrap(cwd, f"""
MODE: feature-level grooming. Decompose the feature into the smallest ordered set of atomic,
independently shippable tasks (typically 3-8), each with testable acceptance criteria. Draft at
most ONE ADR for the whole feature if it involves a non-obvious architectural decision (else
null), list any new glossary terms, and estimate effort (hours, agent cost in USD, files
touched). Write nothing to disk — the orchestrator writes the approved plan.

Feature: {title}

Spec:
{spec}

Grilling Q&A:
{answers}
{note}""")


def implement(cwd: Path, title: str, task: Task, attempt: int, tester_report: str | None) -> str:
    retry = ""
    if tester_report:
        retry = (f"\nThis is attempt {attempt}. The Tester FAILED the previous attempt with this "
                 f"report — fix every issue (regression test first for behaviour bugs):\n"
                 f"{tester_report}\n")
    return _wrap(cwd, f"""
Implement this task for the feature "{title}". Write code AND tests, run the project's
format/lint/test loop until clean, and exercise the feature end to end. Stay on the current
branch. DO NOT commit, push or create branches: the orchestrator commits after the Tester passes.

{_task_block(task)}
{retry}""")


def test(cwd: Path, title: str, task: Task, swe_summary: str) -> str:
    return _wrap(cwd, f"""
QA this task for the feature "{title}". The SWE's work is uncommitted in the working tree
(see `git status` / `git diff`). Run the full suite, code-review the diff, then do the
adversarial end-to-end pass (at least 3 break paths). Verify every acceptance criterion with
evidence. You may only add or edit files under tests/. Verdict PASS or FAIL; a FAIL report must
be actionable (file:line, command, expected vs actual).

{_task_block(task)}

SWE hand-off:
{swe_summary}
""")


def accept(cwd: Path, title: str, spec: str, tasks: list[Task], base: str) -> str:
    plan = "\n\n".join(_task_block(t) for t in tasks)
    return _wrap(cwd, f"""
MODE: acceptance review for the feature "{title}". All tasks are committed on this branch
(`git log {base}..HEAD`, `git diff {base}...HEAD`). Judge from the user's perspective whether
the feature is right: flows, copy, errors, empty states, consistency, documentation discipline.
Do not modify anything. Verdict ACCEPT or REJECT; on REJECT list every issue (they become one
rollup task).

Spec:
{spec}

Tasks plan:
{plan}
""")


def review(cwd: Path, title: str, base: str, diff: str, round_no: int, prior: list[str]) -> str:
    previous = (f"\nBlockers from the previous round (confirm each is fixed):\n{_bullets(prior)}\n"
                if prior else "")
    return _wrap(cwd, f"""
Review round {round_no} for the feature "{title}" (branch diff against {base} below; use
`git diff {base}...HEAD -- <path>` and Read for more context). Walk every review dimension and
tag every finding Blocker or Nit per the Severity Rule. Do not modify anything.
{previous}
{diff}
""")


def diagnose(cwd: Path, title: str, failing_job: str | None, log: str, tasks: list[Task]) -> str:
    index = "\n".join(f"- {t.seq:03d} {t.title}" for t in tasks)
    return _wrap(cwd, f"""
CI went red for the feature "{title}" (failing job: {failing_job or 'unknown'}). Diagnose the
root cause, reproduce locally with the same command if you can, trace it to the responsible
task, explain why the local loop missed it, and write ONE concrete fix task for the SWE.
You do not change application code.

Tasks on this branch:
{index}

Failed log (truncated):
{log}
""")
