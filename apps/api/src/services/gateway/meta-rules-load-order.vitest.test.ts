/**
 * Step 39 — the write-rule files load in any order. meta-calls.ts loads every rules file; a rules file that took a value
 * from meta-settings-rules.ts (which imports meta-calls.ts) threw "Cannot access 'META_NAME_TEXT' before initialization"
 * when meta-settings-rules.ts was loaded first. The text patterns now live in the leaf module meta-write-text.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('Meta write rules: load order', () => {
  beforeEach(() => { vi.resetModules() })

  it('loads meta-settings-rules.ts first', async () => {
    const settings = await import('./meta-settings-rules.js')
    expect(settings.META_SETTINGS_WRITE_RULES.length).toBeGreaterThan(0)
    expect(settings.META_NAME_TEXT.test('Shop A')).toBe(true)
    // The rules files meta-calls.ts loaded on the way hold real patterns, not an unset value.
    const safety = await import('./meta-brand-safety-rules.js')
    const named = safety.META_BRAND_SAFETY_WRITE_RULES.filter((r) => r.text && 'name' in r.text)
    expect(named.length).toBeGreaterThan(0)
    expect(named.every((r) => (r.text as Record<string, unknown>).name instanceof RegExp)).toBe(true)
  })

  it('loads meta-brand-safety-rules.ts first', async () => {
    const safety = await import('./meta-brand-safety-rules.js')
    expect(safety.META_BRAND_SAFETY_WRITE_RULES.length).toBeGreaterThan(0)
  })

  it('loads meta-settings-rules.ts first: the lead-form rules hold real patterns (step 36)', async () => {
    await import('./meta-settings-rules.js')
    const forms = await import('./meta-lead-form-rules.js')
    const texts = forms.META_LEAD_FORM_WRITE_RULES.flatMap((r) => Object.values(r.text ?? {}))
    expect(texts.length).toBeGreaterThan(0)
    expect(texts.every((p) => p instanceof RegExp)).toBe(true)
  })

  it('loads meta-lead-form-rules.ts first (step 36)', async () => {
    const forms = await import('./meta-lead-form-rules.js')
    expect(forms.META_LEAD_FORM_WRITE_RULES.length).toBeGreaterThan(0)
  })

  it('loads meta-settings-rules.ts first: the comment rules hold real patterns (step 37)', async () => {
    await import('./meta-settings-rules.js')
    const comments = await import('./meta-comment-rules.js')
    const texts = comments.META_COMMENT_WRITE_RULES.flatMap((r) => Object.values(r.text ?? {}))
    expect(texts.length).toBeGreaterThan(0)
    expect(texts.every((p) => p instanceof RegExp)).toBe(true)
  })

  it('loads meta-comment-rules.ts first (step 37)', async () => {
    const comments = await import('./meta-comment-rules.js')
    expect(comments.META_COMMENT_WRITE_RULES.length).toBeGreaterThan(0)
    expect(comments.META_COMMENT_TEXT.test('Grazie!\nA presto')).toBe(true)
  })

  it('loads meta-calls.ts first, and every rule is in writeRules', async () => {
    const calls = await import('./meta-calls.js')
    const settings = await import('./meta-settings-rules.js')
    const safety = await import('./meta-brand-safety-rules.js')
    expect(calls.metaWriteVerdict).toBeTypeOf('function')
    expect(settings.META_SETTINGS_WRITE_RULES.every((r) => r.text === undefined || Object.values(r.text).every((p) => p instanceof RegExp))).toBe(true)
    expect(safety.META_BRAND_SAFETY_WRITE_RULES.every((r) => r.text === undefined || Object.values(r.text).every((p) => p instanceof RegExp))).toBe(true)
  })

  it('keeps one pattern: meta-settings-rules.ts re-exports the leaf module', async () => {
    const leaf = await import('./meta-write-text.js')
    const settings = await import('./meta-settings-rules.js')
    expect(settings.META_NAME_TEXT).toBe(leaf.META_NAME_TEXT)
    expect(settings.META_STRICT_TEXT).toBe(leaf.META_STRICT_TEXT)
  })
})
