"""Git operations via the `git` CLI (blocking; the orchestrator calls them in a worker thread)."""

from __future__ import annotations

import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

from cowcrew.guard import CI_DIRS, CI_FILES

GIT_TIMEOUT = 120


class GitError(Exception):
    """A git command failed."""


@dataclass(frozen=True)
class DiffSummary:
    files: int
    additions: int
    deletions: int
    protected_touched: bool


def git(cwd: Path | str, *args: str, check: bool = True) -> str:
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C"}
    try:
        proc = subprocess.run(
            ["git", *args], cwd=str(cwd), capture_output=True, text=True,
            timeout=GIT_TIMEOUT, env=env, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise GitError(f"git {args[0]} failed: {exc}") from exc
    if check and proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip().splitlines()
        raise GitError(f"git {' '.join(args[:2])} failed: {detail[-1] if detail else 'error'}")
    return proc.stdout.strip()


def is_git_repo(path: Path | str) -> bool:
    p = Path(path)
    if not p.is_dir():
        return False
    try:
        return git(p, "rev-parse", "--is-inside-work-tree") == "true"
    except GitError:
        return False


def default_branch(repo: Path | str) -> str:
    """origin/HEAD if known, else the currently checked-out branch, else 'main'."""
    ref = git(repo, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD", check=False)
    if ref.startswith("origin/"):
        return ref.removeprefix("origin/")
    current = git(repo, "symbolic-ref", "--quiet", "--short", "HEAD", check=False)
    return current or "main"


def slugify(text: str, limit: int = 40) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return (slug[:limit].rstrip("-")) or "feature"


def branch_exists(repo: Path | str, branch: str) -> bool:
    return bool(git(repo, "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}", check=False))


def create_worktree(repo: Path | str, path: Path, branch: str, base: str) -> None:
    if path.exists() and any(path.iterdir()):
        raise GitError(f"worktree path already exists: {path}")
    git(repo, "worktree", "add", "-b", branch, str(path), base)


def write_files(root: Path, files: dict[str, str]) -> None:
    for rel, content in files.items():
        target = (root / rel).resolve()
        if root.resolve() not in target.parents:
            raise GitError(f"refusing to write outside the worktree: {rel}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")


def _identity(cwd: Path | str) -> list[str]:
    if git(cwd, "config", "user.email", check=False):
        return []
    return ["-c", "user.name=CowCrew", "-c", "user.email=cowcrew@localhost"]


def commit_all(cwd: Path | str, message: str) -> str:
    """Stage everything and commit (empty commits allowed); returns the new HEAD sha."""
    git(cwd, "add", "-A")
    git(cwd, *_identity(cwd), "commit", "--allow-empty", "-m", message)
    return head_sha(cwd)


def head_sha(cwd: Path | str) -> str:
    return git(cwd, "rev-parse", "HEAD")


def diff_summary(cwd: Path | str, base: str) -> DiffSummary:
    out = git(cwd, "diff", "--numstat", f"{base}...HEAD")
    files = adds = dels = 0
    protected = False
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        files += 1
        adds += int(parts[0]) if parts[0].isdigit() else 0
        dels += int(parts[1]) if parts[1].isdigit() else 0
        path_parts = Path(parts[2]).parts
        if path_parts and (path_parts[0] in CI_DIRS or path_parts[-1] in CI_FILES):
            protected = True
    return DiffSummary(files, adds, dels, protected)


def diff_text(cwd: Path | str, base: str, limit: int = 60_000) -> str:
    stat = git(cwd, "diff", "--stat", f"{base}...HEAD")
    body = git(cwd, "diff", f"{base}...HEAD")
    if len(body) > limit:
        body = body[:limit] + "\n… diff truncated; read remaining files with `git diff` …"
    return f"{stat}\n\n{body}"


def is_dirty(repo: Path | str) -> bool:
    return bool(git(repo, "status", "--porcelain"))


def current_branch(repo: Path | str) -> str:
    return git(repo, "symbolic-ref", "--quiet", "--short", "HEAD", check=False)


def squash_merge(repo: Path | str, branch: str, message: str) -> str:
    """Squash `branch` onto the checked-out branch; on conflict, restore a clean checkout."""
    try:
        git(repo, "merge", "--squash", branch)
        git(repo, *_identity(repo), "commit", "-m", message)
    except GitError:
        git(repo, "reset", "--merge", check=False)
        raise
    return head_sha(repo)


def remove_worktree(repo: Path | str, path: Path | None, branch: str) -> None:
    if path is not None and path.exists():
        git(repo, "worktree", "remove", "--force", str(path))
    git(repo, "branch", "-D", branch, check=False)


def next_adr_number(root: Path) -> int:
    adr_dir = root / "docs" / "adr"
    numbers = [
        int(m.group(1))
        for p in (adr_dir.iterdir() if adr_dir.is_dir() else [])
        if (m := re.match(r"(\d{4})", p.name))
    ]
    return max(numbers, default=0) + 1
