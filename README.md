<p align="center">
  <img src="docs/assets/banner.png" alt="CowCrew, AI Software Factory: turn a feature spec into a merged pull request. Five AI agents do the work. You approve the plan and the merge." width="100%">
</p>

<p align="center">
  <img alt="Python 3.11+" src="https://img.shields.io/badge/python-3.11%2B-171321?style=flat-square&labelColor=45424D">
  <img alt="React 18" src="https://img.shields.io/badge/react-18-7759C2?style=flat-square&labelColor=45424D">
  <img alt="Claude Agent SDK" src="https://img.shields.io/badge/agents-Claude%20Agent%20SDK-FC6D26?style=flat-square&labelColor=45424D">
  <img alt="140 backend tests" src="https://img.shields.io/badge/tests-140%20passing-10B1B1?style=flat-square&labelColor=45424D">
  <img alt="Runs locally" src="https://img.shields.io/badge/runs-on%20your%20machine-A989F5?style=flat-square&labelColor=45424D">
</p>

<p align="center">
  <a href="#quick-start"><b>Quick start</b></a> ·
  <a href="#how-it-works"><b>How it works</b></a> ·
  <a href="#meet-the-crew"><b>The crew</b></a> ·
  <a href="#example-shortly"><b>Example</b></a> ·
  <a href="#a-tour-of-the-dashboard"><b>Tour</b></a> ·
  <a href="#whats-new"><b>What's new</b></a> ·
  <a href="#safety-guardrails"><b>Safety</b></a>
</p>

<br>

<p align="center">
  <img src="docs/assets/screen-overview.png" alt="CowCrew factory overview: gates waiting on you, key numbers, task board, agent spend" width="100%">
</p>

CowCrew is a software factory that runs on your own computer. You write a few lines about the
feature you want. A crew of five AI agents plans it, builds it task by task, tests it, reviews
it and gets CI green, all inside its own git worktree. You step in exactly twice: to **approve
the plan** and to **merge the result**. A live dashboard shows every agent, every loop and every
token (or dollar) while it happens.

<table>
  <tr>
    <td width="33%" valign="top">
      <h3>You stay in charge</h3>
      Two human gates, a pause button on every run, and a note you can leave for any agent.
      Nothing reaches your main branch until you merge it.
    </td>
    <td width="33%" valign="top">
      <h3>Nobody grades their own work</h3>
      The engineer writes, the tester tries to break it, the reviewer tags every finding,
      and only the orchestrator commits.
    </td>
    <td width="33%" valign="top">
      <h3>You see everything</h3>
      A pipeline map, the engineer ⇄ tester loop, live logs, findings, CI diagnoses and
      usage per agent and model, streamed over WebSocket. It catches up on its own after a
      dropped connection.
    </td>
  </tr>
</table>

## How it works

<p align="center">
  <img src="docs/assets/pipeline.png" alt="Pipeline: plan (spec, grill, groom, gate 1), build (write code and tests, try to break it, commit), verify (acceptance, PR review), ship (push and PR, CI to green, gate 2 merge)" width="100%">
</p>

1. **Plan.** The Product Architect reads your spec against the repo and asks up to 5 questions.
   Then it writes an ordered task plan with acceptance criteria, at most one ADR, and a time
   and cost estimate. **Gate 1:** you approve it or send it back with a note.
2. **Build.** CowCrew creates a worktree `../<repo>-<slug>` on `feat/<slug>`. For each task, the
   Software Engineer writes code and tests, and the Tester verifies them adversarially. A FAIL
   goes back to the engineer with the Tester's report, up to `max_attempts` times. On PASS,
   the orchestrator commits.
3. **Verify.** The Product Architect checks the feature as a real user would. The PR Reviewer
   reads the full diff and tags each finding Blocker or Nit. Blockers become one rollup task;
   Nits never block.
4. **Ship.** If the project has a GitHub repo and `gh` is logged in, CowCrew pushes, opens the
   PR and watches CI. When CI goes red, the On-Call Engineer diagnoses the failure and writes a
   fix task. The fix goes back through acceptance and PR review before CI runs again, so
   nothing reaches you unreviewed. **Gate 2:** you read the checklist and squash-merge, through
   the PR or locally. The merge is pinned to the exact commit that was reviewed: if anything
   new lands on the branch, CowCrew refuses to merge it.

Progress is saved in SQLite. After a restart, running features come back paused and pick up
where they left off when you resume them.

## Meet the crew

<p align="center">
  <img src="docs/assets/crew.png" alt="The five agents: Product Architect (fable, read-only), Software Engineer (opus, never commits or pushes), Tester (sonnet, writes tests only), PR Reviewer (fable, read-only), On-Call Engineer (sonnet, never edits app code)" width="100%">
</p>

Each agent runs on the [Claude Agent SDK](https://docs.claude.com/en/docs/agent-sdk/overview)
with its own instructions, tools and model. You can change the model for each one in
Settings.

## Example: Shortly

[`examples/shortly`](examples/shortly) is a deliberately unfinished URL shortener (FastAPI,
in-memory storage, 5 tests) that ships with CowCrew so you can watch a real run on a small
codebase. Its [`AGENTS.md`](examples/shortly/AGENTS.md) tells the agents how to install, test
and lint it, and which conventions to follow.

**The first real run** used real agents on a Claude subscription with this spec:

> Count how many times each short link is followed. Add GET /links/{code}/stats that returns
> the target URL, the click count and when the link was created. Unknown codes return 404.

| Step | What happened |
|---|---|
| Plan | The Product Architect asked **4 questions** about gaps in the spec, then planned **3 tasks** with acceptance criteria. Gate 1: approved. |
| Build | In its own worktree on `feat/click-stats`, each task went Software Engineer → Tester, with one commit per PASS. |
| Verify | The Product Architect accepted the feature. The PR Reviewer's Nits were left for Gate 2. |
| Ship | **PR #1 `feat: click stats`** was squash-merged at Gate 2. The suite grew from **5 to 18 tests**. |

**Try it yourself.** Copy Shortly into its own git repo (and a GitHub repo if you want PRs and
CI), add it in **Settings → Projects**, and paste the spec above into **New feature spec**.
[docs/DEMO.md](docs/DEMO.md) has the full walkthrough, plus a harder second feature (API keys,
rate limits and rejecting unsafe URLs) that triggers review Blockers, a red CI run and an
On-Call fix.

```bash
cp -r examples/shortly ~/code/shortly && cd ~/code/shortly
git init -b main && git add -A && git commit -m "Shortly starter"
uv sync && uv run pytest -q     # 5 passed
```

## A tour of the dashboard

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/assets/screen-plan.png" alt="Gate 1: approve the plan">
      <p><b>Gate 1 · approve the plan.</b> Your spec, the planner's questions and your answers,
      numbered tasks with acceptance criteria, the ADR and the estimate.</p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/assets/screen-live.png" alt="Live run with the pipeline map">
      <p><b>Live run.</b> Click any agent on the pipeline map to see what it's doing. Follow
      the engineer ⇄ tester loop and the live log as they stream in.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/assets/screen-review.png" alt="Acceptance and PR review findings">
      <p><b>Review.</b> The acceptance verdict with each criterion, and every review finding
      tagged Blocker or Nit, with its file and line.</p>
    </td>
    <td width="50%" valign="top">
      <img src="docs/assets/screen-ci.png" alt="CI and On-Call diagnosis">
      <p><b>CI &amp; On-Call.</b> Which jobs failed, the failing log, and the On-Call
      diagnosis: root cause, the task responsible and the fix it handed back.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/assets/screen-merge.png" alt="Gate 2: merge">
      <p><b>Gate 2 · merge.</b> A seven-point checklist, the nits left for you, and squash
      &amp; merge, with an optional follow-up feature for the nits.</p>
    </td>
    <td width="50%" valign="top">
      <h3>Built for a single developer</h3>
      <p>CowCrew is a local tool: one command, one SQLite file, your own repos on disk. No
      account and no server to host. The UI follows a white, line-art visual identity with
      GitLab Sans and GitLab Mono.</p>
    </td>
  </tr>
</table>

## Quick start

You need Python 3.11+ with [uv](https://docs.astral.sh/uv/), Node 20+ and git.

```bash
git clone https://github.com/cowdex/cowcrew && cd cowcrew
make install     # uv sync + npm ci
make demo        # build the UI, load demo data, serve with simulated agents
```

Open **http://localhost:8787**. The demo runs a simulated crew, so you can click through the
whole flow without an API key.

### Run the real agents

1. Set `ANTHROPIC_API_KEY`, or log in to Claude Code on this machine (`claude` → `/login`).
   On macOS, a Claude Code login stored in the Keychain is detected automatically.
2. Optional: install the [GitHub CLI](https://cli.github.com/) and run `gh auth login` so CowCrew
   can push, open PRs and watch CI.
3. `make serve`, then go to **Settings → Projects** and add a repo by its absolute path (plus
   `owner/repo` if you want PRs).
4. Click **New feature spec**, describe what you want, and follow it through the gates.

Want a guided first run? Start with the [Shortly example](#example-shortly), then
**[docs/DEMO.md](docs/DEMO.md)** for the full real-agent scenario: a safety drill, a warm-up
feature, and a security-heavy feature that exercises every gate, the tester loop, review
Blockers and a red CI run fixed by On-Call.

| Command      | What it does                                         |
|--------------|------------------------------------------------------|
| `make dev`   | backend with auto-reload on :8787 and Vite on :5173  |
| `make serve` | build the UI and serve everything on :8787           |
| `make seed`  | load the demo project (`orbit-api`)                  |
| `make reset` | wipe the database                                    |
| `make test`  | backend tests and lint                               |

## What's new

- **Tokens on a subscription, dollars on the API.** On a Claude Pro or Max plan, the
  Overview, the agent panels and the weekly budget show tokens. With an API key they show
  dollars. Force either with `COWCREW_BILLING`.
- **macOS Keychain login.** A Claude Code login on a Mac is found without extra setup.
- **Safer unattended runs.**
  - Merges are pinned to the reviewed commit: locally CowCrew checks the branch head, and on
    GitHub it merges with `gh pr merge --match-head-commit`.
  - A CI fix goes back through acceptance and PR review before CI runs again.
  - Simulate mode always merges locally, even when the project has a GitHub repo, so a fake
    PR can never delete a real branch.
- **Fewer false alarms from the guard.** Agents can return their structured result, and shell
  syntax inside quoted strings or heredoc bodies (like `>` in a test string) no longer counts
  as a redirect.
- **Dashboard.** It refetches everything after a dropped WebSocket connection. The pipeline
  map's status legend now sits at the bottom of the map.
- **Follow-up for nits is opt-in** at Gate 2, so a merge doesn't start a new feature unless you
  ask for it.
- **[Shortly example](#example-shortly)** with a real end-to-end run.

## Safety guardrails

- **Only the orchestrator commits.** Agents can't commit, push, merge, rebase, switch branches
  or run `gh`.
- **Every tool call is checked** by a policy in `guard.py`, run as a PreToolUse hook that fails
  closed plus a `can_use_tool` callback. Nothing is pre-approved, and user and project Claude
  settings aren't loaded.
  - Writes stay inside the feature worktree, with symlinks resolved, and never touch `.git/`,
    `.github/` or other CI config.
  - The Tester can write only under test directories. Read-only agents get no write tools.
  - Reads stay inside the worktree and skip `.env` secrets.
  - Bash can't use `sudo`, `ssh`/`scp`, `curl … | sh`, `cd` out of the worktree, or `rm`,
    redirect or copy outside the agent's write scope.
  - Every blocked call shows up in the live log as `Blocked: …`.
- **Merges are tied to the reviewed commit.** CI and the merge gate refuse a branch that moved
  after review, and GitHub merges use `--match-head-commit`.
- **A weekly budget**, in tokens or dollars, pauses the pipeline when usage reaches it.
- **The server binds to 127.0.0.1** and rejects cross-site writes, cross-site WebSockets and
  unknown `Host` headers (DNS rebinding). It never logs secrets.

> [!IMPORTANT]
> The Bash check is a guard rail for well-behaved agents, not a sandbox. Only point CowCrew at
> repos you trust, or run it in a container or VM.

<details>
<summary><b>Simulate mode</b></summary>
<br>

Simulate mode is on when `COWCREW_SIMULATE=1` is set or no credentials are found. A simulator
replaces the agents and streams realistic events: a Tester FAIL followed by a PASS, a review
Blocker, and a red CI run followed by a green one. A whole feature takes about a minute.

If the project is a real git repo, simulate mode still does the real local git work: the
worktree, the commits and the squash merge. It never pushes, never opens a real PR, and always
merges locally, even when the project has a GitHub repo set.
</details>

<details>
<summary><b>Configuration</b></summary>
<br>

| Variable                     | Default         | Meaning                                                 |
|------------------------------|-----------------|---------------------------------------------------------|
| `ANTHROPIC_API_KEY`          | —               | API key for the agents (or log in to Claude Code)       |
| `COWCREW_HOME`               | `~/.cowcrew`    | Where `cowcrew.db` lives                                |
| `COWCREW_SIMULATE`           | auto            | `1` forces simulate mode                                |
| `COWCREW_BILLING`            | auto            | `subscription` shows tokens, `api` shows dollars        |
| `COWCREW_PORT`               | `8787`          | Port for `cowcrew serve`                                |
| `COWCREW_SIM_SPEED`          | `1`             | Multiplier for simulated delays (`0` = instant)         |
| `COWCREW_CI_POLL_SECONDS`    | `20`            | How often CI is polled                                  |
| `COWCREW_CI_TIMEOUT_SECONDS` | `2700`          | When a CI wait gives up and pauses                      |
| `COWCREW_FRONTEND_DIST`      | `frontend/dist` | Built UI to serve                                       |

Budget, `max_attempts` and the model for each agent are set on the Settings page. On a Claude
subscription, CowCrew shows usage and the weekly budget in **tokens**. With an API key, it shows
**dollars**.
</details>

<details>
<summary><b>Project layout</b></summary>
<br>

```
backend/    FastAPI app, orchestrator, Agent SDK runner, guard, git and gh helpers, tests
frontend/   React + Vite + TypeScript dashboard
docs/       API contract (CONTRACT.md), the demo guide (DEMO.md) and README assets
examples/   shortly: a small FastAPI app to try CowCrew on
```
</details>

## Credits

Third-party notices are in [NOTICE](NOTICE). The interface uses
[GitLab Sans and GitLab Mono](https://gitlab.com/gitlab-org/frontend/fonts) (SIL Open Font
License).

<br>
<p align="center">
  <img src="frontend/public/cowcrew-logo.png" alt="CowCrew logo" width="64"><br>
  <sub><b>CowCrew</b> · AI Software Factory</sub>
</p>
