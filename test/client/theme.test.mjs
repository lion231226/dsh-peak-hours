/**
 * Theme-token discipline tests (P7 + P8).
 *
 * The popover once rendered as a see-through grey card: it styled itself with a
 * semi-transparent menu surface (`#f8f9fa94`, which the official menu only uses
 * together with a backdrop-filter layer) and, after the first fix, with
 * `--dsw-alias-bg-overlay` — the grey step (`bluish-150` = #e9ecf2), not the
 * white card step. It also washed its text with `opacity` instead of using the
 * real label steps. These tests make all three rules structural:
 *
 *   1. every `var(--dsw-…)` in the shipped bundle is in the allow-list
 *      (101 aliases as defined by the running theme + the radius/elevation set),
 *   2. every alias reference carries an opaque fallback equal to its light value,
 *   3. the card is the white layer-1 surface with primary (near-black) text and
 *      tertiary explanations — no opacity hacks.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { loadBundleExports, BUNDLE_PATH } from './helpers/bundle.mjs'

const { internals } = loadBundleExports()
const { THEME_TOKENS, TOKEN, DOT_COLOR } = internals
const source = readFileSync(BUNDLE_PATH, 'utf8')

/** The runtime-extracted alias list (Lead-owned recon artifact). */
const TOKENS_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '_recon', 'theme-tokens.txt')

/** Every `var(--dsw-…)` occurrence with the token name it references. */
const varNames = [...source.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((match) => match[1])
/** Every `var(…)` occurrence with what follows the name (`,` = has a fallback). */
const varCalls = [...source.matchAll(/var\((--dsw-[a-z0-9-]+)\s*([,)])/g)].map((match) => ({
  name: match[1],
  hasFallback: match[2] === ',',
  fallback: source
    .slice(source.indexOf(`var(${match[1]}`))
    .match(/^var\([^,]+,\s*([^)]+)\)/)?.[1]
    ?.trim(),
}))

test('P8: the allow-list is the 101 runtime aliases plus radius and elevation', () => {
  assert.equal(THEME_TOKENS.alias.length, 101)
  assert.equal(THEME_TOKENS.dimension.length, 11)
  assert.equal(THEME_TOKENS.allowed.length, 112)
  assert.equal(new Set(THEME_TOKENS.allowed).size, 112, 'no duplicates in the allow-list')
  for (const name of THEME_TOKENS.alias) assert.match(name, /^--dsw-alias-[a-z0-9-]+$/)
  for (const name of THEME_TOKENS.dimension) assert.match(name, /^--dsw-(radius|elevation)-[a-z-]+$/)
})

test('P8: the in-bundle alias list is exactly the runtime-extracted set', () => {
  if (!existsSync(TOKENS_FILE)) {
    // The recon artifact is the cross-check source; without it, at least pin the
    // names this plugin depends on.
    for (const name of [
      '--dsw-alias-bg-layer-1',
      '--dsw-alias-label-primary',
      '--dsw-alias-label-tertiary',
      '--dsw-alias-interactive-bg-hover',
      '--dsw-alias-border-l3',
    ]) {
      assert.ok(THEME_TOKENS.alias.includes(name), `${name} must stay in the allow-list`)
    }
    return
  }
  const lines = readFileSync(TOKENS_FILE, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  assert.equal(lines.length, 101, `${TOKENS_FILE} must carry the 101 aliases`)
  const fromFile = lines.map((line) => `--${line}`).sort()
  assert.deepEqual([...THEME_TOKENS.alias].sort(), fromFile, 'the bundle list drifted from the runtime extract')
})

test('P8: the names the Lead asked about are in the runtime set', () => {
  assert.ok(THEME_TOKENS.alias.includes('--dsw-alias-state-business-primary'), 'business-primary exists (kept out of use on purpose)')
  assert.ok(THEME_TOKENS.alias.includes('--dsw-alias-border-l3'), 'border-l3 exists and is used for the radio ring')
  assert.ok(THEME_TOKENS.alias.includes('--dsw-alias-label-tertiary'))
  assert.ok(THEME_TOKENS.alias.includes('--dsw-alias-label-caption'))
  assert.ok(THEME_TOKENS.alias.includes('--dsw-alias-label-dimmed'))
  assert.ok(THEME_TOKENS.alias.includes('--dsw-alias-interactive-bg-hover'))
  assert.equal(THEME_TOKENS.alias.includes('--dsw-menu-surface-fill'), false, 'menu-surface-fill is not an alias: it lives in the specific-* family')
})

test('P8: the bundle references no theme token outside the allow-list', () => {
  assert.ok(varNames.length > 0, 'the bundle must style itself with theme tokens')
  const offenders = [...new Set(varNames)].filter((name) => !THEME_TOKENS.allowed.includes(name))
  assert.deepEqual(offenders, [], `unregistered theme tokens: ${offenders.join(', ')}`)
})

test('P7/P8: the tokens that caused the see-through card never come back', () => {
  // `--dsw-menu-surface-fill` is #f8f9fa94 (58% alpha): correct only behind the
  // official backdrop-filter layer, never on a standalone inline-styled card.
  for (const banned of ['--dsw-menu-surface-fill', '--dsw-specific-menu', '--dsw-menu-backdrop-filter']) {
    assert.equal(varNames.includes(banned), false, `${banned} must not style this card directly`)
  }
})

test('P7: every var() carries a fallback, opaque for colour tokens', () => {
  assert.ok(varCalls.length > 0)
  const missing = varCalls.filter((call) => !call.hasFallback).map((call) => call.name)
  assert.deepEqual([...new Set(missing)], [], `var() without a fallback: ${[...new Set(missing)].join(', ')}`)
  for (const call of varCalls) {
    assert.ok(call.fallback, `no fallback parsed for ${call.name}`)
    if (call.name.startsWith('--dsw-alias-')) {
      assert.match(call.fallback, /^#[0-9a-f]{6}$/, `${call.name} needs an opaque hex fallback, got ${call.fallback}`)
    } else if (call.name.startsWith('--dsw-radius-')) {
      assert.match(call.fallback, /^\d+px$/, `${call.name} needs a px fallback, got ${call.fallback}`)
    } else if (call.name.startsWith('--dsw-elevation-')) {
      assert.ok(call.fallback.length > 0, `${call.name} needs a fallback`)
    }
  }
})

test('P8: the card is the white layer-1 surface, not the grey overlay step', () => {
  const popover = THEME_TOKENS.style.popover
  assert.equal(popover.background, 'var(--dsw-alias-bg-layer-1, #ffffff)')
  assert.equal(popover.border, '1px solid var(--dsw-alias-border-l1, #e5e6eb)')
  assert.equal(popover.borderRadius, 'var(--dsw-radius-lg, 16px)')
  assert.equal(popover.boxShadow, 'var(--dsw-elevation-panel, 0 8px 24px rgba(0, 0, 0, 0.12))')
  // The exact regression: `bg-overlay` is bluish-150 (#e9ecf2) in light mode.
  assert.equal(popover.background.includes('bg-overlay'), false)
  assert.equal(TOKEN.surface, 'var(--dsw-alias-bg-layer-1, #ffffff)')
})

test('P8: light-theme self-proof — white card, near-black primary text', () => {
  // Values read from the running shell's own light-theme block:
  // bg-layer-1 = bluish-00 = #fff, label-primary = bluish-1000 = #0f1115.
  assert.equal(TOKEN.surface, 'var(--dsw-alias-bg-layer-1, #ffffff)')
  assert.equal(TOKEN.text, 'var(--dsw-alias-label-primary, #0f1115)')
  assert.equal(TOKEN.secondary, 'var(--dsw-alias-label-secondary, #61666b)')
  assert.equal(TOKEN.tertiary, 'var(--dsw-alias-label-tertiary, #81858c)')
  assert.equal(TOKEN.caption, 'var(--dsw-alias-label-caption, #adb2b8)')
  assert.equal(TOKEN.dimmed, 'var(--dsw-alias-label-dimmed, #e1e5ee)')
  assert.equal(TOKEN.raised, 'var(--dsw-alias-interactive-bg-hover, #f2f3f5)')
})

test('P8: text roles use the real label steps, with no opacity washing', () => {
  const style = THEME_TOKENS.style
  // Values: primary; explanations and field names: tertiary.
  assert.equal(style.sectionLabel.color, 'var(--dsw-alias-label-primary, #0f1115)')
  assert.equal(style.option.color, 'var(--dsw-alias-label-primary, #0f1115)')
  assert.equal(style.rowValue.color, 'var(--dsw-alias-label-primary, #0f1115)')
  assert.equal(style.optionDesc.color, 'var(--dsw-alias-label-tertiary, #81858c)')
  assert.equal(style.rowLabel.color, 'var(--dsw-alias-label-tertiary, #81858c)')
  assert.equal(style.footnote.color, 'var(--dsw-alias-label-caption, #adb2b8)')
  assert.equal(style.buttonUnavailable.color, 'var(--dsw-alias-label-dimmed, #e1e5ee)')
  // The P7 convergence is reverted: only disabled affordances use opacity.
  for (const key of ['sectionLabel', 'optionDesc', 'rowLabel', 'footnote', 'buttonUnavailable', 'button', 'popover']) {
    assert.equal(style[key].opacity, undefined, `${key} must not wash its text with opacity`)
  }
  assert.equal(style.optionDisabled.opacity, 0.4, 'disabled rows keep their dimming')
})

test('P8: hover and open fills use the real interactive token', () => {
  assert.equal(THEME_TOKENS.style.buttonHover.background, 'var(--dsw-alias-interactive-bg-hover, #f2f3f5)')
  assert.equal(THEME_TOKENS.style.buttonOpen.background, 'var(--dsw-alias-interactive-bg-hover, #f2f3f5)')
  assert.equal(THEME_TOKENS.style.optionHover.background, 'var(--dsw-alias-interactive-bg-hover, #f2f3f5)')
  assert.equal(THEME_TOKENS.style.warning.background, 'var(--dsw-alias-interactive-bg-hover, #f2f3f5)')
})

test('P8: radii come from the radius family', () => {
  const style = THEME_TOKENS.style
  assert.equal(style.popover.borderRadius, 'var(--dsw-radius-lg, 16px)')
  assert.equal(style.option.borderRadius, 'var(--dsw-radius-md, 12px)')
  assert.equal(style.button.borderRadius, 'var(--dsw-radius-sm, 8px)')
  assert.equal(style.warning.borderRadius, 'var(--dsw-radius-sm, 8px)')
})

test('P8: the selected radio uses brand-primary; the unselected ring uses border-l3', () => {
  assert.equal(THEME_TOKENS.style.radioOn.border, '1.5px solid var(--dsw-alias-brand-primary, #0f1115)')
  assert.equal(THEME_TOKENS.style.radioDot.background, 'var(--dsw-alias-brand-primary, #0f1115)')
  assert.equal(THEME_TOKENS.style.radioOff.border, '1.5px solid var(--dsw-alias-border-l3, #e0e0e0)')
})

test('P8: the state dot keeps four visible steps', () => {
  assert.deepEqual(
    { ...DOT_COLOR },
    {
      neutral: 'var(--dsw-alias-state-idle-primary, #d4d4d4)',
      success: 'var(--dsw-alias-state-success-primary, #22c55e)',
      warn: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
      muted: 'var(--dsw-alias-label-caption, #adb2b8)',
    }
  )
  for (const value of Object.values(DOT_COLOR)) assert.match(value, /^var\(--dsw-[a-z0-9-]+, #[0-9a-f]{6}\)$/)
})

test('P8: text colours resolve to registered label or state steps only', () => {
  const allowedText =
    /^var\(--dsw-alias-(label-(primary|secondary|tertiary|caption|dimmed)|state-(warn|error|success|idle)-primary|brand-primary), #[0-9a-f]{6}\)$/
  for (const [key, value] of Object.entries(THEME_TOKENS.style)) {
    if (typeof value.color !== 'string') continue
    assert.match(value.color, allowedText, `${key}.color must use a registered label or state step`)
  }
})

test('P8: no style value is empty or leaks a JS value', () => {
  for (const [key, value] of Object.entries(THEME_TOKENS.style)) {
    for (const [prop, propValue] of Object.entries(value)) {
      if (typeof propValue !== 'string') continue
      assert.notEqual(propValue.trim(), '', `${key}.${prop} must not be empty`)
      assert.equal(/\bundefined\b|\bnull\b/.test(propValue), false, `${key}.${prop} leaked a JS value: ${propValue}`)
    }
  }
})
