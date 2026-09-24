import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { EDITOR_KEY_HINT } from './editorHint'

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
    expect(editor).toMatch(/nds-formula-actions"><span className="nds-editor-keyhint">\{EDITOR_KEY_HINT\}<\/span>/)
  })

  it('the value editor carries no key wording of its own any more', () => {
    expect(src('FormulaCellEditor.tsx')).not.toMatch(/Enter to apply/)
  })
})
