/**
 * Structure self-check: does `lib/client/index.js` load and mount the way the
 * browser shell requires it to?
 *
 * Loaded through a fake `globalThis.window.__ModuleLoader__` (see
 * `helpers/bundle.mjs`), the assertions cover SPEC.md 2.5's wrapper contract,
 * the `conversation.input.left` mount point, and the "apply must never throw"
 * rule.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { loadBundle, materialize, createCtxStub } from './helpers/bundle.mjs'

test('bundle registers exactly one ModuleLoader factory under the plugin id', () => {
  const load = loadBundle()
  assert.equal(load.loadCount, 1, 'expected exactly one __ModuleLoader__.load call')
  assert.ok(load.registration, 'no registration captured')
  assert.equal(load.registration.id, 'dsh-peak-hours')
  assert.equal(typeof load.registration.factory, 'function')
  assert.deepEqual(load.errors, [], 'bundle logged errors while loading')
})

test('factory materializes exports with apply() and the frozen inject list', () => {
  const load = loadBundle()
  const exports = materialize(load)
  assert.equal(typeof exports.apply, 'function')
  assert.ok(Array.isArray(exports.inject))
  // The array travels across the vm realm boundary: compare a host-realm copy.
  assert.deepEqual([...exports.inject], ['slots', 'locale'], 'SPEC 2.5 freezes inject to [slots, locale]')
  assert.equal(exports[Symbol.toStringTag], 'Module')
  // The bundle's own module record must be the one the loader caches.
  assert.equal(load.exports, exports)
})

test('the factory needs only the react seed modules', () => {
  const load = loadBundle()
  // The require stub throws for any other specifier, so a clean materialization
  // proves the zero-dependency rule.
  assert.doesNotThrow(() => materialize(load))
})

test('apply mounts the pill into conversation.input.left with id/order/locale', () => {
  const mod = materialize(loadBundle())
  const internals = mod.__internals
  const ctx = createCtxStub()
  assert.doesNotThrow(() => mod.apply(ctx))

  assert.deepEqual(
    [...ctx.calls.injections].sort(),
    ['conversation.input.dock', 'conversation.input.left'],
    'the pill and the queue banner each own one additive list slot'
  )
  const control = ctx.calls.registrations.find((entry) => entry.options.name === 'conversation.input.left')
  assert.ok(control, 'the composer control must register into conversation.input.left')
  assert.equal(control.options.id, 'peak-hours')
  assert.equal(control.options.order, 20)
  assert.equal(control.options.locale, 'dsh-peak-hours')
  assert.equal(control.component, internals.PeakHoursControl)

  assert.equal(ctx.calls.localeRegisters.length, 1)
  assert.equal(ctx.calls.localeRegisters[0].ns, 'dsh-peak-hours')
  assert.deepEqual(Object.keys(ctx.calls.localeRegisters[0].dicts).sort(), ['en', 'zh'])
})

test('P9: apply mounts the queue banner above the composer card', () => {
  const mod = materialize(loadBundle())
  const internals = mod.__internals
  const ctx = createCtxStub()
  mod.apply(ctx)
  const banner = ctx.calls.registrations.find((entry) => entry.options.name === 'conversation.input.dock')
  assert.ok(banner, 'the banner must register into conversation.input.dock')
  assert.equal(banner.options.id, 'peak-hours')
  assert.equal(banner.options.order, 30, 'after the official todo (0) and queue (20) docks, closest to the card')
  assert.equal(banner.options.locale, 'dsh-peak-hours')
  assert.equal(banner.component, internals.PeakHoursBanner)
  // The dock is a list slot: `id` is mandatory, and we must not touch the keyed
  // chat-node slot that carries the shipped turn-process renderer.
  assert.equal(ctx.calls.registrations.some((entry) => entry.options.name === 'conversation.chat.node'), false)
  assert.equal(ctx.calls.injections.includes('conversation.chat.node'), false)
})

test('every registration runs inside ctx.effect so disposal is automatic', () => {
  const load = loadBundle()
  const exports = materialize(load)
  const ctx = createCtxStub()
  exports.apply(ctx)
  assert.equal(ctx.calls.effects.length, 4, 'store teardown + dictionaries + composer control + queue banner')
  assert.ok(ctx.calls.effects.some((label) => /dictionar/i.test(label)))
  assert.ok(ctx.calls.effects.some((label) => /composer/i.test(label)))
  assert.ok(ctx.calls.effects.some((label) => /banner/i.test(label)))
  assert.equal(ctx.calls.effects.filter((label) => /shared poller/i.test(label)).length, 1, 'the shared poller is torn down exactly once')
  assert.doesNotThrow(() => ctx.disposeAll())
})

test('the inject callback returns the register disposer (the effect contract)', () => {
  const load = loadBundle()
  const exports = materialize(load)
  let disposer
  const ctx = createCtxStub()
  ctx.slots.inject = (key, callback) => {
    ctx.calls.injections.push(key)
    const result = callback()
    disposer = result
    return result
  }
  exports.apply(ctx)
  assert.equal(typeof disposer, 'function', 'slots.inject callback must hand back a disposer')
})

test('loading the bundle does not render or touch the network', () => {
  const load = loadBundle()
  const exports = materialize(load)
  assert.deepEqual(load.errors, [])
  assert.deepEqual(load.warnings, [])
  // No fetch/document is provided to the vm context at all: reaching for one
  // during load would have thrown.
  assert.equal(typeof exports.__internals.PeakHoursControl, 'function')
})

test('apply never throws, whichever service seam fails', () => {
  const load = loadBundle()
  const exports = materialize(load)
  for (const failOn of ['effect', 'locale', 'inject', 'register']) {
    const ctx = createCtxStub({ failOn })
    assert.doesNotThrow(() => exports.apply(ctx), `apply threw with failOn=${failOn}`)
  }
})

test('apply tolerates a context with no services at all', () => {
  const load = loadBundle()
  const exports = materialize(load)
  assert.doesNotThrow(() => exports.apply({}))
  assert.doesNotThrow(() => exports.apply({ effect: (cb) => cb() }))
  assert.doesNotThrow(() => exports.apply(null))
  assert.doesNotThrow(() => exports.apply(undefined))
})

test('a failing seam is logged as a warning, not swallowed silently', () => {
  const load = loadBundle()
  const exports = materialize(load)
  const ctx = createCtxStub({ failOn: 'inject' })
  exports.apply(ctx)
  // console.warn in the vm context funnels into load.warnings.
  assert.ok(load.warnings.some((line) => line.includes('composer control')), 'expected a warning about the composer control')
})
