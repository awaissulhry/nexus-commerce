'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { languageColumn } from '../../sheet/languages'
import { FormulaComposer } from '@/design-system/grid/editors/FormulaComposer'
import { exprOf, isFormulaDraft, type FormulaCandidate } from '@/design-system/grid'
import type { DrawerFormulas, SheetColumn } from '../types'
import { usePublicationSave, useStudioScope } from '../../contracts'

export interface FormulaFieldProps {
  column: SheetColumn
  /** The record this field belongs to — `SheetRow.id`, the id the formula store keys on. */
  rowId: string
  formulas: DrawerFormulas
  /** The expression already stored on this cell, or null when the operator is starting one. */
  storedExpr: string | null
  /** What a `$reference` may name on THIS row, with the value it currently holds. Built once per record. */
  candidates: readonly FormulaCandidate[]
  /** The text the field held when formula mode began — restored on Escape. */
  originalText: string
  /** The keystrokes that opened formula mode. Equal to `originalText` when opened from the toolbar. */
  initialText?: string
  disabled?: boolean
  ariaLabel: string
  /**
   * Leave formula mode without saving: Escape, or clearing the leading `=`. The argument is the
   * text to hand back to the ordinary control, so deleting the `=` leaves what was typed after it
   * rather than silently discarding it.
   */
  onExit: (text: string) => void
  /** A formula was stored. The host refetches — the VALUE this produced is the server's to report. */
  onSaved?: () => void
}

export function FormulaField({ column, rowId, formulas, storedExpr, candidates, originalText, initialText = originalText, disabled, ariaLabel, onExit, onSaved }: FormulaFieldProps) {
  const baseline = storedExpr ? `=${storedExpr}` : originalText
  const startingText = storedExpr ? baseline : initialText
  const [text, setText] = useState(startingText)
  const pending = useRef(startingText !== baseline)
  const { registerPublicationBarrier } = usePublicationSave()
  const { registerScopeChangeGuard } = useStudioScope()
  useEffect(() => {
    const unregisterPublication = registerPublicationBarrier({
      flush: async () => {},
      blocker: () => pending.current ? 'Apply or cancel the formula before publishing.' : null,
    })
    const unregisterScope = registerScopeChangeGuard(() => !pending.current)
    return () => { unregisterPublication(); unregisterScope() }
  }, [registerPublicationBarrier, registerScopeChangeGuard])
  const change = useCallback((next: string) => {
    pending.current = next !== baseline
    setText(next)
  }, [baseline])
  const preview = useCallback((expr: string, signal?: AbortSignal) => formulas.preview(rowId, column.key, expr, signal), [formulas.preview, rowId, column.key])
  return <FormulaComposer text={text} onChange={change} candidates={candidates.filter(c => c.kind !== 'field' || c.name !== languageColumn(column.key).fieldKey)}
    functions={formulas.functions} preview={preview} sourceLabel={formulas.sourceLabelFor?.(column.key) ?? formulas.sourceLabel} disabled={disabled || formulas.ready === false}
    allowText={column.kind !== 'number'} ariaLabel={`${ariaLabel} — formula`} saveOnBlur
    onCancel={() => { pending.current = false; setText(baseline); onExit(originalText) }}
    onApply={async draft => {
      const result = isFormulaDraft(draft) ? await formulas.save(rowId, column.key, exprOf(draft)) :
        formulas.replace ? await formulas.replace(rowId, column.key, draft) : { ok: false, error: 'Remove the formula before entering a value.' }
      if (result.ok) { pending.current = false; onSaved?.() }
      return result
    }} />
}
