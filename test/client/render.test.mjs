/**
 * Render-path tests: the real component tree is executed through the hook
 * harness in `helpers/bundle.mjs` (plain Node, no React and no DOM), so a broken
 * `jsx`/`jsxs` call or a hook-order mistake fails here instead of only in the
 * browser.
 *
 * Covered: per-session reads and scoped writes (SPEC 9.3/9.4), pill copy + dot
 * per state, the popover's required contents, local 1 Hz countdown with no extra
 * network, adaptive polling + `visibilitychange`, and every listener/timer being
 * removed on close and on unmount.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { loadBundle, materialize, createReactStub, createFakeTimers, createFakeDocument, createFakeClock, createRoutedFetch } from './helpers/bundle.mjs'
import { createTreeRenderer } from './helpers/render.mjs'

/** Let every pending promise chain settle (the fetch stub resolves immediately). */
const flush = () => new Promise((resolve) => setImmediate(resolve))

const SESSION = 'session-abc'
const OTHER_SESSION = 'session-xyz'
const STATE_URL = `GET /api/peak-hours/state?session=${SESSION}`
const OTHER_STATE_URL = `GET /api/peak-hours/state?session=${OTHER_SESSION}`
const MODE_URL = 'POST /api/peak-hours/mode'
const CLOCK_START = Date.UTC(2026, 9, 9, 10, 8, 6) // 2026-10-09 18:08:06 Beijing

/** A SPEC 2.3 + 9.3 state object anchored on a fixed host clock. */
function state(overrides = {}) {
  return {
    mode: 'always',
    phase: 'idle',
    reason: 'off-hours',
    now: CLOCK_START,
    nowText: '2026-10-09 18:08:06',
    nextTransitionAt: CLOCK_START + 3_600_500,
    nextTransitionText: '2026-10-12 09:00:00',
    nextPhase: 'peak',
    msUntilTransition: 3_600_500,
    paused: false,
    waitingTasks: 0,
    holidayToday: null,
    holidayCoverage: 'known',
    unknownHolidayYear: null,
    timeZone: 'Asia/Shanghai (UTC+8)',
    peakWindows: ['09:00-12:00', '14:00-18:00'],
    clockOverride: null,
    config: { allowClockOverride: true },
    // SPEC 9.3 per-session fields.
    sessionId: SESSION,
    modeSource: 'session',
    defaultMode: 'always',
    waitingTasksTotal: 0,
    ...overrides,
  }
}

/** Wire one control instance with deterministic clock, timers, document and fetch. */
function setup({ routes, sessionId = SESSION }) {
  const harness = createReactStub()
  const timers = createFakeTimers()
  const document = createFakeDocument()
  const clock = createFakeClock(CLOCK_START)
  const fetchImpl = createRoutedFetch(routes)
  const load = loadBundle({ harness, timers, document, fetch: fetchImpl, date: clock.Date })
  const exports = materialize(load)
  const internals = exports.__internals
  const t = (key, params) => internals.translate(internals.DICTS, 'zh', key, params)
  const props = sessionId === null ? { t } : { t, sessionId }
  const renderer = createTreeRenderer(harness, internals.PeakHoursControl, props)
  // The queue banner is a second occupant of the same session view; give it its
  // own hook context so both can be mounted from one harness, exactly as the
  // shell does.
  const banner = createTreeRenderer(harness, internals.PeakHoursBanner, props, 'banner')
  return { load, internals, renderer, banner, timers, document, clock, fetchImpl, t }
}

const envelope = (payload) => ({ status: 200, body: { ok: true, state: payload } })

test('the pill mounts with the loading label before the first response', () => {
  const { renderer, internals } = setup({ routes: { [STATE_URL]: envelope(state()) } })
  const tree = renderer.render()
  const control = tree.props['data-peak-hours'] === 'control' ? tree : renderer.findByAttr('data-peak-hours', 'control')
  assert.ok(control, 'the control root must carry data-peak-hours="control"')
  assert.equal(control.props['data-status'], 'loading')
  assert.equal(internals.translate(internals.DICTS, 'zh', 'button.loading'), '时段读取中')
  assert.ok(renderer.text().includes('时段读取中'))
})

test('a paused idle-only response renders 「空闲时段 · 已暂停」 with the amber dot', async () => {
  const { renderer, internals } = setup({ routes: { [STATE_URL]: envelope(state({ mode: 'idle-only', phase: 'peak', paused: true })) } })
  renderer.render()
  await flush()
  renderer.render()
  const control = renderer.findByAttr('data-peak-hours', 'control')
  assert.equal(control.props['data-status'], 'paused')
  assert.equal(control.props['data-mode'], 'idle-only')
  assert.equal(control.props['data-paused'], 'true')
  const dot = renderer.findByAttr('data-dot', 'warn')
  assert.ok(dot, 'expected the amber dot element')
  assert.equal(dot.props.style.background, internals.DOT_COLOR.warn)
  assert.equal(dot.props.style.background, 'var(--dsw-alias-state-warn-primary, #f59e0b)')
  assert.ok(renderer.text().includes('空闲时段 · 已暂停'))
})

test('an idle-only running response renders the green dot', async () => {
  const { renderer } = setup({ routes: { [STATE_URL]: envelope(state({ mode: 'idle-only', phase: 'idle', paused: false })) } })
  renderer.render()
  await flush()
  renderer.render()
  assert.equal(renderer.findByAttr('data-peak-hours', 'control').props['data-status'], 'running')
  const dot = renderer.findByAttr('data-dot', 'success')
  assert.equal(dot.props.style.background, 'var(--dsw-alias-state-success-primary, #22c55e)')
  assert.ok(renderer.text().includes('空闲时段 · 运行中'))
})

test('an always response renders the neutral 「全天运行」 pill', async () => {
  const { renderer } = setup({ routes: { [STATE_URL]: envelope(state({ mode: 'always' })) } })
  renderer.render()
  await flush()
  renderer.render()
  assert.equal(renderer.findByAttr('data-peak-hours', 'control').props['data-status'], 'always')
  assert.equal(renderer.findByAttr('data-dot', 'neutral').props.style.background, 'var(--dsw-alias-state-idle-primary, #d4d4d4)')
  assert.ok(renderer.text().includes('全天运行'))
})

test('a failed poll renders the muted 「时段不可用」 pill without throwing', async () => {
  const { renderer } = setup({ routes: { [STATE_URL]: { reject: new Error('ECONNREFUSED') } } })
  renderer.render()
  await flush()
  renderer.render()
  const control = renderer.findByAttr('data-peak-hours', 'control')
  assert.equal(control.props['data-status'], 'unavailable')
  assert.equal(renderer.findByAttr('data-dot', 'muted').props.style.background, 'var(--dsw-alias-label-caption, #adb2b8)')
  assert.ok(renderer.text().includes('时段不可用'))
})

test('clicking the pill opens a popover with both options and the required facts', async () => {
  const { renderer, clock } = setup({
    routes: {
      [STATE_URL]: envelope(
        state({ mode: 'idle-only', phase: 'peak', paused: true, waitingTasks: 2, holidayToday: { dateKey: '2026-10-09', name: '国庆节' } })
      ),
    },
  })
  renderer.render()
  await flush()
  renderer.render()
  assert.equal(renderer.findByAttr('data-peak-hours', 'popover'), undefined, 'the popover starts closed')

  renderer.fire(renderer.findByAttr('data-peak-hours', 'control').props.children[0] ?? renderer.find((node) => node.type === 'button'), 'onClick')
  const popover = renderer.findByAttr('data-peak-hours', 'popover')
  assert.ok(popover, 'clicking the pill must open the popover')
  assert.equal(popover.props.role, 'dialog')

  const options = renderer.findAll((node) => node.props?.role === 'radio')
  assert.equal(options.length, 3, 'two run windows plus "follow the default"')
  assert.deepEqual(
    options.map((option) => option.props['data-mode']),
    ['always', 'idle-only', 'follow']
  )
  assert.deepEqual(
    options.map((option) => option.props['data-selected']),
    ['false', 'true', 'false'],
    'the active mode must be marked, and only it'
  )

  const text = renderer.text()
  assert.ok(text.includes('全天运行'), 'option 1')
  assert.ok(text.includes('仅空闲时段'), 'option 2')
  assert.ok(text.includes('跟随默认值'), 'option 3')
  assert.ok(text.includes('2026-10-09 18:08:06'), 'the current Beijing time')
  assert.ok(text.includes('2026-10-12 09:00:00'), 'the next transition')
  assert.ok(text.includes('01:00:00'), 'the live countdown')
  assert.ok(text.includes('国庆节'), "today's holiday name")
  assert.ok(text.includes('2 个'), 'the queued task count')
  assert.ok(text.includes('09:00-12:00 / 14:00-18:00'), 'the peak windows')
  assert.equal(clock.now, CLOCK_START, 'the harness clock never advanced on its own')
})

test('the countdown ticks locally once a second without another request', async () => {
  const { renderer, timers, fetchImpl, clock } = setup({
    routes: { [STATE_URL]: envelope(state({ nextTransitionAt: CLOCK_START + 3_600_500, msUntilTransition: 3_600_500 })) },
  })
  renderer.render()
  await flush()
  renderer.render()
  renderer.fire(renderer.find((node) => node.type === 'button'), 'onClick')
  assert.ok(renderer.text().includes('01:00:00'))

  const tick = timers.intervals.find((handle) => handle.ms === 1000)
  assert.ok(tick, 'the popover must install a 1 Hz local tick')
  const requestsBefore = fetchImpl.calls.length
  clock.advance(1000)
  tick.fn()
  renderer.render()
  assert.ok(renderer.text().includes('00:59:59'), 'the countdown must move after one tick')
  assert.equal(fetchImpl.calls.length, requestsBefore, 'a tick must never hit the network')
})

test('the popover refreshes on open and closes on an outside pointerdown', async () => {
  const { renderer, document, fetchImpl } = setup({ routes: { [STATE_URL]: envelope(state()) } })
  renderer.render()
  await flush()
  const afterMount = fetchImpl.count(STATE_URL)
  renderer.fire(renderer.find((node) => node.type === 'button'), 'onClick')
  await flush()
  assert.equal(fetchImpl.count(STATE_URL), afterMount + 1, 'opening must refresh the state')
  assert.equal(document.count('pointerdown'), 1, 'an outside-click listener must be installed')

  document.dispatch('pointerdown', { target: { fake: true } })
  renderer.render()
  assert.equal(renderer.findByAttr('data-peak-hours', 'popover'), undefined, 'an outside click must close the popover')
  assert.equal(document.count('pointerdown'), 0, 'the listener must be removed on close')
})

test('a pointerdown inside the control does not close the popover', async () => {
  const { renderer, document } = setup({ routes: { [STATE_URL]: envelope(state()) } })
  renderer.render()
  await flush()
  renderer.render()
  renderer.fire(renderer.find((node) => node.type === 'button'), 'onClick')
  const inside = renderer.findByAttr('data-peak-hours', 'control')
  const originalContains = { contains: (target) => target === 'inside' }
  inside.props.ref.current = originalContains
  document.dispatch('pointerdown', { target: 'inside' })
  renderer.render()
  assert.ok(renderer.findByAttr('data-peak-hours', 'popover'), 'a click inside must keep it open')
})

test('Escape closes the popover and the key listener is removed', async () => {
  const { renderer, document } = setup({ routes: { [STATE_URL]: envelope(state()) } })
  renderer.render()
  await flush()
  renderer.render()
  renderer.fire(renderer.find((node) => node.type === 'button'), 'onClick')
  assert.equal(document.count('keydown'), 1)
  document.dispatch('keydown', { key: 'Escape' })
  renderer.render()
  assert.equal(renderer.findByAttr('data-peak-hours', 'popover'), undefined)
  assert.equal(document.count('keydown'), 0)
  assert.equal(document.count('pointerdown'), 0)
})

test('9.4: selecting 全天运行 writes THIS session only and re-renders from the response', async () => {
  const { renderer, fetchImpl, internals } = setup({
    routes: {
      [STATE_URL]: envelope(state({ mode: 'idle-only', phase: 'peak', paused: true })),
      [MODE_URL]: envelope(state({ mode: 'always', sessionId: SESSION, modeSource: 'session' })),
    },
  })
  renderer.render()
  await flush()
  renderer.render()
  renderer.fire(renderer.find((node) => node.type === 'button'), 'onClick')
  const alwaysOption = renderer.findAll((node) => node.props?.role === 'radio')[0]
  renderer.fire(alwaysOption, 'onClick')
  await flush()
  renderer.render()

  assert.equal(fetchImpl.count(MODE_URL), 1)
  const post = fetchImpl.calls.find((call) => call.key === MODE_URL)
  assert.equal(post.init.method, 'POST')
  assert.equal(post.init.body, JSON.stringify({ mode: 'always', scope: 'session', session: SESSION }))
  assert.deepEqual({ ...post.init.headers }, { 'content-type': 'application/json' })
  assert.equal(renderer.findByAttr('data-peak-hours', 'control').props['data-status'], 'always')
  assert.equal(internals.translate(internals.DICTS, 'zh', 'button.always'), '全天运行')
  assert.ok(renderer.text().includes('全天运行'))
})

test('a failed mode switch shows the error inside the popover and keeps the state', async () => {
  const { renderer } = setup({
    routes: {
      [STATE_URL]: envelope(state({ mode: 'idle-only', phase: 'peak', paused: true })),
      [MODE_URL]: { status: 500, body: { ok: false, error: 'nope' } },
    },
  })
  renderer.render()
  await flush()
  renderer.render()
  renderer.fire(renderer.find((node) => node.type === 'button'), 'onClick')
  renderer.fire(renderer.findAll((node) => node.props?.role === 'radio')[1], 'onClick')
  await flush()
  renderer.render()
  assert.ok(renderer.text().includes('切换失败：HTTP 500'), 'the popover must explain the failure')
  assert.equal(renderer.findByAttr('data-peak-hours', 'control').props['data-status'], 'paused', 'the last good state stays')
})

test('the page polls every 15 s and refreshes on visibilitychange', async () => {
  const { renderer, timers, document, fetchImpl } = setup({ routes: { [STATE_URL]: envelope(state()) } })
  renderer.render()
  await flush()
  const poll = timers.intervals.find((handle) => handle.ms === 15000)
  assert.ok(poll, 'exactly one 15 s poll must be armed')
  assert.equal(timers.intervals.filter((handle) => handle.ms === 15000).length, 1)
  const before = fetchImpl.count(STATE_URL)
  poll.fn()
  await flush()
  assert.equal(fetchImpl.count(STATE_URL), before + 1)
  document.dispatch('visibilitychange')
  await flush()
  assert.equal(fetchImpl.count(STATE_URL), before + 2, 'returning to the tab must refresh')
})

test('unmount clears every timer and listener (no leak)', async () => {
  const { renderer, timers, document } = setup({ routes: { [STATE_URL]: envelope(state()) } })
  renderer.render()
  await flush()
  renderer.render()
  renderer.fire(renderer.find((node) => node.type === 'button'), 'onClick')
  assert.ok(timers.intervals.length >= 2, 'poll + tick while open')
  renderer.unmount()
  assert.equal(timers.intervals.length, 0, 'no interval may survive unmount')
  assert.equal(document.count('visibilitychange'), 0)
  assert.equal(document.count('pointerdown'), 0)
  assert.equal(document.count('keydown'), 0)
})

test('the request timeout handle is always cleared', async () => {
  const { renderer, timers } = setup({ routes: { [STATE_URL]: envelope(state()) } })
  renderer.render()
  await flush()
  assert.equal(timers.timeouts.length, 0, 'the 8 s abort timer must not outlive the request')
})

test('every registration the render path performs uses inline styles only', async () => {
  const { renderer } = setup({ routes: { [STATE_URL]: envelope(state()) } })
  renderer.render()
  await flush()
  renderer.render()
  renderer.fire(renderer.find((node) => node.type === 'button'), 'onClick')
  const styled = renderer.all().filter((node) => node.props?.style !== undefined)
  assert.ok(styled.length > 5, 'the control styles itself inline (no CSS build step)')
  assert.equal(renderer.all().filter((node) => node.props?.className !== undefined).length, 0, 'no hashed class names')
})

// ---------------------------------------------------------------------------
// Lead's UI defect brief: the boundary crossing (P1/P2) and the cadence (P3).
// ---------------------------------------------------------------------------

test('P1/P2: crossing the boundary on screen flips the pill and asks for a refresh', async () => {
  const { renderer, timers, clock, fetchImpl } = setup({
    routes: { [STATE_URL]: envelope(state({ mode: 'idle-only', phase: 'peak', paused: true, waitingTasks: 2, nextPhase: 'idle', nextTransitionAt: CLOCK_START + 10_000, msUntilTransition: 10_000 })) },
  })
  renderer.render()
  await flush()
  renderer.render()
  const control = renderer.findByAttr('data-peak-hours', 'control')
  assert.equal(control.props['data-status'], 'paused', 'the snapshot still describes the peak window')
  assert.equal(control.props['data-rolled'], 'false')
  const requestsBefore = fetchImpl.calls.length

  // 15 s of wall clock later the popover is rendered again — exactly the user's
  // screenshot moment (snapshot 11:59:50, screen 12:00:05).
  clock.advance(15_000)
  const tick = timers.intervals.find((handle) => handle.ms === 1000)
  tick.fn()
  renderer.render()

  const after = renderer.findByAttr('data-peak-hours', 'control')
  assert.equal(after.props['data-status'], 'running', 'the host resumed at the boundary')
  assert.equal(after.props['data-paused'], 'false')
  assert.equal(after.props['data-phase'], 'idle')
  assert.equal(after.props['data-rolled'], 'true')
  assert.ok(renderer.text().includes('空闲时段 · 运行中'))
  assert.equal(after.props.children[0].props.children[0].props['data-dot'], 'success')
  // P2: one extra request, and never a negative countdown on screen.
  assert.equal(fetchImpl.calls.length, requestsBefore + 1, 'the crossing must trigger exactly one refresh')
  assert.equal(/-00:00:05/.test(renderer.text()), false)
})

/** Read one popover detail row's value by its label (rendered `DetailRow`). */
function detailValue(renderer, label) {
  const row = renderer.findAll(
    (node) => Array.isArray(node.props?.children) && node.props.children.some((child) => child && child.props && child.props.children === label)
  )[0]
  if (!row) return undefined
  const value = row.props.children[1]
  return typeof value === 'string' ? value : value?.props?.children
}

/**
 * One option row by its stable id. Scoped to `role="radio"` because the control
 * root also carries `data-mode` (the resolved mode of this session).
 */
function radioOption(renderer, key) {
  return renderer.find((node) => node.props?.role === 'radio' && node.props['data-mode'] === key)
}

test('P2: the popover shows the refreshing sentinel instead of a negative countdown', async () => {
  const { renderer, clock, timers } = setup({
    routes: { [STATE_URL]: envelope(state({ mode: 'idle-only', phase: 'peak', reason: 'peak', paused: true, waitingTasks: 2, nextPhase: 'idle', nextTransitionAt: CLOCK_START + 5000, msUntilTransition: 5000 })) },
  })
  renderer.render()
  await flush()
  renderer.render()
  renderer.fire(renderer.find((node) => node.type === 'button'), 'onClick')
  assert.ok(renderer.text().includes('(00:00:05)'), 'a live countdown just before the boundary')
  assert.equal(detailValue(renderer, '当前时段'), '高峰 · 工作时段')
  clock.advance(8000)
  timers.intervals.find((handle) => handle.ms === 1000).fn()
  renderer.render()
  const text = renderer.text()
  assert.ok(text.includes('正在刷新…'), `expected the refreshing sentinel, got: ${text}`)
  assert.equal(text.includes('-00:00:'), false, 'no negative countdown may reach the screen')
  assert.equal(detailValue(renderer, '当前时段'), '空闲', 'the phase row advanced and dropped the stale reason')
  assert.equal(detailValue(renderer, '下次切换'), '正在刷新…', 'the past switch time is replaced by the sentinel')
  assert.equal(text.includes('排队任务'), false, 'stale queue numbers are hidden')
})

test('P3: the poll interval drops to 3 s while a boundary is within 30 s', async () => {
  const { renderer, timers } = setup({
    routes: { [STATE_URL]: envelope(state({ mode: 'idle-only', phase: 'peak', paused: true, nextTransitionAt: CLOCK_START + 20_000, msUntilTransition: 20_000 })) },
  })
  renderer.render()
  await flush()
  renderer.render()
  assert.equal(timers.intervals.filter((handle) => handle.ms === 3000).length, 1, 'a near boundary polls fast')
  assert.equal(timers.intervals.filter((handle) => handle.ms === 15000).length, 0)
})

test('P3: the poll interval stays at 15 s far from any boundary', async () => {
  const { renderer, timers } = setup({ routes: { [STATE_URL]: envelope(state()) } })
  renderer.render()
  await flush()
  renderer.render()
  assert.equal(timers.intervals.filter((handle) => handle.ms === 15000).length, 1)
  assert.equal(timers.intervals.filter((handle) => handle.ms === 3000).length, 0)
})

test('P7: the rendered popover is an opaque bordered card', async () => {
  const { renderer, internals } = setup({ routes: { [STATE_URL]: envelope(state()) } })
  renderer.render()
  await flush()
  renderer.render()
  renderer.fire(renderer.find((node) => node.type === 'button'), 'onClick')
  const popover = renderer.findByAttr('data-peak-hours', 'popover')
  // P8: the white card step — `bg-overlay` is bluish-150 (#e9ecf2) in light mode
  // and was the grey card the user reported.
  assert.equal(popover.props.style.background, 'var(--dsw-alias-bg-layer-1, #ffffff)')
  assert.equal(popover.props.style.border, '1px solid var(--dsw-alias-border-l1, #e5e6eb)')
  assert.equal(popover.props.style.boxShadow, 'var(--dsw-elevation-panel, 0 8px 24px rgba(0, 0, 0, 0.12))')
  assert.equal(popover.props.style.borderRadius, 'var(--dsw-radius-lg, 16px)')
  // Nothing inside the card may fall back to a transparent surface either.
  for (const node of renderer.all()) {
    const style = node.props?.style
    if (!style || typeof style.background !== 'string') continue
    assert.notEqual(style.background, 'rgba(0, 0, 0, 0)', 'a transparent fill would let the transcript show through')
  }
  assert.equal(internals.THEME_TOKENS.allowed.length, 112, '101 runtime aliases + 11 radius/elevation names')
  // The primary text colour really is the near-black step, not a grey.
  assert.equal(popover.props.style.color, 'var(--dsw-alias-label-primary, #0f1115)')
})

test('P4: the rendered override line counts down the demo window, not the offset', async () => {
  const { renderer } = setup({
    routes: {
      [STATE_URL]: envelope(
        state({ clockOverride: { offsetMs: 233_160_000, expiresAt: CLOCK_START + 598_000, ttlMs: 600_000 } })
      ),
    },
  })
  renderer.render()
  await flush()
  renderer.render()
  renderer.fire(renderer.find((node) => node.type === 'button'), 'onClick')
  const text = renderer.text()
  assert.ok(text.includes('演示模式：时间被临时偏移（模拟 2026-10-09 18:08:06）'), text)
  assert.ok(text.includes('剩余 00:09:58 后自动恢复真实时间'), text)
  assert.equal(text.includes('2d 16h 46m'), false, 'the offset magnitude must never be rendered again')
})

// ---------------------------------------------------------------------------
// P9: the queue banner above the composer card.
// ---------------------------------------------------------------------------

test('P9: a held peak window renders the banner with the switch time and countdown', async () => {
  const { banner, internals } = setup({
    routes: {
      [STATE_URL]: envelope(
        state({ mode: 'idle-only', phase: 'peak', paused: true, waitingTasks: 2, nextTransitionAt: CLOCK_START + 7_200_000, msUntilTransition: 7_200_000 })
      ),
    },
  })
  banner.render()
  await flush()
  const tree = banner.render()
  assert.equal(tree.props['data-peak-hours'], 'banner')
  assert.equal(tree.props['data-banner'], 'waiting')
  assert.equal(tree.props['data-count'], '2')
  assert.equal(tree.props.role, 'status')
  assert.equal(tree.props['aria-label'], '运行时段提示')
  const text = banner.text()
  assert.ok(text.includes('自动开始'), text)
  assert.ok(text.includes('2 个任务排队中'), text)
  assert.ok(text.includes('还有 02:00:00'), text)
  assert.equal(text.includes('已暂停'), true, 'the hold is announced')
  assert.equal(/-00:00:/.test(text), false, 'no negative countdown on screen')
  assert.equal(internals.translate(internals.DICTS, 'zh', 'banner.waiting').startsWith('已暂停'), true)
})

test('P9: the banner carries the amber dot and the composer-dock styling', async () => {
  const { banner, internals } = setup({
    routes: { [STATE_URL]: envelope(state({ mode: 'idle-only', phase: 'peak', paused: true, waitingTasks: 1 })) },
  })
  banner.render()
  await flush()
  const tree = banner.render()
  assert.equal(tree.props.style.background, 'var(--dsw-alias-bg-layer-2, #f5f6f7)')
  assert.equal(tree.props.style.border, '1px solid var(--dsw-alias-border-l1, #e5e6eb)')
  assert.equal(tree.props.style.borderRadius, 'var(--dsw-radius-md, 12px)')
  assert.equal(tree.props.style.color, 'var(--dsw-alias-label-secondary, #61666b)')
  assert.equal(tree.props.style.width, '100%', 'full width above the card')
  const dot = banner.all().find((node) => node.props?.style?.background === internals.TOKEN.warn)
  assert.ok(dot, 'the warn dot must be rendered')
  assert.equal(dot.props.style.borderRadius, '999px')
})

test('P9: switching to idle removes the banner entirely', async () => {
  const { banner, timers } = setup({
    routes: {
      [STATE_URL]: [
        envelope(state({ mode: 'idle-only', phase: 'peak', paused: true, waitingTasks: 2 })),
        envelope(
          state({
            mode: 'idle-only',
            phase: 'idle',
            reason: 'off-hours',
            paused: false,
            waitingTasks: 0,
            now: CLOCK_START + 7_200_000,
            nowText: '2026-10-12 14:00:00',
            // A fresh idle snapshot whose own next boundary (14:00) is still ahead:
            // nothing to roll forward, so the phase really is idle.
            nextTransitionAt: CLOCK_START + 7_200_000 + 3_600_000,
            nextTransitionText: '2026-10-12 15:00:00',
            msUntilTransition: 3_600_000,
          })
        ),
      ],
    },
  })
  banner.render()
  await flush()
  assert.ok(banner.render(), 'the peak hold shows it')
  // The next poll lands on the idle window the host now reports.
  timers.intervals.find((handle) => handle.ms === 15000).fn()
  await flush()
  assert.equal(banner.render(), null, 'the banner is gone, not merely emptied')
  assert.equal(banner.text(), '')
})

test('P9: mode=always never renders the banner', async () => {
  const { banner } = setup({ routes: { [STATE_URL]: envelope(state({ mode: 'always', paused: false, waitingTasks: 3 })) } })
  banner.render()
  await flush()
  assert.equal(banner.render(), null, 'nothing at all — no empty placeholder')
  assert.equal(banner.text(), '')
})

test('P9: both occupants share one poller and one local tick', async () => {
  const { renderer, banner, timers, fetchImpl } = setup({
    routes: { [STATE_URL]: envelope(state({ mode: 'idle-only', phase: 'peak', paused: true, waitingTasks: 2 })) },
  })
  renderer.render()
  banner.render()
  await flush()
  renderer.render()
  banner.render()
  assert.equal(timers.intervals.filter((handle) => handle.ms === 1000).length, 1, 'one shared 1 Hz tick')
  assert.equal(timers.intervals.filter((handle) => handle.ms === 15000).length, 1, 'one shared poll')
  assert.equal(fetchImpl.count(STATE_URL), 1, 'mounting two occupants costs one request, not two')

  const before = fetchImpl.count(STATE_URL)
  timers.intervals.find((handle) => handle.ms === 1000).fn()
  renderer.render()
  banner.render()
  assert.equal(fetchImpl.count(STATE_URL), before, 'a tick never hits the network')
})

test('P9: the last subscriber of each occupant releases the shared timers', async () => {
  // The pill alone: unmounting it must stop everything (this is the existing
  // whole-plugin teardown guarantee, now owned by the shared store).
  const pillOnly = setup({ routes: { [STATE_URL]: envelope(state({ mode: 'idle-only', phase: 'peak', paused: true, waitingTasks: 1 })) } })
  pillOnly.renderer.render()
  await flush()
  assert.ok(pillOnly.timers.intervals.length >= 2)
  pillOnly.renderer.unmount()
  assert.equal(pillOnly.timers.intervals.length, 0, 'no poller survives the pill')

  // The banner alone: same guarantee, and it proves the banner subscribes even
  // when it renders nothing.
  const bannerOnly = setup({ routes: { [STATE_URL]: envelope(state({ mode: 'always', paused: false })) } })
  assert.equal(bannerOnly.banner.render(), null, 'hidden, yet still subscribed')
  await flush()
  assert.ok(bannerOnly.timers.intervals.length >= 2)
  bannerOnly.banner.unmount()
  assert.equal(bannerOnly.timers.intervals.length, 0, 'no poller survives the banner')
})

test('P9: the banner counts down locally with the shared tick', async () => {
  const { banner, timers, clock, fetchImpl } = setup({
    routes: {
      [STATE_URL]: envelope(
        state({
          mode: 'idle-only',
          phase: 'peak',
          reason: 'peak',
          paused: true,
          waitingTasks: 2,
          nextTransitionAt: CLOCK_START + 10_000,
          msUntilTransition: 10_000,
        })
      ),
    },
  })
  banner.render()
  await flush()
  banner.render()
  assert.ok(banner.text().includes('00:00:10'), banner.text())
  const before = fetchImpl.count(STATE_URL)
  clock.advance(1000)
  timers.intervals.find((handle) => handle.ms === 1000).fn()
  banner.render()
  assert.ok(banner.text().includes('00:00:09'), banner.text())
  assert.equal(fetchImpl.count(STATE_URL), before, 'the countdown is local')
})

// ---------------------------------------------------------------------------
// SPEC 9.3/9.4: per-session reads, scoped writes, and no session at all.
// ---------------------------------------------------------------------------

test('9.4: without a session neither occupant renders and nothing is requested', async () => {
  const { renderer, banner, fetchImpl, timers } = setup({ routes: { [STATE_URL]: envelope(state()) }, sessionId: null })
  assert.equal(renderer.render(), null, 'the pill renders nothing instead of a disabled control')
  assert.equal(banner.render(), null)
  await flush()
  renderer.render()
  banner.render()
  assert.equal(fetchImpl.calls.length, 0, 'no session means no read, not a read of the default')
  assert.equal(banner.text(), '')
  assert.equal(timers.intervals.length, 0, 'and no timers either')
})

test('9.3: the read URL carries the session, so the answer is about this conversation', async () => {
  const { renderer, banner, fetchImpl } = setup({
    routes: {
      [STATE_URL]: envelope(state({ mode: 'idle-only', phase: 'peak', paused: true, waitingTasks: 2 })),
      [OTHER_STATE_URL]: envelope(state({ mode: 'always', sessionId: OTHER_SESSION, waitingTasks: 9 })),
    },
  })
  renderer.render()
  banner.render()
  await flush()
  renderer.render()
  banner.render()
  assert.equal(fetchImpl.count(STATE_URL), 1)
  assert.equal(fetchImpl.count(OTHER_STATE_URL), 0, 'we never read another session')
  assert.ok(fetchImpl.calls[0].url.includes('?session='), fetchImpl.calls[0].url)
  // This session's own answer decides the pill, even though another session
  // would answer differently.
  assert.equal(renderer.findByAttr('data-peak-hours', 'control').props['data-mode'], 'idle-only')
  assert.ok(banner.text().includes('2 个任务排队中'), banner.text())
})

test('9.3/9.4: the popover states both scopes, the resolved mode and its source', async () => {
  const { renderer } = setup({
    routes: {
      [STATE_URL]: envelope(
        state({ mode: 'idle-only', phase: 'peak', paused: true, waitingTasks: 2, waitingTasksTotal: 7, modeSource: 'default' })
      ),
    },
  })
  renderer.render()
  await flush()
  renderer.render()
  renderer.fire(renderer.find((node) => node.type === 'button'), 'onClick')
  const text = renderer.text()
  assert.ok(text.includes('只改本会话'), `session scope note missing: ${text}`)
  assert.ok(text.includes('默认值'), 'the resolved mode source must be visible')
  assert.ok(text.includes('把「仅空闲时段」设为所有未单独设置的会话的默认值'), text)
  assert.ok(text.includes('本会话的设置保持不变'), text)
  const scopeNote = renderer.findByAttr('data-scope', 'session')
  assert.ok(scopeNote, 'the session-scope note is a stable hook for the verifier')
  const secondary = renderer.findByAttr('data-action', 'set-default')
  assert.ok(secondary, 'the default entry must exist')
  // Per-session and host-wide counts are both readable.
  assert.equal(detailValue(renderer, '排队任务'), '2 个')
  assert.equal(detailValue(renderer, '全部会话'), '7 个')
  assert.equal(detailValue(renderer, '模式来源'), '默认值')
})

test('9.4: the secondary entry writes scope:"default" and never this session', async () => {
  const { renderer, fetchImpl } = setup({
    routes: {
      [STATE_URL]: envelope(state({ mode: 'idle-only', phase: 'peak', paused: true })),
      [MODE_URL]: envelope(state({ mode: 'idle-only', modeSource: 'session' })),
    },
  })
  renderer.render()
  await flush()
  renderer.render()
  renderer.fire(renderer.find((node) => node.type === 'button'), 'onClick')
  renderer.fire(renderer.findByAttr('data-action', 'set-default'), 'onClick')
  await flush()
  renderer.render()
  const post = fetchImpl.calls.find((call) => call.key === MODE_URL)
  assert.ok(post, 'the default entry must POST')
  assert.deepEqual(JSON.parse(post.init.body), { mode: 'idle-only', scope: 'default' })
  // A default write says nothing about this session's own entry, so the client
  // re-reads its session instead of trusting the echo. Three reads by now: the
  // mount poll, the popover-open refresh, and this re-read.
  assert.equal(fetchImpl.count(STATE_URL), 3, 'mount + open + re-read after the default write')
})

test('9.4: a default write never sends a session field (it would imply session scope)', async () => {
  const { renderer, fetchImpl } = setup({
    routes: {
      [STATE_URL]: envelope(state({ mode: 'always', phase: 'idle', paused: false })),
      [MODE_URL]: envelope(state({ mode: 'always' })),
    },
  })
  renderer.render()
  await flush()
  renderer.render()
  renderer.fire(renderer.find((node) => node.type === 'button'), 'onClick')
  renderer.fire(renderer.findByAttr('data-action', 'set-default'), 'onClick')
  await flush()
  const body = JSON.parse(fetchImpl.calls.find((call) => call.key === MODE_URL).init.body)
  assert.deepEqual(body, { mode: 'always', scope: 'default' })
  assert.equal('session' in body, false)
})

test('9.3: a session write whose echo names another session is not trusted', async () => {
  const { renderer, fetchImpl } = setup({
    routes: {
      [STATE_URL]: envelope(state({ mode: 'idle-only', phase: 'peak', paused: true })),
      // A host that answered about the wrong session (or the default).
      [MODE_URL]: envelope(state({ mode: 'always', sessionId: OTHER_SESSION, modeSource: 'default' })),
    },
  })
  renderer.render()
  await flush()
  renderer.render()
  renderer.fire(renderer.find((node) => node.type === 'button'), 'onClick')
  renderer.fire(renderer.findAll((node) => node.props?.role === 'radio')[0], 'onClick')
  await flush()
  renderer.render()
  assert.equal(fetchImpl.count(STATE_URL), 3, 'mount + open + re-read of our own session instead of showing the echo')
  assert.equal(renderer.findByAttr('data-peak-hours', 'control').props['data-mode'], 'idle-only')
})

test('9.4: the banner counts this session, not the host-wide total', async () => {
  const { banner } = setup({
    routes: {
      [STATE_URL]: envelope(state({ mode: 'idle-only', phase: 'peak', paused: true, waitingTasks: 2, waitingTasksTotal: 9 })),
    },
  })
  banner.render()
  await flush()
  const tree = banner.render()
  assert.equal(tree.props['data-count'], '2', 'the banner shows this session only')
  assert.ok(banner.text().includes('2 个任务排队中'), banner.text())
  assert.equal(banner.text().includes('9 个任务排队中'), false, 'other sessions never appear in the banner')
})

// ---------------------------------------------------------------------------
// Follow-the-default option, and read-only degradation against a v1 host.
// ---------------------------------------------------------------------------

test('9.4: 「跟随默认值」 clears this session\'s override and is selected while following', async () => {
  const { renderer, fetchImpl } = setup({
    routes: {
      [STATE_URL]: envelope(state({ mode: 'idle-only', phase: 'peak', paused: true, modeSource: 'default', defaultMode: 'idle-only' })),
      [MODE_URL]: envelope(state({ mode: 'idle-only', modeSource: 'default' })),
    },
  })
  renderer.render()
  await flush()
  renderer.render()
  renderer.fire(renderer.find((node) => node.type === 'button'), 'onClick')

  const follow = radioOption(renderer, 'follow')
  assert.ok(follow, 'the third option must render')
  assert.equal(follow.props['data-selected'], 'true', 'no session override ⇒ following the default is the current choice')
  assert.equal(radioOption(renderer, 'idle-only').props['data-selected'], 'false', 'a defaulted mode is not a session setting')
  assert.ok(renderer.text().includes('跟随默认值'), renderer.text())
  assert.ok(renderer.text().includes('（当前默认值：仅空闲时段）'), renderer.text())

  renderer.fire(follow, 'onClick')
  await flush()
  const body = JSON.parse(fetchImpl.calls.find((call) => call.key === MODE_URL).init.body)
  assert.deepEqual(body, { mode: null, scope: 'session', session: SESSION })
})

test('9.3: the popover shows the unresolved-session diagnostic only when the host reports some', async () => {
  const withSome = setup({
    routes: {
      [STATE_URL]: envelope(state({ mode: 'idle-only', phase: 'peak', paused: true, waitingTasks: 2, waitingTasksTotal: 7, waitingTasksUnresolved: 3 })),
    },
  })
  withSome.renderer.render()
  await flush()
  withSome.renderer.render()
  withSome.renderer.fire(withSome.renderer.find((node) => node.type === 'button'), 'onClick')
  assert.equal(detailValue(withSome.renderer, '未识别会话的任务'), '3 个（按默认值判定）')

  const none = setup({ routes: { [STATE_URL]: envelope(state({ mode: 'idle-only', phase: 'peak', paused: true, waitingTasks: 2 })) } })
  none.renderer.render()
  await flush()
  none.renderer.render()
  none.renderer.fire(none.renderer.find((node) => node.type === 'button'), 'onClick')
  assert.equal(detailValue(none.renderer, '未识别会话的任务'), undefined, 'no field ⇒ no row')
})

test('9.4: 「跟随默认值」 is unselected once the session has its own choice', async () => {
  const { renderer } = setup({
    routes: { [STATE_URL]: envelope(state({ mode: 'always', phase: 'idle', paused: false, modeSource: 'session', defaultMode: 'idle-only' })) },
  })
  renderer.render()
  await flush()
  renderer.render()
  renderer.fire(renderer.find((node) => node.type === 'button'), 'onClick')
  assert.equal(radioOption(renderer, 'follow').props['data-selected'], 'false')
  assert.equal(radioOption(renderer, 'always').props['data-selected'], 'true')
  assert.ok(renderer.text().includes('（当前默认值：仅空闲时段）'), 'the description still names the default')
})

test('R8/9.3: a v1 host response yields a read-only popover and zero writes', async () => {
  const v1 = {
    mode: 'idle-only',
    phase: 'peak',
    reason: 'peak',
    now: CLOCK_START,
    nowText: '2026-10-09 18:08:06',
    nextTransitionAt: CLOCK_START + 3_600_000,
    nextTransitionText: '2026-10-12 09:00:00',
    nextPhase: 'idle',
    msUntilTransition: 3_600_000,
    paused: true,
    waitingTasks: 2,
    holidayToday: null,
    holidayCoverage: 'known',
    unknownHolidayYear: null,
    timeZone: 'Asia/Shanghai (UTC+8)',
    peakWindows: ['09:00-12:00', '14:00-18:00'],
    clockOverride: null,
    config: { allowClockOverride: true },
  }
  const { renderer, banner, fetchImpl } = setup({ routes: { [STATE_URL]: envelope(v1) } })
  renderer.render()
  banner.render()
  await flush()
  renderer.render()
  banner.render()

  const control = renderer.findByAttr('data-peak-hours', 'control')
  assert.equal(control.props['data-incompatible'], 'true')
  assert.equal(control.props['data-status'], 'unavailable')

  renderer.fire(renderer.find((node) => node.type === 'button'), 'onClick')
  const popover = renderer.findByAttr('data-peak-hours', 'popover')
  assert.equal(popover.props['data-incompatible'], 'true')
  assert.ok(renderer.text().includes('宿主版本不匹配，请刷新页面'), renderer.text())
  assert.equal(renderer.findAll((node) => node.props?.role === 'radio').length, 0, 'no clickable mode options')
  assert.equal(renderer.findByAttr('data-action', 'set-default'), undefined, 'no default-scope entry either')
  assert.equal(renderer.findByAttr('data-scope', 'session'), undefined, 'no scope note for a write that cannot happen')

  // Nothing to click, and even a forced submit path stays silent: the popover
  // offers no handler, and the component refuses to write through a v1 host.
  assert.equal(fetchImpl.calls.filter((call) => call.key === MODE_URL).length, 0, 'not a single write may be sent')
  assert.equal(banner.render(), null, 'the banner must not announce a hold it cannot verify')
})
