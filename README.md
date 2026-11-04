# CowCrew: AI Software Factory

CowCrew turns a feature spec into a merged code change. Five AI agents do the work through the
[Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk), and you approve at two
points: the plan and the merge. It runs on your own computer against git repos on your disk,
and a dashboard shows everything that happens as it happens.

## Requirements

- Python 3.11+ and [uv](https://docs.astral.sh/uv/)
- Node 20+ (to build the web UI)
- git
- Optional: the [GitHub CLI](https://cli.github.com/) (`gh auth login`), used to push, open the
  PR and watch CI
- An Anthropic API key (`ANTHROPIC_API_KEY`) or a Claude Code login. Without either, CowCrew
  runs in simulate mode.

## Quick start

```bash
make install     # uv sync + npm ci
make demo        # build the UI, load demo data, serve with simulated agents
```

Then open http://localhost:8787. To work on a real repo, add it as a project in the UI, write
a feature spec and follow it through the pipeline.

| Command      | What it does                                             |
|--------------|----------------------------------------------------------|
| `make dev`   | backend with auto-reload on :8787 and Vite on :5173      |
| `make serve` | build the UI and serve everything on :8787               |
| `make seed`  | load the demo project (`orbit-api`, five features)       |
| `make reset` | wipe the database                                        |
| `make test`  | backend tests and lint                                   |

## How the pipeline works

```
spec → grill → groom → [you approve the plan] → build → accept → review → CI → [you merge]
```

1. **Grill.** The Product Architect reads your spec against the repo and asks up to 5
   questions. If nothing is unclear, it asks none.
2. **Groom.** It writes an ordered task plan with acceptance criteria, at most one ADR, and a
   cost and time estimate. You approve the plan or ask for changes. This is **gate 1**.
3. **Build.** CowCrew creates a git worktree `../<repo>-<slug>` on `feat/<slug>` and commits the
   plan. For each task, the Software Engineer writes code and tests and the Tester verifies them
   adversarially. When the Tester returns PASS, the orchestrator commits the task. A FAIL goes
   back to the engineer with the Tester's report. After `max_attempts` failures, the feature
   pauses so you can step in.
4. **Accept.** The Product Architect checks the feature from the user's point of view. If it
   rejects the feature, all the issues go into one rollup task.
5. **Review.** The PR Reviewer reads the full diff and labels each finding Blocker or Nit. All
   Blockers go into one rollup task, and the review runs again. Nits never block.
6. **CI.** This step runs if the project has a GitHub repo and `gh` is logged in. CowCrew pushes
   the branch, opens the PR and watches the checks. If CI goes red, the On-Call Engineer
   diagnoses the failure and writes a fix task. With no CI configured, this step is skipped.
7. **Merge.** You review a checklist and squash-merge, either through the PR or locally into the
   default branch. This is **gate 2**. You can also send the feature back with a note.
   Optionally, CowCrew opens a follow-up feature for the Nits.

You can pause, resume or stop any feature, and you can leave a note for any agent. The note is
added to that agent's next prompt. Progress is saved in SQLite, so after a restart, running
features come back paused and pick up where they left off when you resume them.

## Safety guardrails

- **Only the orchestrator commits.** Agents can't commit, push, merge, rebase, switch branches
  or run `gh`. Separation of duties: the engineer writes, the tester verifies, the orchestrator
  commits.
- **Every tool call is checked** by a policy in `guard.py`. It runs as a PreToolUse hook that
  fails closed, plus a `can_use_tool` callback. Nothing is pre-approved, and user and project
  Claude settings aren't loaded.
  - Writes stay inside the feature worktree, with symlinks resolved. They can't touch `.git/`,
    `.github/` or other CI config.
  - The Tester can write only under test directories. Read-only agents get no write tools.
  - Reads stay inside the worktree and skip `.env` secrets.
  - Bash can't use `sudo`, `ssh`/`scp`, `curl … | sh`, `cd` out of the worktree, or `rm`,
    redirect or copy outside the agent's write scope.
  - Every blocked call appears in the live log as `Blocked: …`.
- **A weekly budget** pauses the pipeline when spend reaches it.
- **The server binds to 127.0.0.1** by default. It rejects cross-site state-changing requests,
  cross-site WebSockets and unknown `Host` headers (DNS rebinding). It never logs secrets.

The Bash check is a static guard rail for well-behaved agents. It isn't a sandbox: for
untrusted code, run CowCrew in a container or VM.

## Simulate mode

Simulate mode is on when `COWCREW_SIMULATE=1` is set or no credentials are found. Agents are
replaced by a simulator that streams realistic events, including one Tester FAIL followed by a
PASS, a review Blocker, and a red CI run followed by a green one. A whole feature takes about a
minute.

If the project is a real git repo, simulate mode still does the real local git work: the
worktree, the commits and the squash merge. It never pushes and never opens a real PR.
Settings → `simulate` shows which mode is active.

## Configuration

| Variable                | Default       | Meaning                                                     |
|-------------------------|---------------|-------------------------------------------------------------|
| `ANTHROPIC_API_KEY`     | —             | API key for the agents (or log in to Claude Code instead)   |
| `COWCREW_HOME`          | `~/.cowcrew`  | Where `cowcrew.db` lives                                    |
| `COWCREW_SIMULATE`      | auto          | `1` forces simulate mode                                    |
| `COWCREW_PORT`          | `8787`        | Port for `cowcrew serve`                                    |
| `COWCREW_SIM_SPEED`     | `1`           | Multiplier for simulated delays (`0` = instant)             |
| `COWCREW_CI_POLL_SECONDS` | `20`        | How often CI is polled                                      |
| `COWCREW_CI_TIMEOUT_SECONDS` | `2700`   | When a CI wait gives up and pauses                          |
| `COWCREW_FRONTEND_DIST` | `frontend/dist` | Built UI to serve                                         |

Budget, `max_attempts` and the model for each agent are set in the Settings page.

## Credits

CowCrew is inspired by and adapts the agent contracts of
[Squid](https://github.com/iusztinpaul/squid) by Paul Iusztin (Apache-2.0). See [NOTICE](NOTICE).
