/** Exercise the installed, patched AG callback, including the timer it leaves after an editor closes. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(dirname(createRequire(import.meta.url).resolve('ag-grid-react')), '../..')
const version = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version
if (version !== '36.1.0') throw new Error(`Recheck the AG editor attachment callback for ${version}; this regression proof pins 36.1.0.`)
interface Editor { name: string; isCancelBeforeStart?: () => boolean }

function harness(format: 'esm.mjs' | 'cjs.js') {
  const source = readFileSync(join(packageRoot, 'dist/package', `index.${format}`), 'utf8')
  const section = source.slice(source.indexOf('const setCellEditorRef ='))
  const callback = section.match(/\(cellEditor\) => \{[\s\S]*?\n    \}(?=,\n    \[cellCtrl\])/)
  if (!callback) throw new Error(`AG 36.1.0 ${format} setCellEditorRef changed; recheck its timer boundary.`)
  const calls: string[] = []
  const timers: Array<() => void> = []
  let alive = true
  const cellCtrl = {
    isAlive: () => alive,
    stopEditing: (cancel: boolean) => calls.push(`stop:${cancel}`),
    focusCell: (options: { forceBrowserFocus: boolean }) => calls.push(`focus:${options.forceBrowserFocus}`),
    enableEditorTooltipFeature: (editor: Editor) => calls.push(`tooltip:${editor.name}`),
  }
  const beans = { editSvc: { onEditorAttached: () => calls.push('attached') } }
  const ref: { current?: Editor } = {}
  const setRef = new Function('cellCtrl', 'beans', 'cellEditorRef', 'setTimeout', `return (${callback[0]})`)(
    cellCtrl, beans, ref, (run: () => void) => timers.push(run),
  ) as (editor: Editor | undefined) => void
  return { calls, setRef, destroyCell: () => { alive = false }, flush: () => { for (const run of timers.splice(0)) run() } }
}

for (const format of ['esm.mjs', 'cjs.js'] as const) describe(`AG editor attachment timer (${format})`, () => {
  it.each([false, true])('does not touch a destroyed grid or removed row (cancelled=%s)', cancelled => {
    const h = harness(format)
    h.setRef({ name: 'old', isCancelBeforeStart: () => cancelled })
    h.destroyCell()
    h.flush()
    expect(h.calls).toEqual([])
  })
  it('does not attach or validate an editor whose ref was cleared', () => {
    const h = harness(format)
    h.setRef({ name: 'old' })
    h.setRef(undefined)
    h.flush()
    expect(h.calls).toEqual([])
  })
  it.each([false, true])('leaves a replacement editor alone (old cancelled=%s)', cancelled => {
    const h = harness(format)
    h.setRef({ name: 'old', isCancelBeforeStart: () => cancelled })
    h.setRef({ name: 'new' })
    h.flush()
    expect(h.calls).toEqual(['attached', 'tooltip:new'])
  })
  it('attaches then enables validation for the live matching editor exactly once', () => {
    const h = harness(format)
    h.setRef({ name: 'active' })
    h.flush()
    expect(h.calls).toEqual(['attached', 'tooltip:active'])
  })
  it('keeps stop-then-focus order for a live editor that refuses to start', () => {
    const h = harness(format)
    h.setRef({ name: 'active', isCancelBeforeStart: () => true })
    h.flush()
    expect(h.calls).toEqual(['stop:true', 'focus:true'])
  })
})
