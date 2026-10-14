# Live gate canary — real agent step held in an idle-only session

2026-10-14, executed by the Lead on the running desktop profile, build `0.2.0`.

## Why this run exists

The independent verification suite proved the per-session contract at the API level (a session's
`paused` field and the two waiter counters). What it could not prove — and what the acceptance
expert, the architect and the security engineer all wanted evidence for — is the **agent-side**
claim: that a *real task* belonging to an `idle-only` session is actually stopped at
`agent/pre-step`, not merely reported as paused.

The verifier could not run this itself: a teammate cannot start a sub-session
(`subagent depth 2 exceeds maxDepth 1`), and guessing a session id from
`~/.dsh/sessions/**` was rejected on purpose — those logs are multi-frame zstd whose payload is
not plain JSONL, and several sessions share one workspace slug, so a wrong guess would have
parked the Lead's own session.

## Method

1. `POST /mode {mode:'always', scope:'default'}` — protects the Lead's session (it has no override).
2. A probe sub-session was started whose script (a) reports `$env:DSH_SESSION_ID`, (b) sleeps 90 s,
   (c) runs one more command. Step (c) is the agent step the gate is expected to stop.
3. That session was set to off-peak only:
   `POST /mode {mode:'idle-only', session:'2b6794f9-1ef0-44c5-93b4-3aa3082c7c82', scope:'session'}`.
4. The clock was moved into a peak window:
   `POST /clock {offsetMs: 50467437, ttlMs: 180000}` → 2026-10-15 10:00 (+08:00).

## Raw observation

```
T+6s   now=19:58:58  phase=peak  waitingTasksTotal=0  session: paused=true  src=session
T+12s  now=19:59:04  phase=peak  waitingTasksTotal=0  session: paused=true  src=session
T+18s  now=19:59:10  phase=peak  waitingTasksTotal=0  session: paused=true  src=session
T+24s  now=19:59:16  phase=peak  waitingTasksTotal=1  session: paused=true  src=session
```

`waitingTasksTotal` goes **0 → 1** during the window, so a real agent step was parked at the gate.

**Attribution was not clean, and an earlier version of this file overstated it.** The probe reported
`SESSION_ID=2b6794f9-1ef0-44c5-93b4-3aa3082c7c82` and executed its third step at **20:00:15.159** — by
which time the clock override had already been cleared (19:59:2x), so the probe's own step was *not*
the one held. The waiter counted at 19:59:16 belongs to the verification seat's session
(`cd42c401-…`), which was still active during this window and had been set to `idle-only` by that run
(a leftover override the Lead later cleared).

What this observation therefore establishes is narrower than "the probe was held and released":

* a **real agent step was held by the gate** in the per-session build — that part is measured, not inferred;
* it was held while its own session was `idle-only` and the clock sat in a peak window, and the count
  returned to 0 once the override was cleared.

Both are worth having, but they are not the same claim as "this probe was held". The clean re-run is
recorded below.

## Clean re-run — attribution unambiguous

A second probe was started with a 150-second sleep before its next command
(`SESSION_ID=8f240a91-465a-445c-b73a-d39a8e6ecd4e`, reported by the probe itself). This time the
session table held **only that probe** (`sessions = [8f240a91-…]`), the Lead's own session followed
`default=always`, and the clock was moved into a peak window with a 5-minute TTL.

```
T+6s  …  T+120s   phase=peak   waitingTasksTotal=0
T+126s  now=20:03:33  phase=peak  waitingTasksTotal=1
        +5s   waitingTasksTotal=1
        +10s  waitingTasksTotal=1
        +15s  waitingTasksTotal=1
```

The count is 0 for two minutes and then goes to **1 and stays there**, at exactly the moment the
probe's sleep ends — a real agent step of *that* session is parked at `agent/pre-step`, and it stays
parked (the repeated samples are what separate "held" from "merely slow"). Clearing the clock
override released it: 4 s later `phase=idle`, `waitingTasksTotal=0`, and the probe's next command ran
at **20:04:03.053** — a timestamp the probe reported itself. That closes the loop: parked at 20:03:33,
released at ~20:03:50, executed at 20:04:03.

Cleanup: the probe override was cleared, `default` restored to the user's own `idle-only`, and the
state file ends **byte-identical** to the pre-run baseline
(`3DE35C7BA4A65D3EEE6C5A4CFCD43037F666454ABD95CA2CF7EB480779214BDC`).

### Relation to the verification seat's run

The verification seat independently ran the same experiment against host-dev's session
(`cd42c401-…`) and observed its waiter count at 1 across six consecutive 2-second samples (~12 s),
releasing to 0 — see `verify/EVIDENCE.md` §7.10c. The two runs agree; this file records the run the
Lead executed directly, on a session whose identity the probe itself reported.

## Release and cleanup

* `POST /clock {offsetMs: null}` → 4 s later `phase=idle`, `waitingTasksTotal=0` (released).
* The probe session's override was cleared with `POST /mode {mode:null, session:…, scope:'session'}`.
* An override left on session `cd42c401-…` by the verification run was cleared the same way.
* `default` restored to the user's own value, `idle-only`; the state file ends as
  `{"version":2,"default":"idle-only","sessions":{}}`.

## Not covered here

The probe's own third-step timestamp is delivered through the sub-agent channel rather than this
file, so the "resumed and finished" half rests on the `waitingTasksTotal 1 → 0` transition plus the
sub-agent completing normally. Recorded as such rather than presented as a full timeline.
