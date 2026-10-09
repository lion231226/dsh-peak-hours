/**
 * Pure copy/font tests: zh/en dictionary selection, `{name}` interpolation, the
 * CJK font stack choice, and the rendered-language probe that keeps the two in
 * step.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { loadBundleExports } from './helpers/bundle.mjs'

const { internals } = loadBundleExports()
const { DICTS, resolveDictionary, translate, fontFamilyFor, isChinese, normalizeLocale, detectRenderedLocale } = internals

test('resolveDictionary matches an exact tag first', () => {
  assert.equal(resolveDictionary(DICTS, 'zh'), DICTS.zh)
  assert.equal(resolveDictionary(DICTS, 'en'), DICTS.en)
})

test('resolveDictionary falls back to the primary subtag', () => {
  assert.equal(resolveDictionary(DICTS, 'zh-CN'), DICTS.zh)
  assert.equal(resolveDictionary(DICTS, 'zh-Hans-CN'), DICTS.zh)
  assert.equal(resolveDictionary(DICTS, 'en-US'), DICTS.en)
})

test('resolveDictionary normalizes case and whitespace, and defaults to English', () => {
  assert.equal(resolveDictionary(DICTS, ' ZH-cn '), DICTS.zh)
  assert.equal(resolveDictionary(DICTS, 'fr'), DICTS.en)
  assert.equal(resolveDictionary(DICTS, ''), DICTS.en)
  assert.equal(resolveDictionary(DICTS, null), DICTS.en)
  assert.equal(resolveDictionary(DICTS, 42), DICTS.en)
})

test('normalizeLocale and isChinese agree', () => {
  assert.equal(normalizeLocale(' ZH-Hant '), 'zh-hant')
  assert.equal(normalizeLocale(undefined), '')
  assert.equal(isChinese('zh-TW'), true)
  assert.equal(isChinese('en-GB'), false)
  assert.equal(isChinese(''), false)
})

test('fontFamilyFor uses a CJK stack for Chinese and inherits otherwise', () => {
  const zhFont = fontFamilyFor('zh-CN')
  assert.match(zhFont, /YaHei/)
  assert.match(zhFont, /PingFang SC/)
  assert.notEqual(zhFont, 'inherit')
  assert.equal(fontFamilyFor('en'), 'inherit')
  assert.equal(fontFamilyFor(''), 'inherit')
})

test('translate interpolates {name} params', () => {
  assert.equal(translate(DICTS, 'zh', 'row.waitingValue', { count: 2 }), '2 个')
  assert.equal(translate(DICTS, 'en', 'row.waitingValue', { count: 2 }), '2')
  assert.equal(
    translate(DICTS, 'zh', 'warning.unknownYear', { year: 2028 }),
    '2028 年节假日数据缺失，该年工作日一律按非节假日判定。'
  )
  assert.equal(
    translate(DICTS, 'en', 'warning.clockOverrideTtl', { at: '2026-10-12 12:00:05', ttl: '00:09:58' }),
    'Demo mode: the clock is temporarily offset (simulating 2026-10-12 12:00:05); real time resumes in 00:09:58'
  )
  assert.equal(
    translate(DICTS, 'zh', 'warning.clockOverrideTtl', { at: '2026-10-12 12:00:05', ttl: '00:09:58' }),
    '演示模式：时间被临时偏移（模拟 2026-10-12 12:00:05），剩余 00:09:58 后自动恢复真实时间'
  )
  assert.equal(translate(DICTS, 'zh', 'warning.clockOverridePlain'), '演示模式：时间被临时偏移')
})

test('translate leaves an unmatched placeholder untouched and falls back to the key', () => {
  assert.equal(translate(DICTS, 'zh', 'row.waitingValue', { other: 1 }), '{count} 个')
  assert.equal(translate(DICTS, 'zh', 'nope.missing'), 'nope.missing')
})

test('the zh and en dictionaries stay key-complete', () => {
  const zhKeys = Object.keys(DICTS.zh).sort()
  const enKeys = Object.keys(DICTS.en).sort()
  assert.deepEqual(enKeys, zhKeys)
  for (const key of zhKeys) {
    assert.equal(typeof DICTS.zh[key], 'string', `zh[${key}] must be a string`)
    assert.notEqual(DICTS.zh[key], '', `zh[${key}] must not be empty`)
    assert.notEqual(DICTS.en[key], '', `en[${key}] must not be empty`)
  }
})

test('every dictionary key is namespaced, not a bare word', () => {
  for (const key of Object.keys(DICTS.zh)) assert.match(key, /^[a-z][a-zA-Z]*\.[a-zA-Z][a-zA-Z.-]*$/)
})

test('detectRenderedLocale follows the copy the bound t actually returns', () => {
  const zhT = (key) => translate(DICTS, 'zh', key)
  const enT = (key) => translate(DICTS, 'en', key)
  assert.equal(detectRenderedLocale(zhT, DICTS), 'zh')
  assert.equal(detectRenderedLocale(enT, DICTS), 'en')
  assert.equal(detectRenderedLocale((key) => key, DICTS), '')
  assert.equal(detectRenderedLocale(null, DICTS), '')
})

test('detectRenderedLocale drives the font stack after a language switch', () => {
  const enT = (key) => translate(DICTS, 'en', key)
  assert.equal(fontFamilyFor(detectRenderedLocale(enT, DICTS)), 'inherit')
  const zhT = (key) => translate(DICTS, 'zh', key)
  assert.match(fontFamilyFor(detectRenderedLocale(zhT, DICTS)), /YaHei/)
})

test('the popover copy covers every field SPEC 2.5 requires', () => {
  for (const key of ['popover.title', 'option.always', 'option.idleOnly', 'row.now', 'row.next', 'row.holiday']) {
    assert.equal(typeof DICTS.zh[key], 'string')
  }
  assert.equal(translate(DICTS, 'zh', 'option.always'), '全天运行')
  assert.equal(translate(DICTS, 'zh', 'option.idleOnly'), '仅空闲时段')
})
