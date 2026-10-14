# dsh-peak-hours — independent verification evidence (verifier / WS4)

Verifier: teammate `verifier`. Written scope: `verify/**` only. Project root:
`C:\Users\81521\.dsh\dsh-peak-hours`. Runtime under test: DSH desktop 0.2.0-rc.2,
Node v24.12.0, GUI http://127.0.0.1:19387 (never restarted).

**Verdict vocabulary — only these three:** `已验证` / `未验证` / `失败`.
Raw output of every run: `verify/logs/*.txt`. Downloaded primary sources: `verify/raw/`.
Pre-install profile baseline: `verify/baseline/`.

## Verdict summary

| # | Subject | Verdict |
|---|---|---|
| 1 | Holiday dataset vs official notices (2025: 28 d, 2026: 33 d) | **已验证** |
| 1b | 2027 absence (no official notice published) | **已验证** |
| 2 | Boundary matrix, 12 date rows × 8 times, 1 s resolution | **已验证** |
| 2b | Transition instants (17 hand-computed, incl. 2 year rollovers) | **已验证** |
| 3 | Property tests (~68 k samples, oracle + converse + monotonicity) | **已验证** |
| 4 | Gate semantics, fake clock (20 checks) | **已验证** (F4 closed by Lead ruling) |
| 5 | Live runtime E2E (smoke + 45-check contract E2E on the running desktop) | **已验证** (client-occupant sub-item 未验证 by the verifier — see §5) |
| 6 | Adversarial (corrupt state, unknown year, rapid toggles, unload leaks, dep hygiene) | **已验证** (F5 closed after fix) |
| 6b | Real-cordis mount / teardown / re-mount (`verify/real-cordis.test.mjs`) | **已验证** (F6 closed after fix) |
| 6c | Client half: wrapper, slot mount, SPEC §2.5 labels (`verify/client.test.mjs`) | **已验证** (F7 informational) |

Findings: **F1 closed** (fixed, re-verified) · **F3** recorded ambiguity (Lead ruled: keep) ·
**F4 closed** (SPEC §3.4 re-ruled, tests rewritten) · **F5 closed** (fixed, re-verified) ·
**F6 closed** (root-caused on the real cordis, fixed, re-verified; the 18:30 "live" 200 was a
probe-fiber false positive — see §5) · **F7** informational wording deviation, and the Lead aligned
SPEC §2.5 to the implementation's wording (§6c). Three findings were in the verifier's **own**
tooling and are recorded for honesty: **V1** (virtual-vs-real clock bug in the E2E's final wait),
**V2** (PowerShell/curl JSON quoting bug in the smoke script) and **V3** (single-slot stub that
produced a false red after P9 added the second client occupant; see §6d) — all fixed, none an
implementation defect.

Whole-repo acceptance, current tree (`verify/logs/global-20261009-200939.txt`):

```
node --test                      # project root, discovers test/** and verify/**
ℹ tests 403   ℹ pass 403   ℹ fail 0   ℹ skipped 0
```

Verifier suite alone (`verify/logs/run-20261009-184425.txt`):

```
node --test "verify/*.test.mjs"
ℹ tests 99   ℹ pass 99   ℹ fail 0   ℹ skipped 0
```

Reproduce (Node 24 rejects a bare directory argument — `node --test verify` fails with
`Cannot find module '…\verify'`; use a glob):

```powershell
cd C:\Users\81521\.dsh\dsh-peak-hours
node --test "verify/*.test.mjs"     # 99 tests: data + boundary + property + gate + adversarial + real cordis + client
node verify/repro-f5.mjs            # F5 regression probe (exit 0 = fix holds)
node verify/repro-f6.mjs            # F6 real-cordis mount probe (exit 0 = mounts with 4 routes)
node verify/e2e-runtime.mjs         # live E2E; exits 3 with a diagnosis while the fiber is failed
```

---

## 1. Holiday dataset cross-check — 已验证

### 1.1 Sources retrieved

`pwsh -NoProfile -File verify/fetch-sources.ps1` (2026-10-09 18:14:19~20 +08:00):

| id | URL | HTTP |
|---|---|---|
| `2026-gov-zhengce` | https://www.gov.cn/zhengce/content/202511/content_7047090.htm | 200 |
| `2026-gov-gongbao` | https://www.gov.cn/gongbao/2025/issue_12406/202511/content_7048922.html | 200 |
| `2026-gov-zhengceku` | https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm | 200 |
| `2025-gov-gongbao` | https://www.gov.cn/gongbao/2024/issue_11726/202411/content_6989767.html | 200 |

`pwsh -NoProfile -File verify/fetch-mirrors.ps1` (18:15:21~22 +08:00) — independent publishers:

| id | URL | HTTP |
|---|---|---|
| `m2025-people` | https://cpc.people.com.cn/GB/n1/2024/1113/c64387-40360003.html (人民网/《人民日报》2024-11-13 第03版, 新华社电) | 200 |
| `m2026-gmw-a` | https://m.gmw.cn/2025-11/04/content_1304211422.htm (光明网转新华社/北青报) | 200 |
| `m2026-gmw-b` | https://m.gmw.cn/2025-11/04/content_1304211593.htm (光明网) | 200 |

Verbatim anchors proving these are the real notices: `国办发明电〔2025〕7号` … `2025年11月4日`;
`国办发明电〔2024〕12号` … `2024年11月12日`.

> `web_fetch` refuses these hosts (`resolves to a non-public IP address`); `curl.exe` through the
> machine proxy works (remote IP 198.18.0.x). Mirror pages are gzip-encoded even without
> `Accept-Encoding`, so `--compressed` is required.

### 1.2 Every day checked — 2025 (国办发明电〔2024〕12号): 28/28 match, 0 extra, 0 absent

| Clause (verbatim) | Days verified in `HOLIDAY_YEARS[2025]` |
|---|---|
| 一、元旦：1月1日（周三）放假1天，不调休 | 2025-01-01 |
| 二、春节：1月28日…至2月4日放假调休，共8天 | 2025-01-28 … 2025-02-04 (8 d) |
| 三、清明节：4月4日（周五）至6日（周日） | 2025-04-04 … 04-06 |
| 四、劳动节：5月1日（周四）至5日（周一） | 2025-05-01 … 05-05 |
| 五、端午节：5月31日（周六）至6月2日（周一） | 2025-05-31 … 06-02 |
| 六、国庆节、中秋节：10月1日（周三）至8日（周三） | 2025-10-01 … 10-08 (8 d) |

Make-up workdays that must stay non-holidays — none present: `2025-01-26, 2025-02-08, 2025-04-27,
2025-09-28, 2025-10-11`.

### 1.3 Every day checked — 2026 (国办发明电〔2025〕7号): 33/33 match, 0 extra, 0 absent

| Clause | Days verified in `HOLIDAY_YEARS[2026]` |
|---|---|
| 一、元旦：1月1日（周四）至3日（周六）。1月4日（周日）上班 | 2026-01-01 … 01-03 |
| 二、春节：2月15日（周日）至23日（周一），共9天。2月14日、2月28日上班 | 2026-02-15 … 02-23 (9 d) |
| 三、清明节：4月4日（周六）至6日（周一） | 2026-04-04 … 04-06 |
| 四、劳动节：5月1日（周五）至5日（周二）。5月9日（周六）上班 | 2026-05-01 … 05-05 |
| 五、端午节：6月19日（周五）至21日（周日） | 2026-06-19 … 06-21 |
| 六、中秋节：9月25日（周五）至27日（周日） | 2026-09-25 … 09-27 |
| 七、国庆节：10月1日（周四）至7日（周三）。9月20日（周日）、**10月10日（周六）上班** | 2026-10-01 … 10-07 |

Make-up workdays that must stay non-holidays — none present: `2026-01-04, 2026-02-14, 2026-02-28,
2026-05-09, 2026-09-20, 2026-10-10`.

Every cited cross-check URL was re-fetched independently (`verify/check-source-urls.ps1`,
18:18:45~47 +08:00): **7/7 HTTP 200**, and every notice clause appears verbatim in each source —
`official-2025 8/8, xcheck-2025-{xinhua,people,gmw} 8/8, official-2026 9/9,
xcheck-2026-{people,gmw} 9/9`.

### 1.4 2027 — correct absence: 已验证

No 国务院办公厅 2027 notice exists yet; the freshest reporting says "2027年放假安排尚未官宣"
(https://baijiahao.baidu.com/s?id=1876367674793277537, fetched 200 →
`verify/raw/m2027-notice-absent.html`). `HOLIDAY_YEARS` correctly has no 2027 entry, and
`classify(2027-01-01 10:00)` returns `holidayCoverage:'unknown'`, `unknownHolidayYear:2027`,
`phase:'peak'` per SPEC §1. Inventing a 2027 table would have been the defect; there is none.

### 1.5 F2 — withdrawn (verifier-side over-strict test)

My first draft required ≥2 hosts inside `HOLIDAY_SOURCE` itself. SPEC §2.2 freezes it as one
`<official notice URL/title>` string per year and asks separately for the cross-check to be
recorded; core-dev records the audit trail in the extra export `HOLIDAY_SOURCE_DETAIL`. The test
now asserts that combination and passes. No action for core-dev.

---

## 2+3. Boundary matrix & property tests — 已验证

Independence: expectations come from a hand-authored literal table **and** an independent
candidate-set oracle (`verify/lib/oracle.mjs`) whose holiday lists the verifier transcribed from
`verify/raw/*.txt`. A self-check test proves the hand table and the oracle agree *before* the
implementation is consulted, so any mismatch must come from the implementation.

Verified:

* **Boundary matrix, 1 s resolution** — 08:59:59 / 09:00:00 / 11:59:59 / 12:00:00 / 13:59:59 /
  14:00:00 / 17:59:59 / 18:00:00 on 12 rows: ordinary Wed `2026-10-14`, ordinary Fri `2026-10-16`,
  Sat `2026-10-17`, Sun `2026-10-18`, holiday Tue `2026-10-06`, holiday Wed `2026-10-07`, holiday
  Fri `2026-01-02`, make-up Sat `2026-10-10`, make-up Sun `2026-01-04`, make-up Sat `2026-02-14`,
  make-up Sat `2025-10-11`, ordinary Thu `2025-10-09`. Phase + `reason` + `holiday` object +
  `isPeak` all checked; make-up days report `weekend`, never `holiday`. `classify(edge ± 1 ms)`
  flips on all four window edges.
* **`nextTransition` instants** — 17 hand-computed cases: during-peak, ±1 s of each edge, Friday
  18:00 → Monday 09:00, Sunday evening → Monday, 国庆 eve → 2026-10-08 09:00, inside-国庆 at a
  would-be peak minute, 2025-12-31 18:00 → 2026-01-05 09:00 (year rollover crossing 元旦),
  2026-12-31 18:00 → 2027-01-01 09:00 (unknown year), 2025 春节 eve → 2025-02-05 09:00.
* **Property sweep** — ~68 000 sampled instants over 2025-01-01 … 2027-01-10 (97-minute coarse
  sweep + dense 1 s sweeps around every edge on a weekday/Saturday/holiday + 8 000 seeded random
  instants): `at > t` strictly; `to === classify(at).phase`;
  `classify(at-1).phase !== classify(at).phase`; `at` equals the oracle every time.
* **Converse property** — 20 000 random instants: phase changes happen *only* at exactly
  00:00/09:00/12:00/14:00/18:00 Beijing.
* **`classify` vs oracle** — 0 mismatches over 2025-2026 on phase, reason, dateKey, minuteOfDay,
  weekday.
* **Monotonicity** — 4 000 sorted instants non-decreasing, plus `nextTransition(at)` advances.
* **`phaseSegments`** — hand-checked single day (5 segments) and holiday rollover, structural
  invariants (contiguity, exact cover, non-empty, `classify(from)`/`classify(to-1)` agreement,
  empty range → `[]`) and oracle agreement.

---

## 4. Gate semantics, fake clock — 已验证

`verify/gate.test.mjs` drives the real `Gate` class with a virtual clock, a fake single-shot
scheduler and the real schedule core; no author test is imported. Raw:
`verify/logs/run-20261009-182238.txt`, `verify/logs/run-20261009-182441.txt`.

Verified (20 checks): a peak-time `wait()` stays pending, `waiterCount === 1`, **exactly one**
timer aimed at 12:00:00 / 18:00:00; still held 1 s before the boundary; **released exactly at the
boundary**; zero pending timers after release; every idle instant (08:59:00, 12:00:00, 13:59:00,
18:00:00, 23:00:00) passes straight through and registers no waiter; `always` never holds and
never arms a timer; switching to `always` releases a waiter and disarms; clock-override expiry
releases waiters; abort propagates as an `AbortError` (the signal's own reason is rethrown
verbatim) with no timer leak; an already-aborted signal rejects immediately; three waiters share
one timer and are released together; aborting after release is a no-op; `dispose()` releases all
waiters and leaves no timer; re-arm never faster than 1000 ms (1 Hz floor) even with a degenerate
schedule; a throwing `classify`/`nextTransition` fails open; `isUsableSignal` accepts a real
`AbortSignal` and rejects unusable candidates.

### F4 — closed by Lead ruling (2026-10-09)

SPEC §3 item 4 originally read "a task entering the gate at 08:59:59 stays held past 09:00:00",
which contradicted the frozen default `peakLeadMs = 0` in `lib/host/gate.js` (production
`mount()` does not pass it). The verifier reported it with a minimal reproduction; the Lead
re-ruled §3.4 to: an idle-phase check is released immediately and registers no waiter; a
peak-phase check is held until the exact next idle boundary; and **a task released at 08:59:59 is
held at its NEXT gate check once that check falls at or after 09:00:00.000** — the real
"running task auto-pauses at peak" path. The tests were rewritten to the new wording and pass:
`SPEC §3.4 running-task path: released at 08:59:59, HELD at the next gate check after 09:00:00`
(two consecutive waits), `SPEC §3.4: a peak-phase check is held from 09:00:00.000 … 17:59:59.999`,
and the optional `peakLeadMs=2000` guard is still covered as an available-but-not-default feature.
**Closed — 已验证.**

---

## 5. Live runtime E2E — 已验证

### Independent re-run on the running desktop (verifier, 2026-10-09 19:12–19:13 +08:00)

Canonical install confirmed live first: `GET /api/peak-hours/health` →
`{"ok":true,"plugin":"dsh-peak-hours","version":"0.1.0"}` [200]. Runs (both in a single tool
invocation so no step of the verifier's own turn sat inside the gate):

```
pwsh -NoProfile -File verify/smoke-runtime.ps1      → exit 0
node verify/e2e-runtime.mjs                          → 45/45 checks passed, exit 0
```

Raw logs: `verify/logs/smoke-live-20261009-191235.txt`, `verify/logs/e2e-live-20261009-191235.txt`
(and an earlier identical-result run at 19:08:01 against the temporary `-live` install:
`verify/logs/e2e-live-20261009-190801.txt`).

Verified by the verifier, with raw values:

* **health** `{ok:true,plugin:"dsh-peak-hours",version:"0.1.0"}` [200].
* **SPEC §2.3 contract, field by field** — all 18 fields present; `peakWindows`
  `["09:00-12:00","14:00-18:00"]`; `timeZone` `Asia/Shanghai (UTC+8)`;
  `nowText === bjParts(now)`; `nextTransitionText === bjParts(nextTransitionAt)`;
  `msUntilTransition === nextTransitionAt - now`; `paused === (mode==='idle-only' && phase==='peak')`.
* **Independent-oracle cross-check of the live values** — `phase/reason` at the reported `now`,
  `nextTransitionAt` (`1791766800000`) and `nextPhase` all matched the verifier's oracle exactly;
  the overridden instant `2026-10-12 09:10:10` was independently classified `peak`.
* **Errors** — invalid mode → 400 `{ok:false,error:"invalid mode: \"nonsense\" …"}`; invalid
  `offsetMs` → 400; negative `ttlMs` → 400; `GET /mode` → 405 with `allow: POST`.
* **Clock override** — `clockOverride` echoes `{offsetMs, expiresAt, ttlMs}`; default `ttlMs`
  600 000 ms when omitted and `expiresAt ≈ realNow + ttlMs` (TTL is real-time, not overridden);
  inside the simulated peak the pill state is `phase:"peak"`, `reason:"peak"`, and `paused` stays
  `false` in `always` mode while flipping to `true` in `idle-only`.
* **TTL self-expiry (deadlock guard)** — `ttlMs:3000` override: still `peak`/`paused:true` while
  alive, then `clockOverride === null` by itself, `now` back to real time, and the gate
  re-evaluated so `paused` returned to `false`; the mode was untouched.
* **Boundary-exact auto-resume (the item the first run missed)** — with the override at
  `2026-10-12 11:59:40` (20 s before the idle boundary) the state still read
  `phase:"peak", paused:true, msUntilTransition:19997`; after the wait, with **no request from the
  test**, the state read `nowText:"2026-10-12 12:00:03", phase:"idle", reason:"off-hours",
  paused:false` and `nextTransitionText:"2026-10-12 14:00:00"`. So release happens by the plugin's
  own timer at the boundary, not because the test asked.
* **Clean-up discipline** — both scripts end with `mode:"always"`, `clockOverride:null`,
  `waitingTasks:0` and real `now`; verified on the final state read.

**Finding V1 — the verifier's own script bug that cost the first run** (not an implementation
defect): the final wait computed `boundary - Date.now()`, mixing the *virtual* boundary (the
override shifts "now") with the *real* clock — so it slept ~65 h instead of 23 s and tripped the
script's own 90 s watchdog, which dutifully cleared the override and mode. Fixed to wait on
`boundary - sBefore.now` (virtual ↔ virtual) with a comment; the re-run then produced the boundary
check above. The watchdog behaved exactly as designed and is kept.

**Finding V2 — the verifier's `smoke-runtime.ps1` quoting bug** (also mine): an interpolated
`-d "{\"offsetMs\":$offset,…}"` body is mangled by PowerShell and curl exits 3, so the override
was never armed and the smoke run reported `失败` while the plugin was fine. Fixed by building the
body with `ConvertTo-Json -Compress` and posting with `--data-raw`; the re-run passed.

### Corroborating third-party evidence (Lead, same window)

* **Entering peak holds a running task**: `POST /clock` → `2026-10-12 09:10:00`, `phase:peak`,
  `paused:true`, `waitingTasks:0 → 2`, still `2` after 6 s (a sustained hold, not a one-off delay),
  then `waitingTasks:0` and `paused:false` immediately after `POST /clock {offsetMs:null}`.
* **Boundary release with a live task**: the Lead's strict-boundary run set "now" to 11:59:58,
  11:59:60/12:00:00, 12:00:02 and 12:00:05 — `paused:true, waitingTasks:2` before the boundary,
  `paused:false, waitingTasks:0` exactly at it.
* **A canary agent was actually held**: high-frequency canary `canary3` (one step per second,
  12 tool calls) ran `step1 19:12:03 … step2 19:12:06 … step3 19:12:13 …`; the `step2 → step3`
  gap of ~7 s falls inside the hold window (override armed ≈19:12:06, boundary at ≈19:12:11) and
  lines up with `waitingTasks=2`.
  **Recorded honestly, with a correction:** the canary's own claim that its `step11 → step12`
  22-second gap was also `gate/harness pauses` is **not supported** — by 19:12:17 the override was
  already cleared and the mode restored to `always`, so the gate was no longer involved; that gap is
  subagent scheduling / model latency. Only the `step2 → step3` interval is attributable to the
  gate.

### Client mount point — 未验证 by the verifier (independently)

`cordis_inspect_query(platform=client, provider=Slots, root=conversation.input.left)` timed out
three times for the verifier (`Client inspect query Slots.listSubTree timed out after 10000ms; Open
or reconnect the Harness page` — at 18:33, 19:08 and 19:13), so the **live** occupant is **not**
independently reproduced here. The Lead reports a successful query returning
`{registrant:"mf", id:"peak-hours", order:20, active:true}`. The verifier's own independent
evidence for the client half is the in-sandbox run of the real bundle
(`verify/client.test.mjs`, §6c): wrapper contract, `inject = ['slots','locale']`,
slot `conversation.input.left` with `id:'peak-hours'` and `order:20`, the three SPEC §2.5 labels,
`apply()` never throwing, and a render smoke test. Sub-item status: **未验证 (verifier-side
timeout), covered by the Lead's raw query plus the sandbox mount-contract test.**

### F6 — closed after fix: `apply()` must resolve to `undefined` (found on the real cordis)

**Symptom in the live app:** the loader entry read
`{"entryId":"include:peak-hours","moduleName":"dsh-peak-hours","enabled":true,"fiberPhase":"failed"}`
— the module was imported but `apply()` died, so nothing was registered and every
`curl http://127.0.0.1:19387/api/peak-hours/*` fell through to the loopback 401 fallback.

**Root cause.** Cordis feeds whatever a plugin's `apply()` **resolves to** into the fiber's effect
collector, which accepts only a function (a disposer) or nullish:

```js
// _recon/src/cordis/lib/index.js:1138-1145
const safeCollect = (dispose) => {
  if (typeof dispose === "function") runner.collect(dispose);
  else if (!isNullable(dispose)) throw new TypeError("Invalid effect");
};
const effect = runner.execute.call(this);
...
else if ("then" in effect) return effect.then(safeCollect);   // an async apply takes this branch
```

`apply()` was `async` and `return await mount(...)`, and `mount()` returned the surface **object**
(`{ gate, clock, store, handlers, core, version }`) — neither a function nor nullish ⇒
`TypeError: Invalid effect` ⇒ fiber failed ⇒ 0 routes ⇒ 401 everywhere.

**Reproduction** — `verify/repro-f6.mjs` boots a byte-identical copy of the shipped cordis bundle
(only its single `@deepseek-ai/cosmokit` import gets a re-export shim) with stub `timer` /
`webServer` services matching their shipped contracts. Raw output
`verify/logs/f6-proof-20261009-183649.txt`:

```
$ node verify/repro-f6.mjs        # before the fix
FIBER FAILED — real startup error follows:
TypeError: Invalid effect
    at safeCollect (cordis.mjs:1140:42)
    at async Fiber._reload (cordis.mjs:1356:5)
registered routes (0): []                      ← exactly the live 401 signature
F6 REPRODUCED ... exit=1
```

**Fix (host-dev):** `apply()` now awaits `mount(...)` and returns `undefined`; `mount()` itself is
exported for tests, and a half-mount unwinds its registrations. **Re-verified by the verifier:**

```
registered routes (4): ["/api/peak-hours/state","/api/peak-hours/mode","/api/peak-hours/clock","/api/peak-hours/health"]
  GET  /api/peak-hours/health -> 200 {"ok":true,"plugin":"dsh-peak-hours","version":"0.1.0"}
  GET  /api/peak-hours/state  -> 200 mode=always phase=idle nowText=2026-10-09 18:38:16
  POST /api/peak-hours/mode   -> 200 mode=idle-only
F6 NOT REPRODUCED ... exit=0
```

Permanent gate — `verify/real-cordis.test.mjs`: real fiber `state=2`, the four exact route paths,
`/health` + `/state` + `POST /mode` answering 200, `fiber.getEffects()` showing
`peak-hours: agent/pre-step gate` / `tools/pre-execute gate` / `routes`, **unload clearing every
route and timer**, and **unload → re-mount succeeding in the same process** (the exact path a
profile re-activation takes). Plus the contract pin
`[F6 regression] apply() resolves to undefined yet still registers everything` in
`verify/adversarial.test.mjs`. host-dev reproduced the same conclusion independently with a
separate harness (`_recon/harness/mount-real-cordis.mjs`), which also answered an open question:
an **unsatisfied `inject` leaves the fiber `pending` (state 0), not failed**, and it activates
automatically once the service appears.

**Honest note on the verifier's own earlier evidence:** the hand-written `ctx` mock's
`effect(fn)` called `fn()` and discarded the return value, so it reported "apply mounts" while the
real runtime failed. Mount/teardown claims are now backed by the real-cordis harness.

*Retracted hypothesis:* the real webserver does throw on a duplicate `(kind, path)`
(`_recon/src/dsh-host-webserver/lib/index.js:179`) — it was the verifier's first suspect and is
**not** the cause here (the failure happened before any registration: 0 routes). It stays mirrored
in the harness stub and covered by
`real cordis: the duplicate-route guard is real, so a second mount needs a dispose first`.

### F6 narrative correction — the 18:30 "installed and live" 200 was a FALSE POSITIVE (Lead)

The Lead's 18:30 evidence (`install.ps1` reported "installed and live", `/health` answered 200) did
**not** come from our entry. It came from the diagnostic probe `dsh-probe-c`'s **own fiber**: the
probe did `import('dsh-peak-hours')` and called `mod.apply(ctx_c)`, registering the four
`/api/peak-hours/*` routes on the probe's fiber. Our entry had therefore **never mounted
successfully** at that point; when the probe was deleted at 18:31 the routes disappeared (401),
which was misread as "the entry died again".

The Lead's instrumented test then established the three conditions needed to make the entry come up
(verified breadcrumb sequence `MODULE EVALUATED → APPLY ENTERED → CORE LOADED → STORE READ →
own(gate/timers/pre-step/tools-pre-execute/routes) all -> function → MOUNT COMPLETE →
APPLY RESOLVES UNDEFINED`):

1. **the F6 fix** — `apply()` must resolve to `undefined`;
2. **a fresh module URL** — a new package directory, to bypass Node's process-level ESM cache of
   the already-loaded (pre-fix) module;
3. **a fresh row id** — an entry whose fiber already failed is never retried, so editing files in
   place under the same id does nothing.

`install.ps1` now uses a new row id per activation and validates the patch with js-yaml before
writing (the 18:38 invalid YAML had killed the whole profile's file-reconcile pipeline, which cost
most of the debugging time).

### How the environment reached a verified state (history, for future re-runs)

After the invalid-YAML incident the running Loader stopped reconciling the patch file entirely (the
Lead's `dsh-probe-d` control experiment: a brand-new probe package + new row id still returned 401
after 12 s and never appeared in the loader list). The Loader tree also still contained stale probe
rows. Resolving it required the desktop app to restart — the user's call, since a restart ends the
running session. The Lead later restarted, ran `install.ps1`, and the plugin loaded at startup on
the canonical directory `dsh-peak-hours` with the canonical row `peak-hours`; the temporary
`dsh-peak-hours-live` directory/row used to work around the ESM cache were removed.

### Post-restart acceptance — fastest path

Minimal smoke (30 s, self-clearing; while unmounted it exits 3 with a diagnosis):

```powershell
cd C:\Users\81521\.dsh\dsh-peak-hours
curl.exe -sS http://127.0.0.1:19387/api/peak-hours/health          # expect {"ok":true,...}
pwsh -NoProfile -File verify/smoke-runtime.ps1                     # health → peak → paused → clear
```

`verify/smoke-runtime.ps1` performs exactly the requested sequence and prints every raw response:
(1) `GET /health`; (2) `POST /clock {offsetMs, ttlMs:120000}` computed from the verifier's
independent oracle so "now" lands 10 minutes inside the next real peak window;
(3) `POST /mode {mode:"idle-only"}`; (4) `GET /state`, assert `phase=peak` + `paused=true`, and
print `waitingTasks`; (5) `POST /clock {offsetMs:null}` + `POST /mode {mode:"always"}` and assert
the override cleared and the mode restored. A `finally` block clears the override and the mode even
on Ctrl-C, so the machine can never be left simulating a peak.

Raw equivalents for manual verification (offset 224700000 ms was the oracle value at
2026-10-09 18:45 +08:00, landing on 2026-10-12 09:10:01 Beijing = peak; the smoke script
recomputes it every run):

```powershell
curl.exe -sS http://127.0.0.1:19387/api/peak-hours/health
curl.exe -sS -X POST -H 'content-type: application/json' -d '{"offsetMs":224700000,"ttlMs":120000}' http://127.0.0.1:19387/api/peak-hours/clock
curl.exe -sS -X POST -H 'content-type: application/json' -d '{"mode":"idle-only"}' http://127.0.0.1:19387/api/peak-hours/mode
curl.exe -sS http://127.0.0.1:19387/api/peak-hours/state
curl.exe -sS -X POST -H 'content-type: application/json' -d '{"offsetMs":null}' http://127.0.0.1:19387/api/peak-hours/clock
curl.exe -sS -X POST -H 'content-type: application/json' -d '{"mode":"always"}' http://127.0.0.1:19387/api/peak-hours/mode
```

Full contract E2E afterwards (adds the SPEC §2.3 field-by-field checks, the oracle cross-check,
4xx/405 cases, `{offsetMs,expiresAt,ttlMs}` + default-600 000 ms assertions, a `ttlMs:3000`
override that expires by itself, and boundary-exact auto-resume):

```powershell
node verify/e2e-runtime.mjs
```

Then the client mount query (needs the Harness page open/connected):
`cordis_inspect_query(platform=client, provider=Slots, root=conversation.input.left)` — expect an
occupant `id:'peak-hours'`; that mount contract is also pre-verified in-sandbox by
`verify/client.test.mjs`.

`verify/e2e-runtime.mjs` detects this precondition and exits 3 with the diagnosis rather than
reporting a false failure (`verify/logs/e2e-blocked-20261009-183205.txt`). **The verifier did not
record any E2E check as failed** — the stage is `未验证`. Also still pending: the required client
query `cordis_inspect_query(platform=client, provider=Slots, root=conversation.input.left)`, which
returned `Client inspect query Slots.listSubTree timed out after 10000ms; Open or reconnect the
Harness page` and must be retried once the page is connected.

The E2E script itself is ready and asserts: `/health`; the full SPEC §2.3 field set; `nowText` /
`nextTransitionText` against the independent oracle; `paused === (mode==='idle-only' &&
phase==='peak')`; `msUntilTransition`; invalid mode / `offsetMs` / negative `ttlMs` → 4xx;
`GET /mode` → 405; the `clockOverride {offsetMs, expiresAt, ttlMs}` echo with the documented
600 000 ms default; a `ttlMs: 3000` override that **expires by itself** (SPEC §2.3's deadlock
guard); a peak override that flips `paused` to `true`; and automatic resume exactly at the idle
boundary with no further request. It always restores `mode:always` + `offsetMs:null` and arms its
own watchdog clear on top of the plugin's TTL.

---

## 6c. Client half — 已验证 (sandbox), F7 informational

`verify/client.test.mjs` runs the **real browser bundle** (`lib/client/index.js`) inside
`node:vm`: the wrapper script calls `window.__ModuleLoader__.load({ id, factory })`, so the test
captures that call, invokes the factory with stub `react` / `react/jsx-runtime`, and inspects the
resulting module. This complements the live `Slots.listSubTree` query, which needs the Harness page
connected.

Verified:

* **Wrapper contract** — `load()` called exactly once with `id: 'dsh-peak-hours'` and a `factory`
  function; the source requires only `react` and `react/jsx-runtime` and sets
  `Symbol.toStringTag` on `exports`.
* **Exports** — `inject` is exactly `['slots', 'locale']`; `apply` is a function.
* **`apply()` never throws** (SPEC §2.5) — checked against `undefined`, `null`, `{}`, partial
  contexts, a `register` that throws, a throwing `effect`, and a missing `slots` service.
* **Mount contract** — registers into slot `conversation.input.left` (the composer tool row, i.e.
  immediately right of the mode buttons) with occupant `id: 'peak-hours'`, `order: 20`, a
  renderable component, plus a dictionary registration; both registrations are effect-owned.
* **SPEC §2.5 labels** (exact strings): mode `always` → `全天运行` with the neutral dot;
  `idle-only` outside peak → `空闲时段 · 运行中` with the success dot; `idle-only` + `paused` →
  `空闲时段 · 已暂停` with the warn dot.
* **Render smoke test** — the registered component renders under the stub React without throwing
  and produces at least one text label.

### F7 — informational (documented, needs no fix)

SPEC §2.5 quotes the failed-fetch label as `"不可用"`; the implementation renders `时段不可用`.
The dot is `muted`, `available:false`, and no exception escapes, so the *intent* ("a muted
unavailable state, never an exception") holds and the quoted word is preserved as a substring.
The verifier asserts `/不可用/` rather than blessing either exact string, and reports it so the
Lead can either accept the wording or align SPEC §2.5. **Not a defect.**
**Resolution (Lead, 2026-10-09):** SPEC §2.5 was aligned to the implementation's wording
(`时段不可用`); no code change. The verifier's `/不可用/` assertion therefore still holds.

---

## 6d. P9 follow-up — verifier stub false red (fixed; not an implementation defect)

After P9 added a **second** client slot occupant (the peak-queue banner in
`conversation.input.dock`, id `peak-hours`, order 30) the whole-repo run went to `402/403` with one
failure at `verify/client.test.mjs`. Root cause, confirmed by the verifier reading
`lib/client/index.js:1521-1556`: the stub recorded registrations into a **single**
`record.slot/record.entry`, so the banner silently overwrote the composer pill and the `left`
assertion then saw `dock`. The verifier independently confirmed the new shape in the source rather
than taking the report on faith.

This was a **stub false red** (a wrong test harness), not a product defect. Fixed in
`verify/client.test.mjs` by collecting every registration plus the injected slot list, and by
upgrading the assertions to lock the new shape (the Lead's suggested strengthening):

* `inject` was called for exactly `conversation.input.dock` and `conversation.input.left`;
* `conversation.input.left` → id `peak-hours`, order **20**, component `PeakHoursControl`;
* `conversation.input.dock` → id `peak-hours`, order **30**, component `PeakHoursBanner`, a
  *different* function from the pill's;
* the two frozen constant triples exported in `__internals` agree with what `apply()` registered;
* both components render under the stub React, and the banner returns `null` while no work is
  being held (it must never throw — a throwing slot component would break the composer).

Raw result of the acceptance command the Lead named (`node --test`, project root,
2026-10-09 20:09 +08:00, `verify/logs/global-20261009-200939.txt`):

```
ℹ tests 403
ℹ pass 403
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 2085.548
```

**Verified: 403/403 green.** (Tracked as V3 alongside V1/V2 — the verifier's three self-inflicted
tooling defects, kept in the record so the suite's history is not flattered.)

---

## 6. Adversarial checks — 已验证

`verify/adversarial.test.mjs` drives the real `apply()` with a fake cordis context; every
filesystem case redirects `DSH_HOME` to a throwaway directory, so the verifier never touches the
live `peak-hours-state.json`.

Verified:

* **Corrupt / missing / unreadable / wrong-shape state file** → always falls back to `always`,
  never throws, exactly one log line; a corrupt file is repaired by the next `write()`; a corrupt
  file does not prevent `apply()` from mounting.
* **Unknown holiday year 2029** through the full state envelope: `phase:'peak'` (SPEC §1 treats the
  unknown year as a non-holiday weekday), `holidayCoverage:'unknown'`, `unknownHolidayYear:2029`,
  `holidayToday:null`, `paused:false` in `always`.
* **Registration surface** exactly matches SPEC §2.4: 2 listeners (`agent/pre-step`,
  `tools/pre-execute`, both `prepend:true`) + 4 routes (`state`/`mode`/`clock`/`health`) + 4 owning
  effects.
* **Unload leaves nothing behind** (SPEC §3.6): after disposal every waiter is released, every
  scheduled timer is cancelled, and every route and listener is disposed — while a step that
  arrived during peak was verifiably *not* delegated downstream beforehand.
* **`POST /mode` and `POST /clock` validation** → 400s for missing/invalid bodies; with
  `allowClockOverride:false` the clock route returns 403 and installs nothing.
* **Clock TTL** expires by itself at the documented default (600 000 ms), clears the override, and
  calls the gate hook.
* **Dependency hygiene** — `package.json` has no runtime `dependencies`; the profile's
  `node_modules\@deepseek-ai\` still matches the pre-install baseline **exactly** (2 packages:
  `cosmokit@1.8.5`, `schemastery@3.18.4`; 117 top-level dirs; baseline in `verify/baseline/`).
  Nothing was pulled in by this plugin.

### F5 — closed after fix (was: concurrent writes corrupt the state file)

**Was:** two overlapping `write()` calls (exactly SPEC §3.6's "two rapid mode toggles", reachable
from two quick clicks on the mode switch) wrote to the same `${file}.tmp` and renamed, so one
rename published a half-written file or lost the last write. Reproduced with only 2 concurrent
writes (`verify/logs/f5-repro-20261009-182304.txt`): `JSON.parse` failure on
`"{ … }\n\n}\n"`, and a lost last write.

**Fix (host-dev):** `write()` is serialised through an internal promise queue with `cached = mode`
still assigned synchronously before queuing, plus a unique temp name
`${file}.${process.pid}.${n}.tmp` and temp cleanup on the failure path.

**Re-verified by the verifier** (`verify/logs/f5-after-fix-20261009-182441.txt`):

```
$ node verify/repro-f5.mjs
F5 NOT REPRODUCED in 84 attempts (2..200 concurrent writes) — the fix holds.
PASS: exit 0 means no corruption and last-write-wins observed; exit 1 means the defect is present.
exit=0
```

The regression test `state store: 200 rapid writes never corrupt the file and the last write wins`
(including "no `.tmp` litter survives the renames") is green. **Closed — 已验证.**

---

## F1 — closed after fix (was: `createCalendar({years})` inconsistency)

**Was:** `years` narrowed `coverage()` but not `holidayOn()`, so a date declared *unknown* still
yielded holiday data and `classify()` produced `{ holidayCoverage:'unknown', reason:'holiday',
holiday:{…} }` — a self-contradictory snapshot.

**Fix (core-dev, per Lead ruling (a)):** `holidayOn` applies a year gate; `extra` stays ungated by
`years` and counts as known coverage, preserving
`coverage()==='unknown' ⟹ holidayOn()===undefined`.

**Re-verified by the verifier** with the original command
(`verify/logs/f1-repro-after-fix-20261009-182119.txt`):

```
coverage(2025-05-01) = unknown
holidayOn(2025-05-01) = undefined
holidayOn(2026-05-01) = {"dateKey":"2026-05-01","name":"劳动节"}
classify(2025-05-01 10:00 BJ, cal) = {"reason":"peak","phase":"peak","coverage":"unknown","year":2025,"holiday":null}
extra overlay, default years: holidayOn = {"dateKey":"2025-05-01","name":"验证覆盖"} coverage = known
```

**Closed — 已验证.**

---

## F3 — recorded ambiguity, not a failure

`phaseSegments` splits only at phase changes, so a segment's `reason` is the reason at its start:
the 9-day 国庆 idle stretch (2026-09-30 18:00 → 2026-10-08 09:00) is one segment labelled
`off-hours` although every instant inside classifies as `holiday`/`weekend`. SPEC §2.1 only says
"contiguous, covering `[fromMs, toMs)`", so phase-granularity splitting is defensible. Lead ruled
"keep as-is, note it in SPEC"; the verifier test was aligned to the implementation and additionally
asserts that every instant inside the span still classifies as `holiday`.

---

# §7. Per-session run windows (SPEC §9, 2026-10-14) — task-7

Scope: `verify/session-store.test.mjs` (state-file contract), `verify/session-isolation.test.mjs`
(isolation / sessionId source / tool gate / routes / counters / R5), `verify/e2e-sessions.mjs`
(live). All verifier-owned; no `lib/**` or `test/**` file was touched.

## 7.1 State file v2 (SPEC §9.1) — **已验证** (11/11)

`node --test verify/session-store.test.mjs` → `tests 11 / pass 11 / fail 0`
(`verify/logs/sess-store-20261014-193531.txt`):

| Check | Verdict |
|---|---|
| v1 `{mode}` → v2 migration written back to disk; `default` preserved; `sessions` empty; exactly one log line; idempotent on re-read | 已验证 |
| corrupt file → `{default:'always', sessions:{}}`, exactly one warning, never throws, next write valid v2 | 已验证 |
| missing file → defaults, no throw | 已验证 |
| malformed v2 (`default:'sometimes'`, invalid session mode/id) sanitized rather than trusted or thrown | 已验证 |
| `modeFor`: `sessions[id]` → `default`; blank/absent id → `default`; one session's write never changes another's resolution | 已验证 |
| 80 concurrent `setMode` calls → file parses, no `.tmp` litter, memory agrees with disk | 已验证 |
| session cap bounded at `MAX_SESSIONS`; eviction logged; evicted session resolves to `default` (SPEC §9.6) | 已验证 |
| **R5** `__proto__`: never "reported as a session" while the file lacks it, and no prototype pollution | 已验证 |
| **B4** `a+b` vs `a b` do not collide; UUID ids unaffected | 已验证 |
| **R4** real UUID shape: insertion/LRU-by-set order preserved (see caveat below) | 已验证 |

### 7.1a Cap policy (SPEC §9.6) — measured, then ruled

SPEC §9.1 specified no cap, so the verifier **measured** the behaviour instead of assuming it. The
first hypothesis (FIFO) was **disproved by the data**: after `A`, `B`, then re-setting `A`, `A`
moves to the last position → **LRU-by-set**. Consequence: with 500 entries, an untouched session is
evicted after enough newer sessions and reverts to `default`.

```
[observation] MAX_SESSIONS=500; after being updated A sits at index 1 of 2 (a non-zero index means
an update DOES refresh its recency, i.e. LRU-by-set); after 520 newer sessions A is EVICTED →
reverts to default "always"
```

**Lead ruling (SPEC §9.6):** keep the 500 cap, document LRU-by-set, **log every eviction**, no UI
warning (an evicted session truthfully reports `modeSource:'default'`). The implementation logs
(`[peak-hours] evicted N oldest session override(s); cap is 500`) and the test asserts that log
appears together with the eviction.

**Re-measured after host-dev moved the in-memory container to a `Map`** (which by itself would
preserve insertion order and therefore *break* LRU-by-set): an explicit update still moves the key
to the back (`A,B,A` → file order `["B","A"]`), so §9.6 holds. The Map is an internal
representation change — SPEC §9.1 freezes the *file* object, not the snapshot type — so the
verifier's assertions were made container-agnostic (a `sessionCount()` helper plus `modeFor()`),
which also removes a false-red source.

### 7.1b Session-id shape sampling (Lead, this machine) — recorded

All 129 directories under `C:\Users\81521\.dsh\sessions` are **UUID-shaped** (36 chars,
`^[0-9a-f]{8}-[0-9a-f]{4}-…`); **0** numeric-only ids, **0** containing characters outside
`[a-z0-9-]`, **0** containing `+` or a space; longest 36 chars. Qualitative conclusions the Lead
drew from it, recorded here as sampled facts + reasoning:

* **R4 does not fire in the real shape** — `Object.keys` hoists only integer-like keys, and UUIDs are
  not integer-like, so insertion order (hence LRU-by-set) is what actually governs eviction. The
  defensive fix is kept but is **not a blocker**.
* **B4 does not fire either** — no real id contains `+`/space, so `?session=a+b` vs `a%2Bb` cannot
  collide today. The case is still asserted as a defensive guard (and now passes).
* **R6's 200-char cap** is generous against the real 36-char shape.
* **R5 (`__proto__`) is the one genuinely reachable case** of R4/R5/R6/B4.

## 7.2 R2 — a real methodological gap in the verifier's own test, fixed

An acceptance review found that `drivePreStep` called the listener with the SAME fake agent as both
`this` and `payload.agent`. On the live runtime `this` is an **opaque scoped carrier**
(`this.session === undefined`, no `this.id`), so that helper let a wrong
`this.session?.id ?? this.id` implementation pass — a **false green** that would have hidden the
round's blocking defect.

Fixed in `verify/session-isolation.test.mjs`:

* `opaqueCarrier()` — no `session`, no `id`, only a symbol tag — is now the default `this`; the
  session is supplied exclusively through `payload.agent`, which is the real call shape.
* A dedicated test asserts the decision follows `payload.agent` **even when `this` lies** (a
  `lyingCarrier` carrying a conflicting session id must be ignored).
* A **mutation-teeth** test writes the wrong contract out as a twin listener
  (`this.session?.id ?? this.id`) and asserts that the twin DELEGATES the `idle-only` session while
  the real listener HOLDS it — i.e. the scenario genuinely discriminates the two contracts. A test
  that cannot go red here is worthless, so this is asserted rather than assumed.
* `drivePreExecute` already used `call({}, …)` and stays as-is (the Lead confirmed it is honest).

The verifier initially recorded a **documentation mismatch** here (SPEC §9.2's table credited
`agent/pre-step` with `this.session?.id ?? this.id`, contradicting the corrected contract). That
observation was against a pre-ruling snapshot and is **withdrawn**: SPEC §9.2 L256 on disk now reads
`payload.agent?.session?.id ?? payload.agent?.id`, names the dispatch source
(`dsh-agent/lib/types/dispatch.js:37-42`), states that `this` is an opaque dsh-scope carrier whose
`session`/`id` are both `undefined`, and adds the explicit ruling — *"Official listeners on this
event read the injected agent from the payload, never from `this` … Do not reintroduce a
`this`-based read: it fails silently and takes the whole per-session feature with it (Lead ruling
2026-10-14, after the acceptance expert reproduced it)"*. The verifier's tests encode exactly that
contract, including the mutation-teeth check that a `this`-based read cannot pass.

## 7.3 Isolation / tool gate / routes / counters — **未验证** (framework ready, gated)

`verify/session-isolation.test.mjs` (now 17 checks) is designed so a shared or last-write-wins mode
variable cannot pass: A=`always` vs B=`idle-only` at a simulated peak driven with opaque carriers;
**interleaved** writes (A, B, A, B) proving the decision comes from the task's own session; an
unconfigured session following `default`; the tool gate keyed on `exec.agent.session.id` with a
**missing `exec.agent`** falling back to `currentInitiator()` and still holding an `idle-only`
session (asserted in both directions, including `default = idle-only`); the route contract
(`?session=`, three `POST /mode` semantics, 4xx on bad input); and the **breaking change pinned** —
`waitingTasks` is now the current session's count while `waitingTasksTotal` keeps the old host-wide
number, with per-session release proven not to touch other sessions.

The file **skips with an explicit reason** (visible as a non-zero `skipped` count) until the feature
is wired end-to-end; per the Lead's freeze protocol the verifier is deliberately **not** adapting
its v1-era tests until `lib/**` is frozen.

## 7.4 Live multi-session — **未验证** (script ready)

`verify/e2e-sessions.mjs` exists and its safe paths are exercised: against the current non-§9 live
build it aborts cleanly with **exit 3** and a diagnosis, removes nothing, and leaves the real state
file **byte-identical** (`8CF0D25C…`). It writes modes only for two SYNTHETIC session ids
(`verify-sess-A/B`), `--cleanup` removes exactly those, and the clock override is TTL-bounded,
watchdog-guarded, and cleared in a `finally`.

Migration baseline captured before any deploy:
`verify/baseline/state-file-v1-before-persession.txt` — the real
`C:\Users\81521\.dsh\peak-hours-state.json` was v1
`{"mode":"idle-only","updatedAt":"2026-10-14T06:36:18.431Z"}`, sha256
`8CF0D25C8146ED8A9B8B02C36B50263738997C425DC2A7ACD9D3E17585599EFB`. After the deploy, the first live
read must migrate it to v2 with `default:"idle-only"` and log exactly once — that baseline is the
check.

**Hard constraint (Lead):** `default` must stay `always` for the whole live window so a simulated
peak cannot hold the Lead's own session; only the target subagent session may be `idle-only`.

## 7.5 Verifier's own tooling defects this round (kept for the record)

* **V4** — `verify/e2e-sessions.mjs` called `process.exit()` while a fetch keep-alive socket was
  closing, tripping a libuv assertion and producing a garbage exit code (`-1073740791`) instead of
  3. Fixed with a `Bail` sentinel plus a graceful `process.exitCode` + drain; the abort path now
  exits cleanly with 3 (verified without pipeline truncation).
* **V5** — the cap test referenced `logs` without destructuring it (`ReferenceError`). Fixed.
* **V6** — four failures in the store suite were the verifier's own assumptions, not defects: three
  asserted the in-memory snapshot is a plain object (host-dev moved to a `Map`), and one had a wrong
  expected key order. All fixed; the suite is green again and now tolerates either container.

## 7.6 Mid-flight warning (recorded for honesty)

Two whole-repo/partial runs during this window reported failures while `lib/host/index.js` and
`lib/host/store.js` were being edited **during the very same runs** (e.g. `index.js` sha256
`845C70F8…` → `2198B752…` mid-run; `store.js` `C7FAEFC2…` → `AA1CD448…` mid-run). Those failures are
construction noise from concurrent authoring, **not** findings, and are not reported as defects. Any
green run must be tied to the frozen `lib/**` hash the Lead publishes.

## 7.7 After host-dev's task-5 delivery — 34/34 已验证 (not yet on the frozen hash)

host-dev reported task-5 delivered (`test/host` 138/138) and named four changes that hit the
verifier's probes. The matrix was re-run and extended; against `index.js`/`store.js`/`routes.js` as
of 19:45 +08:00 (`verify/logs/sess-matrix-20261014-194547.txt`):

```
node --test verify/session-isolation.test.mjs  → tests 20 / pass 20 / fail 0
node --test verify/session-store.test.mjs      → tests 14 / pass 14 / fail 0
```

| host-dev change | verifier check | Verdict |
|---|---|---|
| **SEC-4** write fence: POST without `application/json` → 415, `sec-fetch-site: cross-site` → 403 | `SEC-4: the write fence answers 415 … and 403 for cross-site` — both on `/mode` and `/clock`; GET stays open; well-formed writes still 200 | 已验证 |
| **R1/P1-1** unresolvable session → `default` **and no longer silent**: `waitingTasksUnresolved` + one warn | `P1-1: an unresolvable session is counted and warned once — never silent` — forged pre-step with no `payload.agent` and no initiator, `default=idle-only` at peak: `waitingTasksUnresolved` 0→1→2, returns to 0 on abort, and **exactly one** session warning for two waiters | 已验证 |
| **R4/LRU** semantics | `R4/LRU discrimination: with cap 2, writing 3,1,2 leaves {1,2} — not {2,3}` and the agreeing `1,2,3 → {2,3}` case | 已验证 |
| **P1-2** `mode:null` clears one session | `P1-2: mode:null clears one session override; without a session it is a 400` — also asserts the cleared id is **gone from the file**, not merely masked | 已验证 |
| **R6** 128-char cap, reserved ids | `R6 / reserved ids` — `__proto__`/`constructor`/`prototype` never persisted nor resolved as sessions; a 129-char id refused; the file object stays a plain JSON object | 已验证 (128-char id is accepted at the cap — logged as `[observation] R6: 128-char id accepted`) |

**On the disputed R4 case:** host-dev is right that true LRU-by-set leaves `{'1','2'}` for the write
sequence `3,1,2` at a cap of 2, and that `{'2','3'}` is the *pre-fix* `Object.keys` numeric-ascending
behaviour. The verifier's suite never encoded `{'2','3'}`; it now pins the discriminating case
explicitly, so a regression back to numeric-ascending eviction would go red.

**V7c (verifier tooling):** switching `e2e-sessions.mjs`'s cleanup to the new P1-2 route re-exposed
the V4 hazard on the `--cleanup` path (`process.exit()` right after a fetch → libuv assertion, exit
`-1073740791`). Fixed with the same graceful `process.exitCode` + drain; verified:
`--cleanup` → exit 0, precondition path → exit 3, and the real state file stays **byte-identical**
(`8CF0D25C…`). The cleanup now prefers `POST /mode {mode:null}` and keeps the state-file edit only
as a fallback for builds without the route.

**Still open (unchanged):** the 34 items above are *not yet* tied to a frozen `lib/**` hash, and the
live two-session run (`verify/e2e-sessions.mjs`) remains **未验证** — the running build is still the
pre-§9 one, so the script correctly aborts with exit 3 and changes nothing.

## 7.8 FROZEN SNAPSHOT RUN — 已验证

The Lead froze `lib/**` on 2026-10-14. The verifier re-hashed every frozen file locally and **all 11
match** (full-run log `verify/logs/frozen-20261014-194853.txt`):

| File | Frozen SHA256 (first 16) | Verifier |
|---|---|---|
| `lib/host/index.js` | `5FA19B64F5707A61` | MATCH |
| `lib/host/gate.js` | `F422F2E63E6A7D81` | MATCH |
| `lib/host/store.js` | `FD19899238F58AD5` | MATCH |
| `lib/host/routes.js` | `2156CAAFE1F3D4E9` | MATCH |
| `lib/host/state.js` | `27FCC2A47544E4F0` | MATCH |
| `lib/host/clock.js` | `13794FD03C3BAF33` | MATCH |
| `lib/host/core-bridge.js` | `CE3F7C1B4A9BABDD` | MATCH |
| `lib/client/index.js` | `7869906510F39696` | MATCH |
| `lib/core/schedule.js` | `D80784B94A19FA29` | MATCH |
| `lib/core/holidays.js` | `56E26AD7965ADBA3` | MATCH |
| `lib/core/index.js` | `5C69072914CB6DC7` | MATCH |

```
node --test "verify/*.test.mjs"   → tests 133 / pass 133 / fail 0 / skipped 0
node --test                       → tests 513 / pass 513 / fail 0 / skipped 0
node verify/repro-f5.mjs          → exit 0 (F5 fix holds)
node verify/repro-f6.mjs          → exit 0 (mounts under real cordis, 4 routes)
```

### The 6 legacy verifier failures, adapted to the frozen v2 contract

The Lead's list matched the verifier's own breakdown exactly. All six were **stale inputs in the
verifier's tests**, not implementation defects; three of them were positive evidence that new
behaviour works:

1. `state store: missing, corrupt, …` — v1 asserted `read()` returns the string `'always'`; v2 returns
   `{version,default,sessions}`. Now asserts `read().default`, plus `setMode(mode, null)` for the
   repaired-write step.
2. `state store: 200 rapid writes …` — `write()` became `setMode(mode, sessionId)`; now writes the
   default and compares `defaultMode`. (`verify/repro-f5.mjs` was updated the same way.)
3. `SPEC §2.5 labels` — the verifier fed a **v1-shaped** state, so the new client correctly degraded
   to `时段不可用`. **Positive evidence** for the deliberate read-only degradation; the test now feeds
   a v2 envelope (`modeSource`/`defaultMode`/`waitingTasks*`).
4. `both registered components render …` — same cause plus SPEC §9.4: with **no session** the
   occupants render nothing. The test now asserts that no-session case *and* renders with
   `sessionId`.
5. `real cordis: apply() …` and `unload disposes …` — the real-cordis stub sent POSTs without
   `content-type`, so the new SEC-4 fence answered **415**. **Positive evidence** for the fence; the
   stub now sends the header, exactly like the shipped client.

### 7.8a R6 observation — closed (not a defect)

The verifier's earlier `[observation] R6: 128-char id accepted` is **resolved as intended contract**:
a session id is a non-empty string whose **trimmed** length must be ≤ 128
(`lib/host/store.js:34 MAX_SESSION_ID_LENGTH = 128`, `sanitizeSessionId` at :72-90). Measured through
the API:

```
128 chars      → POST 200, persisted, modeSource 'session'
129 chars      → POST 400, not persisted, resolves 'default'
128 + 2 spaces → POST 200, stored under the trimmed 128-char id
```

The store's own `setMode` silently ignores an over-long id, which is acceptable **only because the
route rejects first** — now asserted at the HTTP layer so that silent path stays unreachable
(`R6 at the HTTP layer: 128 chars ok, 129 refused with 400, ids normalized by trim`).

## 7.9 LIVE two-session run against build 0.2.0 — 已验证

Build under test (as instructed by the Lead): `/health` → `{"ok":true,"plugin":"dsh-peak-hours",
"version":"0.2.0"}`, loader entry `include:peak-hours-v2` with `fiberPhase: active`, and the
deployed files matching the frozen hashes (`host/index.js 5FA19B64F5707A61`,
`routes.js 2156CAAFE1F3D4E9`, `client/index.js 7869906510F39696`).

`node verify/e2e-sessions.mjs` → **12/12 checks passed, exit 0**
(`verify/logs/live-sessions-20261014-195222.txt`). Raw highlights:

```
live baseline: mode=idle-only source=default default=idle-only
PASS  session A resolves its own idle-only      :: {"mode":"idle-only","source":"session"}
PASS  session B resolves its own always         :: {"mode":"always","source":"session"}
PASS  B's choice did not leak into A            :: A=idle-only B=always
PASS  no ?session= reports the default          :: {"mode":"always","source":"default","default":"always"}
PASS  inside the simulated peak the window flipped on (oracle agrees) :: 2026-10-15 09:10:22 oracle=peak
PASS  A (idle-only) reports paused=true, B (always) reports paused=false
PASS  the next transition is the upcoming idle boundary :: 2026-10-15 12:00:00
PASS  clock override cleared; A is no longer paused
cleanup: removed synthetic sessions ["verify-sess-A","verify-sess-B"] (via POST /mode {mode:null} (P1-2))
restored default → 200, now defaultMode=idle-only (expected idle-only)
PASS  the user's original default was restored after the run
```

**This is the cross-session isolation claim verified on the real host**, not just in a harness: the
same host-wide peak instant produced `paused:true` for the `idle-only` session and `paused:false`
for the `always` session, with `modeSource:'session'` for each and no leakage either way.

Safety constraints the Lead set were both honoured:

* `default` was held at `always` for the whole run (so a simulated peak could not hold the Lead's
  own session), then **restored to the user's `idle-only`** — asserted by re-reading it, not assumed;
* the verifier's synthetic sessions were removed through the P1-2 exit, and the real state file is
  **byte-identical before and after the run**: sha256
  `3DE35C7BA4A65D3EEE6C5A4CFCD43037F666454ABD95CA2CF7EB480779214BDC` both times, ending as
  `{"version":2,"default":"idle-only","sessions":{}}`.

### 7.9a Live migration (performed by the Lead — recorded as third-party evidence)

The v1 → v2 live migration was executed by the Lead, not observed by the verifier, so it is recorded
here as third-party evidence with one instructive wrinkle the Lead reported and asked to keep: the
`default` came out as **`always`** rather than the user's `idle-only`, because the bare `{mode}`
endpoint had been exercised once with the OLD code (which had no content-type fence, so the write
succeeded) immediately before the migration — the migration faithfully carried the value that was
actually in the file. The Lead restored `default` to `idle-only`; the verifier confirmed the
resulting file (`{"version":2,"default":"idle-only","sessions":{}}`) and that the pre-session
baseline `verify/baseline/state-file-v1-before-persession.txt` still documents the original v1
content. **Conclusion: verified by the Lead; not independently reproduced by the verifier.**

### 7.9b Deployment trap worth recording (Lead): a fresh copy is not a fresh module

The Lead hit and solved a trap that invalidates a naive "is it deployed?" check: copying the frozen
build into a new directory (even via a junction) does **not** make the running host execute the new
code, because **Node caches ES modules by URL** — while `readVersion()` reads `package.json` at
runtime. The result is self-contradictory evidence: `/health` reports `0.2.0` while the behaviour is
still the old build, and the genuinely-new instance fails to register its routes because the stale
fiber still owns them. Resolution: **disable and re-enable the loader entry** so the residual fiber
is destroyed. This is the same class of hazard as the verifier's V-series findings: a check that
reads a *label* (`version`, `package.json`) instead of *behaviour* can be satisfied by the wrong
artifact. It is why §7.9 above records behaviour (`paused` per session) and not just the reported
version.




