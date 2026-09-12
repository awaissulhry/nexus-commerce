'use client'

import { useId, useMemo, useRef, useState } from 'react'
import { Button, Input } from '../../primitives'
import { ListboxPanel, type ListboxOption } from '../../components'
import { FormulaGuidance, formulaSuggestions, useFormulaPreview } from './formulaAssistance'
import { exprOf, isFormulaDraft, type Applied, type FormulaCandidate } from './formulaEditing'
import { previewLine, functionHint, type FormulaFunctionDoc, type FormulaPreviewResponse } from './formulaPreview'
import { callAt, tokenizeForDisplay } from './formulaTokens'

export function FormulaComposer({ text, onChange, candidates, functions, preview, sourceLabel, disabled = false,
  allowText = true, onApply, onCancel, applyLabel = 'Apply', saveOnBlur = false, ariaLabel = 'Formula', linked = true, showModeHelp = true }: {
  text: string; onChange: (value: string) => void; candidates: readonly FormulaCandidate[]; functions: FormulaFunctionDoc[];
  preview: (expr: string, signal?: AbortSignal) => Promise<FormulaPreviewResponse>; sourceLabel?: string;
  disabled?: boolean; allowText?: boolean; onApply?: (text: string) => Promise<{ ok: boolean; error?: string }>;
  onCancel?: () => void; applyLabel?: string; saveOnBlur?: boolean; ariaLabel?: string; linked?: boolean; showModeHelp?: boolean
}) {
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [caret, setCaret] = useState(text.length)
  const [active, setActive] = useState(0)
  const [matches, setMatches] = useState<readonly ListboxOption[]>([])
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const busy = useRef(false)
  const lastSaved = useRef(text)
  const formula = isFormulaDraft(text)
  const expr = exprOf(text)
  const { response, inFlight, retry } = useFormulaPreview(expr, preview, formula)
  const line = previewLine({ expr, response, inFlight, lastGood: null })
  const suggestions = useMemo(() => formulaSuggestions(formula ? text : '', caret, candidates), [formula, text, caret, candidates])
  const completionKey = `${text}:${caret}`
  const [assisting, setAssisting] = useState(false)
  const open = !assisting && suggestions.options.length > 0 && dismissed !== completionKey
  const hint = functionHint(callAt(tokenizeForDisplay(expr), Math.max(0, caret - (text.length - expr.length))), functions)
  const change = (next: Applied) => {
    onChange(next.text); setCaret(next.caret); setError(null); setActive(0)
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(next.caret, next.caret) })
  }
  const choose = (value: string) => {
    const next = suggestions.choose(value)
    if (next) { change(next); setDismissed(`${next.text}:${next.caret}`) }
  }
  const save = async () => {
    if (!onApply || disabled || busy.current || (formula && !expr.trim()) || text === lastSaved.current) return
    busy.current = true; setSaving(true); setError(null)
    try {
      const result = await onApply(text)
      if (result.ok) lastSaved.current = text
      else { setError(result.error ?? 'Could not save this field.'); input.current?.focus() }
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save this field.') }
    finally { busy.current = false; setSaving(false) }
  }
  return <div ref={root} className="nds-formula-composer nds-readable" onBlur={event => {
    if (saveOnBlur && !root.current?.contains(event.relatedTarget as Node)) void save()
  }}>
    <Input ref={input} value={text} size="sm" autoFocus data-autofocus disabled={disabled || saving} spellCheck={false} autoComplete="off"
      className={formula ? 'nds-formula-input' : undefined}
      aria-label={ariaLabel} aria-describedby={`${id}-preview`} role={formula ? 'combobox' : undefined}
      aria-autocomplete={formula ? 'list' : undefined} aria-expanded={formula ? open : undefined}
      aria-controls={open ? `${id}-listbox` : undefined} aria-activedescendant={open && matches[active] ? `${id}-o${active}` : undefined}
      onSelect={event => setCaret(event.currentTarget.selectionStart ?? text.length)}
      onChange={event => { onChange(event.target.value); setCaret(event.target.selectionStart ?? event.target.value.length); setError(null); setActive(0) }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return
        if (open && !event.shiftKey && ['ArrowUp', 'ArrowDown', 'Tab'].includes(event.key)) {
          event.preventDefault()
          if (event.key === 'Tab') { const option = matches[active] ?? matches[0] ?? suggestions.options[0]; if (option) choose(option.value) }
          else setActive(value => Math.max(0, Math.min(matches.length - 1, value + (event.key === 'ArrowDown' ? 1 : -1))))
        } else if (event.key === 'Enter' && onApply) { event.preventDefault(); void save() }
        else if (event.key === 'Escape' && (open || onCancel)) {
          event.preventDefault(); event.stopPropagation()
          if (open) setDismissed(completionKey)
          else onCancel?.()
        }
      }} />
    {formula && <FormulaGuidance showModeHelp={showModeHelp} text={text} sourceLabel={response?.sourceLabel ?? sourceLabel} onInteractionChange={setAssisting} onChange={change} linked={linked} disabled={disabled || saving} allowText={allowText} />}
    {open && <ListboxPanel idPrefix={id} ariaLabel="Formula suggestions" options={suggestions.options} query={suggestions.token?.query ?? ''} autoFocus={false}
      activeIndex={active} onActiveIndexChange={setActive} onMatchesChange={setMatches} onCommit={choose} onCancel={() => setDismissed(completionKey)}
      className="nds-formula-pop" style={{ position: 'static', width: '100%', maxHeight: 168 }} />}
    {formula && hint && <div className="nds-formula-hint"><code>{hint.signature}</code><span>{hint.summary}</span></div>}
    <div id={`${id}-preview`} role="status" aria-live="polite" className={`nds-formula-preview${error || line.kind === 'error' ? ' bad' : ''}`}>
      {error ?? (!formula ? 'This replaces the formula with a value.' : line.kind === 'idle' ? 'Result will appear here' :
        line.kind === 'checking' ? 'Checking formula…' : line.kind === 'error' ? line.message : line.kind === 'empty' ? 'Result: empty' : `Result: ${line.value}`)}
    </div>
    {response?.retryable && <Button size="xs" disabled={disabled || saving} onClick={retry}>Retry preview</Button>}
    {onApply && <div className="nds-formula-actions"><span>Enter to apply</span>
      {onCancel && <Button size="sm" disabled={saving} onClick={onCancel}>Cancel</Button>}
      <Button size="sm" variant="primary" disabled={disabled || saving || (formula && !expr.trim())} onClick={() => void save()}>{saving ? 'Saving…' : applyLabel}</Button>
    </div>}
  </div>
}
