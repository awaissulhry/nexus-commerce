'use client'

import { useEffect, useState } from 'react'
import { Button, Input } from '../../primitives'
import { applyCompletion, completionTokenAt, completionsFor, exprOf, type Applied, type FormulaCandidate } from './formulaEditing'
import type { FormulaPreviewResponse } from './formulaPreview'

export function useFormulaPreview(expr: string, preview: (expr: string, signal?: AbortSignal) => Promise<FormulaPreviewResponse>, enabled = true) {
  const [response, setResponse] = useState<FormulaPreviewResponse | null>(null)
  const [inFlight, setInFlight] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setResponse(null)
    setInFlight(enabled && !!expr.trim())
    if (!enabled || !expr.trim()) return () => controller.abort()
    const timer = setTimeout(() => {
      preview(expr, controller.signal).then(result => {
        if (!controller.signal.aborted) { setResponse(result); setInFlight(false) }
      }).catch(() => {
        if (!controller.signal.aborted) { setResponse({ ok: false, error: 'Could not check the formula. Please try again.', retryable: true }); setInFlight(false) }
      })
    }, 180)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [expr, preview, enabled, attempt])
  return { response, inFlight, setResponse, setInFlight, retry: () => setAttempt(n => n + 1) }
}

export function formulaSuggestions(text: string, caret: number, candidates: readonly FormulaCandidate[]) {
  const token = completionTokenAt(text, caret)
  const fieldsOnly = token && text[token.start] === '$'
  const options = !token ? [] : completionsFor(token.query, candidates.filter(c => !fieldsOnly || c.kind === 'field')).map(c => ({
    value: `${c.kind}:${c.name}`, label: c.label ?? c.name,
    searchText: `${c.label ?? c.name} ${c.kind === 'field' ? '$' : ''}${c.name}`,
    title: [c.kind === 'field' ? `$${c.name}` : c.label, c.value].filter(Boolean).join(' · '), group: c.kind === 'function' ? 'Functions' : 'Fields in this row',
    trailing: c.kind === 'field' && c.value ? c.value : undefined,
  }))
  const choose = (value: string) => {
    const candidate = candidates.find(c => `${c.kind}:${c.name}` === value)
    return token && candidate ? applyCompletion(text, token, candidate) : null
  }
  return { token, options, choose }
}

export function appendFormulaPart(text: string, part: string): Applied {
  const expr = exprOf(text).trimEnd()
  const join = expr && !/[(&,+\-*/=<>!%^]$/.test(expr) ? ' & ' : ''
  const next = `=${expr}${join}${part}`
  return { text: next, caret: next.length }
}

/** Shared text-building affordances for the sheet, record drawer, and bulk preview. */
export function FormulaGuidance({ text, sourceLabel, onChange, disabled = false, allowText = true, linked = true, showModeHelp = true, onInteractionChange }: {
  text: string; sourceLabel?: string; onChange: (next: Applied) => void; disabled?: boolean; allowText?: boolean; linked?: boolean; showModeHelp?: boolean; onInteractionChange?: (active: boolean) => void
}) {
  const [panel, setPanel] = useState<'text' | 'help' | null>(null)
  const show = (next: typeof panel) => { setPanel(next); onInteractionChange?.(next !== null) }
  const [literal, setLiteral] = useState('')
  const add = () => { onChange(appendFormulaPart(text, JSON.stringify(literal))); setLiteral(''); show(null) }
  return <div className="nds-formula-guidance">
    <div className="nds-formula-tools">
      <Button size="sm" variant="quiet" disabled={disabled} onClick={() => { show(null); onChange(appendFormulaPart(text, '$')) }}>Insert field</Button>
      {allowText && <Button size="sm" variant="quiet" disabled={disabled} aria-expanded={panel === 'text'} onClick={() => show(panel === 'text' ? null : 'text')}>Add text</Button>}
      <Button size="sm" variant="quiet" disabled={disabled} aria-expanded={panel === 'help'} onClick={() => show(panel === 'help' ? null : 'help')}>Help</Button>
    </div>
    {panel === 'help' && <div className="nds-formula-help-panel">
      <span>Use fields from this product row{sourceLabel ? ` · ${sourceLabel}` : ''}.</span>
      {showModeHelp && <span>{linked ? 'The result updates when source fields change.' : 'Calculates once and stores the result as a value.'}</span>}
      <span>Join text with <code>&amp;</code>. Compare exact values with <code>===</code>.</span>
      <code>=$brand &amp; " Jacket"</code>
      <span>Use ↑ ↓ to choose a suggestion, then Tab to insert it.</span>
    </div>}
    {panel === 'text' && <div className="nds-formula-tools nds-formula-text-builder">
      <Input size="sm" autoFocus aria-label="Text to add" placeholder="Text to append…" value={literal} disabled={disabled}
        onChange={event => setLiteral(event.target.value)} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); add() }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); show(null); onChange({ text, caret: text.length }) }
        }} />
      <Button size="sm" disabled={disabled || !literal.length} onClick={add}>Insert text</Button>
    </div>}
  </div>
}
