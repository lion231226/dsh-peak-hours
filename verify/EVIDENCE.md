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
