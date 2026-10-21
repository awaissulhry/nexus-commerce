/**
 * Step 39 — the write-rule files load in any order. meta-calls.ts loads every rules file; a rules file that took a value
 * from a module that was still loading threw "Cannot access 'META_NAME_TEXT' before initialization" (step 39) or
 * "Cannot access 'OPTIMIZATION_GOALS' before initialization" (main, when meta-settings-rules.ts loaded first: it took
 * META_VALIDATE_ONLY from meta-calls.ts). The text patterns live in the leaf meta-write-text.ts, META_VALIDATE_ONLY in the
 * leaf meta-write-check.ts, and no rules file takes a value from meta-calls.ts (only types).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const RULE_FILES = readdirSync(here).filter((f) => /^meta-[a-z-]+-rules\.ts$/.test(f)).sort()

type RuleLike = { name: string; method: string; path: RegExp; text?: Record<string, unknown> }
const isRule = (v: unknown): v is RuleLike => !!v && typeof v === 'object' && typeof (v as RuleLike).name === 'string'
  && typeof (v as RuleLike).method === 'string' && (v as RuleLike).path instanceof RegExp

/** Every write rule a module exports: its rule lists, and what its `…WriteRules()` functions answer. */
function rulesOf(mod: Record<string, unknown>): RuleLike[] {
  const out: RuleLike[] = []
  for (const [key, value] of Object.entries(mod)) {
    const list = typeof value === 'function' && /WriteRules$/.test(key) ? (value as () => unknown)() : value
    if (Array.isArray(list) && list.length && list.every(isRule)) out.push(...list)
  }
  return out
}

/** Each rule's text patterns are real patterns, never a value a half-loaded module left unset. */
const unsetText = (rules: RuleLike[]) => rules.flatMap((r) => Object.entries(r.text ?? {}).filter(([, p]) => !(p instanceof RegExp)).map(([k]) => `${r.name}.${k}`))

describe('Meta write rules: load order', () => {
  beforeEach(() => { vi.resetModules() })

  it('finds the rules files', () => {
    expect(RULE_FILES).toEqual(expect.arrayContaining(['meta-settings-rules.ts', 'meta-brand-safety-rules.ts', 'meta-webhook-rules.ts']))
  })

  it('no rules file takes a value from meta-calls.ts (only types)', () => {
    for (const file of RULE_FILES) {
      const source = readFileSync(join(here, file), 'utf8')
      const valueImports = source.split('\n').filter((l) => /from '\.\/meta-calls\.js'/.test(l) && !/^import type /.test(l))
      expect(valueImports, file).toEqual([])
    }
  })

  for (const first of RULE_FILES) {
    it(`loads ${first} first: every rules file then holds real rules and patterns`, async () => {
      await import(`./${first.replace(/\.ts$/, '.js')}`)
      const calls = await import('./meta-calls.js')
      expect(calls.metaWriteVerdict).toBeTypeOf('function')
      for (const file of RULE_FILES) {
        const mod = await import(`./${file.replace(/\.ts$/, '.js')}`) as Record<string, unknown>
        const rules = rulesOf(mod)
        expect(rules.length, file).toBeGreaterThan(0)
        expect(unsetText(rules), file).toEqual([])
      }
    })
  }

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
    expect(calls.metaWriteVerdict).toBeTypeOf('function')
    for (const file of RULE_FILES) {
      const rules = rulesOf(await import(`./${file.replace(/\.ts$/, '.js')}`) as Record<string, unknown>)
      expect(unsetText(rules), file).toEqual([])
    }
  })

  it('keeps one pattern and one check value: the leaves are the only home', async () => {
    const leaf = await import('./meta-write-text.js')
    const settings = await import('./meta-settings-rules.js')
    expect(settings.META_NAME_TEXT).toBe(leaf.META_NAME_TEXT)
    expect(settings.META_STRICT_TEXT).toBe(leaf.META_STRICT_TEXT)
    const check = await import('./meta-write-check.js')
    expect(check.META_VALIDATE_ONLY).toBe('["validate_only"]')
  })
})
