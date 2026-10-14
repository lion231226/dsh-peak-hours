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

`waitingTasksTotal` goes **0 → 1** while that session's own `paused` is true: a real agent step is
parked at the gate. The count is the agent-side evidence; the `paused` field alone would not have
distinguished "held" from "reported".

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
