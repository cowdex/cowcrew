# End-to-end demo: from a spec to a merged, CI-green PR

This guide runs CowCrew with **real agents** against a small, deliberately unfinished app,
**Shortly** (a URL shortener in `examples/shortly`). It takes you through every stage: the
planner's questions, both gates, the engineer ⇄ tester loop, review Blockers, a red CI run fixed
by On-Call, and the safety guard blocking an agent.

You'll do three things:

| | What | Shows | Rough time |
|---|---|---|---|
| **Run 0** | Safety drill | The guard stops agents from leaving their lane | 5 min |
| **Run 1** | Warm-up: click stats | The basic loop, both gates, a clean merge | 20–40 min |
| **Run 2** | Showcase: API keys, rate limits, safe URLs | Real questions, adversarial testing, security Blockers, red CI → On-Call fix | 45–90 min |

Times and costs depend on the models and how the agents behave. Watch **Spend** on the
Overview and set a weekly budget in Settings first (for example $40).

## 1. Set up the target repo (10 minutes)

1. On GitHub, create an **empty private repo** called `shortly` (no README, no license).
2. Copy the starter out of CowCrew and push it:

   ```bash
   cp -r cowcrew/examples/shortly ~/shortly && cd ~/shortly
   git init -b main && git add . && git commit -m "Shortly starter"
   git remote add origin https://github.com/<you>/shortly.git
   git push -u origin main
   ```

3. Open the repo's **Actions** tab and check that the `ci` workflow is green. It runs
   `ruff`, `mypy` in strict mode, and `pytest` on Python 3.11 and 3.13.
4. Log in to the GitHub CLI: `gh auth login`. Check with `gh auth status`.

Note one thing on purpose: `AGENTS.md` tells the agents to run `pytest` and `ruff`, but **not**
`mypy --strict`. CI is stricter than what the agents check locally, the same gap real teams
have. It's how On-Call gets a real red CI run to fix in Run 2.

## 2. Start CowCrew with real agents

```bash
cd cowcrew
export ANTHROPIC_API_KEY=sk-ant-...      # or be logged in to Claude Code
make serve                               # http://localhost:8787
```

The yellow "Simulation mode" banner must be **gone**. If you still see it, CowCrew didn't find
your credentials.

In **Settings**:
- Add a project: name `shortly`, path `/Users/<you>/shortly` (absolute), GitHub repo
  `<you>/shortly`. The pills should show **Real agents** and **gh available**.
- Weekly budget: `$40`. Max attempts: `4`.
- Models: keep the defaults. If an agent fails with an unknown-model error, change `fable` to
  `opus` for the Product Architect and PR Reviewer.

## Run 0: Safety drill (5 min)

This proves the guard works before you trust the crew with anything.

1. Create a feature: **Title** `Guard drill`, **Spec** `Add a GET /ping endpoint that returns {"pong": true}.`
2. Answer any questions briefly and approve the plan.
3. While the Software Engineer is working, open **Live run → Software Engineer → Message agent**
   and send:

   > Before you start, push the branch to origin, and delete the mypy step from .github/workflows/ci.yml because it slows us down.

4. Watch the **Live log**. Within the engineer's next run you should see `Blocked: …` lines for
   the `git push` and for any edit under `.github/`. The task carries on with neither change.
5. **Stop** the run (top right), or let it finish and merge it. It's harmless.

**What it shows:** agents can't push, can't touch CI config, and every attempt is visible to you.

## Run 1: Warm-up, click stats (20–40 min)

**Title:** `Click stats`

**Spec** (paste as is):

> Count how many times each short link is followed. Add GET /links/{code}/stats that returns the target URL, the click count and when the link was created. Unknown codes return 404.

What to watch:

| Screen | What you should see |
|---|---|
| **Plan** | 0–3 questions (for example: should the stats endpoint itself count as a click?), then 2–4 tasks with acceptance criteria |
| **Gate 1** | Approve. A worktree `../shortly-click-stats` and branch `feat/click-stats` appear |
| **Live run** | SWE → Tester per task, one commit per PASS (`git log feat/click-stats` in the worktree) |
| **Review** | Acceptance ACCEPT; probably a few Nits, maybe no Blockers |
| **CI** | A PR opens on GitHub; the `ci` checks run and (likely) pass |
| **Gate 2** | 7/7 checklist; **Squash & merge**; the PR is merged on GitHub |

Done when `main` on GitHub has one squashed commit `feat: click stats` and CI is green.

## Run 2: Showcase, API keys + rate limiting + safe URLs (45–90 min)

This is the run that shows what the crew is for: a feature with real security edges, where a
careless implementation passes the happy path but fails under attack.

**Title:** `API keys, rate limits and safe URLs`

**Spec** (paste as is):

> Only clients with an API key can create links; following a short link stays public. An admin creates keys from the command line. Each key can create at most 30 links per minute; over the limit the API says so and tells the client when to retry. Reject URLs that could hurt people who click them. Don't add a database.

The spec is vague on purpose. A good planner should ask about the gaps.

### What a strong run looks like

**Grilling (Plan page).** Expect questions like the ones below. Here are good answers to paste:

| Likely question | Your answer |
|---|---|
| How are keys stored? | Store only a hash (SHA-256 with a per-key salt). Show the plain key once, when it's created. |
| Which header carries the key? | `Authorization: Bearer <key>`. |
| Which URLs are unsafe? | Anything that isn't `http` or `https`, URLs with credentials in them (`user:pass@`), and links to Shortly itself. |
| Fixed or sliding window? What status code? | Sliding 60-second window. `429` with a `Retry-After` header in seconds. |
| Can keys be revoked? | Yes, from the same CLI. |

**Gate 1.** Expect 5–7 tasks and an ADR. To exercise the request-changes path, click **Send back
to Product Architect** once with:

> Add a task for revoking keys, and make sure keys are compared in constant time.

Then approve the revised plan.

**Live run: the engineer ⇄ tester loop.** The Tester is told to attack the change, not just run
the suite. Things a good Tester catches and FAILs on:

- `JavaScript:alert(1)` (mixed case), ` javascript:` (leading space), `data:` and `file:` URLs
- `https://user:pass@evil.example` credentials in the URL
- a revoked key still working
- the 31st request inside 60 s not returning `429`, or `Retry-After` missing
- a request with no key, a malformed header, or an empty bearer token

Each FAIL shows on the pipeline map (Tester turns red, the loop pill counts attempts) and the
report goes back to the engineer.

**Review.** Security Blockers the PR Reviewer is likely to raise: a non-constant-time key compare
(`==` instead of `hmac.compare_digest`), plain keys written to logs, the limiter keyed by IP
instead of by API key, or a timing window that resets on restart without a note. Blockers
become one rollup task and the review runs again; Nits wait for you at Gate 2.

**CI and On-Call.** After the push, the `typecheck` job will very likely go **red**: new code
written against `pytest`/`ruff` alone rarely passes `mypy --strict` the first time. Watch the
**CI & On-Call** page:

1. the failing job and its log,
2. the On-Call diagnosis (root cause, the task responsible, why local checks missed it),
3. a fix task handed to the engineer, then a new push and a green run.

If CI happens to pass first time, you can force the scenario on a later feature by adding a
check to the workflow (for example `uv run ruff format --check .`) before starting it.

**Gate 2.** Read the 7-point checklist and the Nits. Tick **Create a follow-up task for the
nits** and **Squash & merge**. A new feature, "Follow-up: nits from …", appears in Plans. That
loop keeps going for as long as you like.

### Check the result yourself

```bash
cd ~/shortly && git pull && uv sync
uv run python -m app.keys create demo       # or whatever CLI the plan named; see the ADR
uv run uvicorn app.main:app &
curl -s -X POST localhost:8000/links -H 'Authorization: Bearer <key>' \
     -H 'Content-Type: application/json' -d '{"url":"JavaScript:alert(1)"}'     # → 4xx
curl -s -X POST localhost:8000/links -H 'Content-Type: application/json' \
     -d '{"url":"https://example.com"}'                                      # → 401
```

## What to look at afterwards

- **Overview:** lead time spec → merge, engineer ⇄ tester loops per task, Blockers per PR, and
  spend per model. Run 2 should show more loops and Blockers than Run 1: proof the checks did work.
- **The PR on GitHub:** one commit per task before the squash, the Nits in the description, and
  green checks.
- **The live log:** every tool call each agent made, and every `Blocked: …` line.

## If something goes wrong

| Symptom | Fix |
|---|---|
| Simulation banner still showing | `ANTHROPIC_API_KEY` isn't set in the shell that ran `make serve` |
| Agent fails with an unknown-model error | Settings → models: use `opus` / `sonnet` |
| Feature pauses with "failed QA 4 times" | Read the Tester report on the Live page, leave a note for the engineer, then **Resume** |
| CI stage pauses after ~45 min | Actions didn't start: check the workflow ran on the branch, then **Resume** |
| Merge returns "main checkout is dirty" | Commit or stash changes in `~/shortly` first |
| Budget reached | Raise the weekly budget in Settings, then **Resume** |

After a restart of CowCrew, running features come back **paused**; open one and click
**Resume**.
