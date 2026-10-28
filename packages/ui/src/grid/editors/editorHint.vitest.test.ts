import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { EDITOR_KEY_HINT, EDITOR_KEY_HINT_FORM } from './editorHint'

/*
 * R-48 (2026-09-23) — ONE key line. The value editor (text and number, A-42 step 1) must render the constant and no
 * wording of its own. Read from the SOURCE, because apps/web vitest is node-only and cannot render the editor — with a
 * positive control that the reader finds the constant's import where it is used.
 */
const src = (file: string) => readFileSync(join(__dirname, file), 'utf8')

describe('EDITOR_KEY_HINT — the one key line (R-48)', () => {
  it('states the three keys and nothing else', () => {
    expect(EDITOR_KEY_HINT).toBe('Enter saves · Tab saves and moves right · Esc cancels')
  })

  it('the value editor renders the constant (positive control: the reader finds it)', () => {
    const editor = src('FormulaCellEditor.tsx')
    expect(editor).toMatch(/import \{ EDITOR_KEY_HINT \} from '\.\/editorHint'/)
    // Option A (2026-09-26): the key line leads the editor's foot, alone in its span — nothing appended to it (a field's
    // own facts, like long text's Shift+Enter, sit on their own line).
    expect(editor).toMatch(/nds-formula-foot">\s*<span id=\{`\$\{id\}-keys`\} className="nds-editor-keyhint">\{EDITOR_KEY_HINT\}<\/span>/)
  })

  it('the value editor offers no Cancel / Apply buttons any more (Option A: Enter saves, Esc cancels)', () => {
    const editor = src('FormulaCellEditor.tsx')
    expect(editor).not.toMatch(/>Apply</)
    expect(editor).not.toMatch(/onClick=\{cancel\}>Cancel/)
  })

  it('the value editor carries no key wording of its own any more', () => {
    expect(src('FormulaCellEditor.tsx')).not.toMatch(/Enter to apply/)
  })
})

/*
 * R-55 (2026-09-23) — the bullets editor's line is the ONE stated exception: Tab moves between bullets there. Enter and Esc
 * must read exactly as the one line does, so the two lines differ in the Tab part only.
 */
describe('EDITOR_KEY_HINT_FORM — the bullets editor\'s line (R-55)', () => {
  const parts = (line: string) => line.split(' · ')
  it('says Tab moves to the next bullet, then right', () => {
    expect(EDITOR_KEY_HINT_FORM).toBe('Enter saves · Tab next bullet, then moves right · Esc cancels')
  })
  it('shares the Enter and Esc parts with EDITOR_KEY_HINT exactly, and differs only in the Tab part', () => {
    const one = parts(EDITOR_KEY_HINT), form = parts(EDITOR_KEY_HINT_FORM)
    expect(form).toHaveLength(3)
    expect(one).toHaveLength(3)
    expect(form[0]).toBe(one[0])
    expect(form[2]).toBe(one[2])
    expect(form[1]).not.toBe(one[1])
    expect(form[1].startsWith('Tab ')).toBe(true)
  })
  it('the bullets editor renders this constant in the key-hint class (positive control: the reader finds it)', () => {
    const editor = src('SlotListEditor.tsx')
    expect(editor).toMatch(/import \{ EDITOR_KEY_HINT_FORM \} from '\.\/editorHint'/)
    expect(editor).toMatch(/<span className="nds-editor-keyhint">\{EDITOR_KEY_HINT_FORM\}<\/span>/)
  })
})
