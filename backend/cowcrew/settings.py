"""Runtime configuration: environment variables, credential detection, and the settings table."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

from cowcrew.db import Database
from cowcrew.models import DEFAULT_MODELS, Settings, SettingsUpdate

DEFAULT_PORT = 8787
DEFAULT_BUDGET_USD = 150.0
DEFAULT_MAX_ATTEMPTS = 4


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    try:
        return float(raw) if raw else default
    except ValueError:
        return default


def has_credentials() -> bool:
    """True when the Agent SDK can authenticate: API key, cloud provider, or Claude Code login."""
    if any(
        os.environ.get(k)
        for k in (
            "ANTHROPIC_API_KEY",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
        )
    ):
        return True
    config_dir = Path(os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude"))
    if (config_dir / ".credentials.json").is_file():
        return True
    return _macos_keychain_login()


def _macos_keychain_login() -> bool:
    """On macOS, Claude Code keeps its login in the Keychain instead of a file."""
    if sys.platform != "darwin":
        return False
    try:
        found = subprocess.run(
            ["security", "find-generic-password", "-s", "Claude Code-credentials"],
            capture_output=True, timeout=5, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return found.returncode == 0


_gh_cache: tuple[float, bool] | None = None


def gh_available() -> bool:
    """`gh auth status` succeeds (cached for 60 s)."""
    global _gh_cache
    now = time.monotonic()
    if _gh_cache and now - _gh_cache[0] < 60:
        return _gh_cache[1]
    ok = False
    if shutil.which("gh"):
        try:
            ok = (
                subprocess.run(
                    ["gh", "auth", "status"], capture_output=True, timeout=10, check=False
                ).returncode
                == 0
            )
        except (OSError, subprocess.TimeoutExpired):
            ok = False
    _gh_cache = (now, ok)
    return ok


@dataclass(frozen=True)
class Config:
    """Process-level configuration, read once from the environment."""

    home: Path
    simulate: bool
    has_credentials: bool
    frontend_dist: Path
    sim_speed: float = 1.0  # multiplier on simulated sleeps; 0 = instant
    ci_poll_seconds: float = 20.0
    ci_timeout_seconds: float = 45 * 60.0
    ci_no_runs_grace_seconds: float = 120.0

    @property
    def db_path(self) -> Path:
        return self.home / "cowcrew.db"

    @classmethod
    def from_env(cls) -> Config:
        home = Path(os.environ.get("COWCREW_HOME", Path.home() / ".cowcrew")).expanduser()
        creds = has_credentials()
        simulate = os.environ.get("COWCREW_SIMULATE", "") in {"1", "true", "yes"} or not creds
        dist_env = os.environ.get("COWCREW_FRONTEND_DIST")
        dist = (
            Path(dist_env).expanduser()
            if dist_env
            else Path(__file__).resolve().parents[2] / "frontend" / "dist"
        )
        return cls(
            home=home,
            simulate=simulate,
            has_credentials=creds,
            frontend_dist=dist,
            sim_speed=_env_float("COWCREW_SIM_SPEED", 1.0),
            ci_poll_seconds=_env_float("COWCREW_CI_POLL_SECONDS", 20.0),
            ci_timeout_seconds=_env_float("COWCREW_CI_TIMEOUT_SECONDS", 45 * 60.0),
        )


class SettingsStore:
    """User-editable settings persisted in the `settings` table."""

    def __init__(self, db: Database, config: Config) -> None:
        self.db = db
        self.config = config

    @property
    def budget_usd_week(self) -> float:
        return float(self.db.get_setting("budget_usd_week", DEFAULT_BUDGET_USD))

    @property
    def max_attempts(self) -> int:
        return int(self.db.get_setting("max_attempts", DEFAULT_MAX_ATTEMPTS))

    @property
    def models(self) -> dict[str, str]:
        stored = self.db.get_setting("models", {}) or {}
        return {k: stored.get(k, v) for k, v in DEFAULT_MODELS.items()}

    def model_for(self, agent: str) -> str:
        return self.models.get(agent, "sonnet")

    def update(self, body: SettingsUpdate) -> None:
        if body.budget_usd_week is not None:
            self.db.set_setting("budget_usd_week", body.budget_usd_week)
        if body.max_attempts is not None:
            self.db.set_setting("max_attempts", body.max_attempts)
        if body.models is not None:
            self.db.set_setting("models", {**self.models, **body.models})

    def view(self) -> Settings:
        return Settings(
            budget_usd_week=self.budget_usd_week,
            max_attempts=self.max_attempts,
            models=self.models,  # type: ignore[arg-type]
            simulate=self.config.simulate,
            has_credentials=self.config.has_credentials,
            gh_available=gh_available(),
        )
