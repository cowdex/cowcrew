"""Tool-use policy enforced on every agent tool call (wired as PreToolUse hook + can_use_tool).

The policy is pure and deterministic so it can be unit-tested without the SDK:

* each agent only gets the tools of its role (read-only agents get no write tools at all);
* file writes must stay inside the worktree (symlinks resolved), never touch `.git/`,
  `.github/` or other CI configuration, and the Tester may write only under test directories;
* reads stay inside the worktree (plus the temp dir) and never open `.env` secrets;
* Bash may not push/commit/merge, call `gh`, escalate privileges, pipe downloads into a shell,
  open remote shells, `cd` out of the worktree, or delete/redirect/copy outside its write scope.

Bash analysis is a best-effort static check of the command line. It is a guard rail for
well-intentioned agents, not a sandbox against an adversary.
"""

from __future__ import annotations

import os
import re
import shlex
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

WriteScope = Literal["any", "tests", "none"]

WRITE_TOOLS = frozenset({"Edit", "Write", "MultiEdit", "NotebookEdit"})
READ_TOOLS = frozenset({"Read", "Glob", "Grep"})
# How the SDK hands back a structured result. It only returns data, so every agent may call it.
RESULT_TOOLS = frozenset({"StructuredOutput"})

TEST_DIRS = frozenset({"tests", "test", "__tests__", "spec", "specs", "testing"})
CI_DIRS = frozenset({".github", ".circleci", ".buildkite", ".gitlab"})
CI_FILES = frozenset({
    ".gitlab-ci.yml", ".travis.yml", "Jenkinsfile", "azure-pipelines.yml",
    "bitbucket-pipelines.yml", ".drone.yml", "appveyor.yml", "cloudbuild.yaml",
})
SAFE_SINKS = frozenset({"/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"})
ENV_FILE_OK_SUFFIXES = (".example", ".sample", ".template", ".dist")

BLOCKED_GIT = frozenset({
    "push", "commit", "merge", "rebase", "cherry-pick", "revert", "am", "tag", "remote",
    "config", "worktree", "filter-branch", "update-ref", "replace", "switch",
})
GIT_OPTS_WITH_VALUE = frozenset({"-C", "-c", "--git-dir", "--work-tree", "--namespace"})
PRIVILEGE = frozenset({"sudo", "su", "doas", "pkexec", "runas"})
REMOTE_SHELL = frozenset({"ssh", "scp", "sftp", "ssh-copy-id", "telnet", "nc", "ncat", "socat"})
WRAPPERS = frozenset({"env", "command", "exec", "nohup", "time", "nice", "timeout", "stdbuf",
                      "xargs", "builtin"})
SHELLS = frozenset({"sh", "bash", "zsh", "dash", "ksh", "fish"})
COPY_LIKE = frozenset({"cp", "mv", "install", "ln", "rsync"})

PIPE_TO_SHELL = (
    re.compile(
        r"\b(curl|wget|fetch|iwr|Invoke-WebRequest)\b[^\n]*\|\s*(sudo\s+)?(\S*/)?"
        r"(ba|z|da|k|fi)?sh\b|\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(\S*/)?"
        r"(python[\d.]*|perl|ruby|node)\b",
        re.IGNORECASE,
    ),
    re.compile(r"\b(ba|z|da|k)?sh\b[^\n]*(<\(|\$\(|`)\s*(curl|wget)\b", re.IGNORECASE),
)
SEGMENT_SPLIT = re.compile(r"\|\||&&|[;|&\n]|\$\(|`|<\(|\(|\)")
REDIRECT = re.compile(r"(?<![=\-])(?:\d?>>?|&>>?)\s*([^\s;|&<>()]+)")


@dataclass(frozen=True)
class Decision:
    allowed: bool
    reason: str = ""


ALLOW = Decision(True)


def _deny(reason: str) -> Decision:
    return Decision(False, reason)


def _is_within(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


class ToolPolicy:
    """Decides whether one agent may make one tool call."""

    def __init__(
        self, agent: str, root: Path | str, tools: frozenset[str] | set[str],
        write_scope: WriteScope,
    ) -> None:
        self.agent = agent
        self.root = Path(root).resolve()
        self.tools = frozenset(tools)
        self.write_scope: WriteScope = write_scope if self.tools & WRITE_TOOLS else "none"
        self._tmp_roots = tuple({Path(tempfile.gettempdir()).resolve(), Path("/tmp").resolve()})  # noqa: S108

    # ------------------------------------------------------------------ entry point

    def check(self, tool_name: str, tool_input: dict[str, Any]) -> Decision:
        if tool_name in RESULT_TOOLS:
            return ALLOW
        if tool_name not in self.tools:
            return _deny(f"{tool_name} is not available to this agent")
        if tool_name in WRITE_TOOLS:
            target = tool_input.get("file_path") or tool_input.get("notebook_path")
            if not isinstance(target, str) or not target:
                return _deny(f"{tool_name} without a file path")
            return self.check_write(target, cwd=self.root, via_bash=False)
        if tool_name in READ_TOOLS:
            return self._check_read(tool_name, tool_input)
        if tool_name == "Bash":
            command = tool_input.get("command")
            if not isinstance(command, str):
                return _deny("Bash without a command")
            return self.check_bash(command)
        return ALLOW

    # ------------------------------------------------------------------ paths

    def _resolve(self, raw: str, cwd: Path) -> Path:
        path = Path(os.path.expanduser(raw))
        if not path.is_absolute():
            path = cwd / path
        return path.resolve(strict=False)

    def _in_tmp(self, path: Path) -> bool:
        return any(_is_within(path, t) for t in self._tmp_roots)

    def check_write(
        self, raw: str, *, cwd: Path, via_bash: bool, allow_tmp: bool = True,
    ) -> Decision:
        """Writes go inside the worktree within the agent's scope (Bash may also use /tmp)."""
        raw = raw.strip("\"'")
        if via_bash and (raw in SAFE_SINKS or raw.startswith("/dev/fd/")):
            return ALLOW
        if "$" in raw or "`" in raw:
            return _deny(f"cannot verify write target {raw!r} (shell expansion)")
        path = self._resolve(raw, cwd)
        if not _is_within(path, self.root):
            if via_bash and allow_tmp and self._in_tmp(path):
                return ALLOW
            return _deny(f"write outside the worktree: {raw}")
        rel = path.relative_to(self.root).parts
        if ".git" in rel:
            return _deny(f"git internals are off-limits: {raw}")
        if (rel and rel[0] in CI_DIRS) or (rel and rel[-1] in CI_FILES):
            return _deny(f"CI configuration is protected: {raw}")
        if self.write_scope == "none":
            return _deny(f"{self.agent} is read-only and may not write {raw}")
        if self.write_scope == "tests" and not TEST_DIRS.intersection(rel[:-1]):
            return _deny(f"Tester may only write under tests/: {raw}")
        return ALLOW

    def _check_read(self, tool: str, tool_input: dict[str, Any]) -> Decision:
        raw = tool_input.get("file_path") if tool == "Read" else tool_input.get("path")
        if tool == "Glob" and not raw:
            pattern = str(tool_input.get("pattern", ""))
            if pattern.startswith(("/", "~")):
                raw = re.split(r"[*?\[{]", pattern, maxsplit=1)[0] or "/"
        if not raw:
            return ALLOW  # defaults to the agent's cwd, which is the worktree
        path = self._resolve(str(raw), self.root)
        if not (_is_within(path, self.root) or self._in_tmp(path)):
            return _deny(f"read outside the worktree: {raw}")
        name = path.name
        if (name == ".env" or name.startswith(".env.")) and not name.endswith(
            ENV_FILE_OK_SUFFIXES
        ):
            return _deny(f"secrets file is off-limits: {raw}")
        return ALLOW

    # ------------------------------------------------------------------ bash

    def check_bash(self, command: str) -> Decision:
        for pattern in PIPE_TO_SHELL:
            if pattern.search(command):
                return _deny("piping a download into an interpreter is not allowed")
        cwd = self.root
        for segment in SEGMENT_SPLIT.split(command):
            segment = segment.strip()
            if not segment:
                continue
            decision, cwd = self._check_segment(segment, cwd)
            if not decision.allowed:
                return decision
        return ALLOW

    def _check_segment(self, segment: str, cwd: Path) -> tuple[Decision, Path]:
        for target in REDIRECT.findall(segment):
            decision = self.check_write(target, cwd=cwd, via_bash=True)
            if not decision.allowed:
                return decision, cwd
        tokens = _tokens(REDIRECT.sub(" ", segment))
        tokens = _unwrap(tokens)
        if not tokens:
            return ALLOW, cwd
        prog = os.path.basename(tokens[0])
        args = tokens[1:]

        if prog in SHELLS and "-c" in args:
            idx = args.index("-c")
            inner = args[idx + 1] if idx + 1 < len(args) else ""
            return self.check_bash(inner), cwd
        if prog == "eval":
            return self.check_bash(" ".join(args)), cwd
        if prog in PRIVILEGE:
            return _deny(f"privilege escalation ({prog}) is not allowed"), cwd
        if prog in REMOTE_SHELL or (prog == "rsync" and any(":" in a for a in args)):
            return _deny(f"remote connections ({prog}) are not allowed"), cwd
        if prog == "gh":
            return _deny("the GitHub CLI is reserved for the orchestrator"), cwd
        if prog == "git":
            return self._check_git(args), cwd
        if prog in {"cd", "pushd"}:
            return self._check_cd(args, cwd)
        if prog == "rm":
            return self._check_rm(args, cwd), cwd
        if prog == "find" and any(a in {"-delete", "-exec", "-execdir"} for a in args):
            starts = [a for a in args if not a.startswith("-")][:1] or ["."]
            return self._writes(starts, cwd), cwd
        if prog == "tee":
            return self._writes([a for a in args if not a.startswith("-")], cwd), cwd
        if prog in COPY_LIKE:
            operands = [a for a in args if not a.startswith("-")]
            targets = operands[-1:] if len(operands) >= 2 else []
            if prog == "mv":
                targets = operands  # moving a file away also modifies its source
            return self._writes(targets, cwd), cwd
        return ALLOW, cwd

    def _writes(self, targets: list[str], cwd: Path) -> Decision:
        for target in targets:
            decision = self.check_write(target, cwd=cwd, via_bash=True)
            if not decision.allowed:
                return decision
        return ALLOW

    def _check_git(self, args: list[str]) -> Decision:
        i = 0
        while i < len(args) and args[i].startswith("-"):
            i += 2 if args[i] in GIT_OPTS_WITH_VALUE else 1
        if i >= len(args):
            return ALLOW
        sub, rest = args[i], args[i + 1:]
        if sub in BLOCKED_GIT:
            return _deny(f"git {sub} is reserved for the orchestrator")
        if sub == "checkout" and any(a in {"-b", "-B", "--orphan"} for a in rest):
            return _deny("switching branches is reserved for the orchestrator")
        if sub == "branch" and any(a in {"-d", "-D", "-m", "-M", "--delete"} for a in rest):
            return _deny("deleting or renaming branches is not allowed")
        return ALLOW

    def _check_cd(self, args: list[str], cwd: Path) -> tuple[Decision, Path]:
        target = next((a for a in args if not a.startswith("-")), None)
        if target is None or target.startswith("~") or "$" in target:
            return _deny("cd outside the worktree is not allowed"), cwd
        path = self._resolve(target, cwd)
        if not (_is_within(path, self.root) or self._in_tmp(path)):
            return _deny(f"cd outside the worktree is not allowed: {target}"), cwd
        return ALLOW, path

    def _check_rm(self, args: list[str], cwd: Path) -> Decision:
        recursive = any(
            a == "--recursive" or (re.fullmatch(r"-[a-zA-Z]+", a) and "r" in a.lower())
            for a in args
        )
        targets = [a for a in args if not a.startswith("-")]
        for target in targets:
            if target.startswith("~") or "$" in target or "`" in target:
                return _deny(f"rm of an unverifiable or home path is not allowed: {target}")
            prefix = re.split(r"[*?\[{]", target, maxsplit=1)[0] or "."
            path = self._resolve(prefix, cwd)
            if recursive and path == self.root:
                return _deny("rm -r of the whole worktree is not allowed")
            decision = self.check_write(prefix, cwd=cwd, via_bash=True, allow_tmp=False)
            if not decision.allowed:
                return _deny(f"rm outside the agent's write scope: {target} ({decision.reason})")
        return ALLOW


def _tokens(segment: str) -> list[str]:
    try:
        return shlex.split(segment, posix=True)
    except ValueError:
        return segment.split()


def _unwrap(tokens: list[str]) -> list[str]:
    """Strip env assignments and wrapper commands (env, nohup, timeout 5, xargs -0 ...)."""
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", tok):
            i += 1
            continue
        name = os.path.basename(tok)
        if name in WRAPPERS:
            i += 1
            while i < len(tokens) and (
                tokens[i].startswith("-")
                or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", tokens[i])
                or (name == "timeout" and re.fullmatch(r"\d+[smhd]?", tokens[i]))
            ):
                i += 1
            continue
        break
    return tokens[i:]
