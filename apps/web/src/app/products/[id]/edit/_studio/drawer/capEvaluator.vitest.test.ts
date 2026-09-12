/**
 * PES.4 — the record field must not grow its own cap arithmetic (#382).
 *
 * `apps/web`'s vitest is node-only, so `RecordField` cannot be rendered here (see vitest.config.ts).
 * What CAN be pinned is the two things that made it wrong, and both are visible in the source:
 * it must not carry an HTML `maxLength` attribute, and it must feed BOTH caps to the shared reader.
 * A source guard is weaker than a render test and much stronger than nothing — this exact defect
 * shipped because a character-only cap looked complete at the call site.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { longTextState } from '@/design-system/grid/renderers/longTextState'

const FIELD = join(dirname(fileURLToPath(import.meta.url)), 'fields', 'RecordField.tsx')

/** Source with comments removed — a rule that matches its own doc block proves nothing (#93). */
function codeOf(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

describe('RecordField delegates its cap to the shared evaluator', () => {
  const code = codeOf(FIELD)

  it('the guard is reading real source, not an empty string', () => {
    expect(code.length).toBeGreaterThan(2000)
    expect(code).toContain('RecordField')
  })

  it('puts no HTML maxLength on the native input — it cannot express a byte cap', () => {
    // 🔴 The first version of this guard was `not.toMatch(/maxLength={/)` over the whole file, and
    // it went red the moment `maxLength` became a legitimate PROP on <HtmlField>. A prop named like
    // an attribute is not that attribute; the rule is about what reaches the DOM. So the HtmlField
    // element is excised and the remainder — the native <Input>/<textarea> path — is checked.
    const withoutHtmlField = code.replace(/<HtmlField[\s\S]*?\/>/g, '')
    expect(withoutHtmlField).not.toMatch(/maxLength=\{/)
    // And prove the excision did not simply eat the file.
    expect(withoutHtmlField).toMatch(/longTextState|evaluateLengthCaps/)
    expect(withoutHtmlField.length).toBeGreaterThan(2000)
  })

  it('feeds BOTH caps to the shared reader, not just the character one', () => {
    expect(code).toMatch(/longTextState|evaluateLengthCaps/)
    expect(code).toMatch(/maxLength:\s*column\.maxLength/)
    expect(code).toMatch(/maxBytes:\s*column\.maxBytes/)
  })

  it('derives "over" from the reading rather than comparing lengths itself', () => {
    expect(code).toMatch(/state === 'over'/)
    expect(code).not.toMatch(/draft\.length > cap/)
  })
})

describe('HtmlField carries the cap for rich-text columns', () => {
  const html = codeOf(join(dirname(fileURLToPath(import.meta.url)), 'fields', 'HtmlField.tsx'))
  const field = codeOf(FIELD)

  it('reads real source', () => {
    expect(html.length).toBeGreaterThan(2000)
  })

  it('uses a shared reader rather than its own character comparison', () => {
    // Named loosely on PURPOSE. #393: `longTextState` is due to delegate to PES.2's
    // `evaluateLengthCaps` when AG.1 adapts, and a guard pinned to today's symbol would go red for
    // a refactor that is exactly what was ruled. What must stay true is that this component does
    // not do its own cap arithmetic — assert that, not which shared function it happens to call.
    expect(html).toMatch(/longTextState|evaluateLengthCaps/)
    expect(html).not.toMatch(/textLength > maxLength/)
    expect(html).not.toMatch(/\.length > (maxLength|maxBytes)/)
  })

  it('the call site passes BOTH caps — it passed neither before', () => {
    // RecordField suppresses its own counter for `longtext` because HtmlField owns it, so a
    // missing prop here means a rich-text field shows no cap anywhere at all.
    expect(field).toMatch(/maxLength=\{column\.maxLength\}/)
    expect(field).toMatch(/maxBytes=\{column\.maxBytes\}/)
  })

  it('still suppresses the RecordField counter for longtext, so there is exactly one', () => {
    expect(field).toMatch(/kind !== 'longtext'/)
  })
})

describe('the reading the field now renders — why one unit could not have worked', () => {
  const caps = { maxLength: 1998, maxBytes: 2000 }

  it('catches the character-cap break that a bytes-only rule misses', () => {
    const r = longTextState('a'.repeat(1999), caps)
    expect(r.state).toBe('over')
    expect(r.unit).toBe('characters')
  })

  it('catches the byte-cap break that a characters-only rule misses', () => {
    const r = longTextState('é'.repeat(1001), caps)
    expect(r.state).toBe('over')
    expect(r.unit).toBe('bytes')
  })

  /**
   * 🔴 `undefined` is the LIVE shape; `null` is the defensive branch.
   *
   * The wire omits an uncapped unit — measured 2026-09-02 on 96 columns, `maxLength` absent
   * 60 / value 36 / **null 0**. These cases used to pass only `null`, which read as corroboration
   * that the server sends it. Both are asserted, and labelled, so the test documents the contract
   * instead of quietly inventing one.
   */
  it('a byte-only column is capped here — it used to be uncapped in the drawer (live: key absent)', () => {
    const r = longTextState('é'.repeat(11000), { maxBytes: 20000 })
    expect(r.state).toBe('over')
    expect(r.unit).toBe('bytes')
    expect(r.cap).toBe(20000)
  })

  it('…and the same when the key arrives as null (defensive branch, not observed on the wire)', () => {
    const r = longTextState('é'.repeat(11000), { maxLength: null, maxBytes: 20000 })
    expect(r.state).toBe('over')
    expect(r.cap).toBe(20000)
  })

  it('an uncapped column stays UNCHECKED — absence of a cap is not compliance with one (live)', () => {
    const r = longTextState('anything', {})
    expect(r.state).toBe('unchecked')
    expect(r.cap).toBeNull()
  })

  it('…and stays UNCHECKED when both keys arrive as null (defensive branch)', () => {
    const r = longTextState('anything', { maxLength: null, maxBytes: null })
    expect(r.state).toBe('unchecked')
    expect(r.cap).toBeNull()
  })
})


/* ── #426: the over-cap sentence names its source ──────────────────────────────────────────── */
import { overCapNote } from './format'

describe('overCapNote', () => {
  it('names the marketplace that imposed the cap', () => {
    expect(overCapNote('Amazon · DE')).toBe(' — over the Amazon · DE cap')
  })

  it('says the source is not stated rather than inventing "the channel"', () => {
    // 🔴 The old text was ' — over the channel cap', hardcoded on both surfaces. On a MASTER scope
    // there is no channel at all, so it asserted a source that did not exist.
    expect(overCapNote(null)).toBe(' — over the cap (source not stated)')
    expect(overCapNote(undefined)).toBe(' — over the cap (source not stated)')
    expect(overCapNote('')).toBe(' — over the cap (source not stated)')
  })

  it('never says "the channel cap" again', () => {
    for (const v of ['Amazon · DE', null, undefined, '']) {
      expect(overCapNote(v)).not.toContain('the channel cap')
    }
  })
})

describe('exactly one surface names the source (DS.1 ruling)', () => {
  const files = ['fields/HtmlField.tsx', 'fields/RecordField.tsx']
  for (const f of files) {
    it(`${f} stands the left span down while over`, () => {
      const src = codeOf(join(dirname(fileURLToPath(import.meta.url)), ...f.split('/')))
      // The span is gated on `!over`, so the source is never stated twice in one row.
      expect(src).toMatch(/!over && \w*[Rr]eading\.capFrom \? `cap from/)
      // And it reads the READING, not the column: both halves must name the same source.
      expect(src).not.toMatch(/column\.capFrom \? `cap from/)
    })
  }
})

describe('both drawer surfaces use it — neither keeps its own wording', () => {
  const files = ['fields/HtmlField.tsx', 'fields/RecordField.tsx']
  for (const f of files) {
    it(`${f} delegates the sentence`, () => {
      const src = codeOf(join(dirname(fileURLToPath(import.meta.url)), ...f.split('/')))
      expect(src).toContain('overCapNote')
      expect(src).not.toContain('over the channel cap')
    })
  }
})
