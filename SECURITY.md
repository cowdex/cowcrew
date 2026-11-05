# Security policy

CowCrew runs AI agents against code on your machine, so safety reports are very welcome.

## Reporting a vulnerability

Please report it privately through
[GitHub security advisories](https://github.com/cowdex/cowcrew/security/advisories/new)
rather than a public issue. Include what you found, how to reproduce it, and the impact you
expect. You'll get an answer as soon as possible, and credit in the fix if you want it.

## In scope

- A way for an agent to get past the tool guard (`backend/cowcrew/guard.py`): writing outside
  its scope, committing, pushing, or reaching the network in ways the policy forbids.
- A way to merge code that wasn't reviewed.
- Problems in the local server: cross-site requests, WebSocket hijacking, DNS rebinding,
  secrets in logs.

The Bash guard is a guard rail, not a sandbox. Running CowCrew in a container or VM is the
recommended setup for code you don't trust.
