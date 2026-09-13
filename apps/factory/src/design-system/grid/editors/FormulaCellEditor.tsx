'use client'

import { FormulaGuidance, formulaSuggestions, useFormulaPreview } from './formulaAssistance'

import { createElement, forwardRef, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import type { ICellEditorParams } from 'ag-grid-community'
import { useGridCellEditor } from 'ag-grid-react'
import { Button, Input, Textarea } from '../../primitives'
import { ListboxPanel, type ListboxOption } from '../../components'
import { editorBox, roomToRightOf } from './editorBox'
import {
  commitValue, completionToAccept,
  exprOf, formulaAvailability, formulaEditorChoice, insertFieldReference, isFormulaDraft, unknownRefs,
  type Applied, type CommitKind, type FormulaCandidate,
} from './formulaEditing'
import { assignRefColours, colourFor } from './formulaPalette'
import { errorMarkAt, functionHint, previewLine, unknownRefNames, type FormulaFunctionDoc, type FormulaPreviewResponse } from './formulaPreview'
import { callAt, refsOf, tokenizeForDisplay, type Token } from './formulaTokens'

export interface FormulaEditorParams extends ICellEditorParams {
  onValueChange?: (value: unknown) => void
  initialValue?: unknown
  candidates: FormulaCandidate[]
  preview: (expr: string, signal?: AbortSignal) => Promise<FormulaPreviewResponse>
  functions?: FormulaFunctionDoc[]
  formulaExpr?: string | null
  colIdOfRef?: (name: string) => string | null
  commitKind?: CommitKind
  multiline?: boolean
  /** Draft handed over by an already-open option or structured editor. */
  initialText?: string
  sourceLabel?: string
  replaceFormula?: (value: unknown) => Promise<{ ok: boolean; error?: string }>
}

export function FormulaGlyph({ title = 'Formula' }: { title?: string }) {
  return <span className="nds-cell-prov nds-cell-prov-formula nds-formula-glyph" aria-hidden title={title}>ƒ</span>
}

/** AG's popup keyboard handling runs before React's bubble handlers. */
export function suppressFormulaKeys({ event, editing }: { event: KeyboardEvent; editing: boolean }): boolean {
  if (!editing || !(event.target instanceof Element)) return false
  const editor = event.target.closest('.nds-formula-editor')
  if (!editor) return false
  return event.key === 'Enter' || event.key === 'Escape' ||
    (editor.getAttribute('data-completions') === 'true' && ['Tab', 'ArrowUp', 'ArrowDown'].includes(event.key))
}

export const FormulaCellEditor = forwardRef<unknown, FormulaEditorParams>(function FormulaCellEditor(props, _ref) {
  const { candidates, preview, functions = [], formulaExpr, colIdOfRef, commitKind = 'text', multiline = false,
    value, initialValue, eventKey, node, column, onValueChange } = props
  // AG's reactive value changes as we type. Neither the initial selection nor cancel may chase it.
  const initial = useRef(props.initialText ?? (eventKey?.length === 1 ? eventKey : formulaExpr ? `=${formulaExpr}` : value == null ? '' : String(value))).current
  const original = useRef(initialValue !== undefined ? initialValue : value).current
  const [text, setText] = useState(initial)
  const [caret, setCaret] = useState(initial.length)
  const touched = useRef(props.initialText !== undefined || eventKey?.length === 1)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const formula = isFormulaDraft(text)
  const expr = exprOf(text)
  const offset = text.length - expr.length
  const tokens = useMemo(() => formula ? tokenizeForDisplay(expr) : [], [formula, expr])
  const refColours = useMemo(() => assignRefColours(refsOf(tokens).map(t => t.value ?? '')), [tokens])
  const id = useId()
  const [pickMessage, setPickMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const editRevision = useRef(0)
  useEffect(() => () => { editRevision.current += 1 }, [])

  const report = useCallback((draft: string) => {
    if (isFormulaDraft(draft) && !exprOf(draft).trim()) onValueChange?.(original)
    else onValueChange?.(commitValue(draft, original == null ? '' : String(original), commitKind))
  }, [original, commitKind, onValueChange])
  const change = useCallback((next: Applied) => {
    touched.current = true
    editRevision.current += 1
    setSubmitting(false)
    setText(next.text)
    setCaret(next.caret)
    setPickMessage('')
    // updateValue is synchronous: even an immediate Enter reads the latest keystroke.
    report(next.text)
  }, [report])
  useEffect(() => { if (touched.current) report(initial) }, [])
  useGridCellEditor({ isCancelAfterEnd: () => !touched.current || (isFormulaDraft(text) && !exprOf(text).trim()) })

  const focusAt = useCallback((position: number) => {
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(position, position)
    })
  }, [])
  useLayoutEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus()
    if (!touched.current && !formula) input.select()
    else input.setSelectionRange(caret, caret)
  }, [formula])

  const { response, inFlight, setResponse, setInFlight, retry } = useFormulaPreview(expr, preview, formula)
  const line = previewLine({ expr, inFlight, response, lastGood: null })
  const errorAt = line.kind === 'error' ? errorMarkAt(line.pos, expr.length, offset) : null
  const unknown = useMemo(() => unknownRefNames(response?.unknownRefs,
    formula ? unknownRefs(expr, candidates.filter(c => c.kind === 'field').map(c => c.name)) : [], response !== null),
  [response, formula, expr, candidates])

  const suggestions = useMemo(() => formulaSuggestions(formula ? text : '', caret, candidates), [formula, text, caret, candidates])
  const { token, options } = suggestions
  const [dismissed, setDismissed] = useState<string | null>(null)
  const completionKey = `${text}:${caret}`
  const [assisting, setAssisting] = useState(false)
  const open = !assisting && options.length > 0 && dismissed !== completionKey
  const [active, setActive] = useState(0)
  const [matches, setMatches] = useState<readonly ListboxOption[]>([])
  useEffect(() => { setActive(0) }, [token?.query, token?.start])
  const applyChosen = useCallback((selected: string) => {
    const next = suggestions.choose(selected)
    if (!next) return
    change(next)
    setDismissed(`${next.text}:${next.caret}`)
    focusAt(next.caret)
  }, [suggestions, change, focusAt])

  // Capture before AG's outside-click handling can commit the draft or toggle a source-cell action.
  // References are row-relative fields; another product's value must never be inserted as this row.
  useEffect(() => {
    const root = props.eGridCell?.closest('.ag-root-wrapper')
    if (!formula || !colIdOfRef || !root) return
    const pick = (event: Event) => {
      if (event instanceof MouseEvent && event.button !== 0) return
      const cell = event.target instanceof Element ? event.target.closest<HTMLElement>('.ag-cell[col-id]') : null
      if (!cell || !root.contains(cell)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.type !== 'click') return
      if (cell.closest('.ag-row')?.getAttribute('row-id') !== node.id) {
        setPickMessage('Choose a field in this product row. Each row uses its own values.')
        return
      }
      const colId = cell.getAttribute('col-id')
      if (colId === column.getColId()) {
        setPickMessage('Choose a different field. A formula cannot refer to itself.')
        return
      }
      const candidate = candidates.find(c => c.kind === 'field' && colIdOfRef(c.name) === colId)
      if (!candidate) { setPickMessage('This cell is not a formula source. Choose a field from the suggestions.'); return }
      const input = inputRef.current
      const next = insertFieldReference(text, input?.selectionStart ?? caret, input?.selectionEnd ?? caret, candidate.name)
      if (!next) { setPickMessage('Move the cursor outside the quotes to insert a field.'); return }
      change(next)
      setDismissed(`${next.text}:${next.caret}`)
      focusAt(next.caret)
    }
    const events = ['pointerdown', 'mousedown', 'touchstart', 'click']
    events.forEach(name => document.addEventListener(name, pick, { capture: true, passive: false }))
    return () => events.forEach(name => document.removeEventListener(name, pick, true))
  }, [formula, colIdOfRef, props.eGridCell, node.id, column, candidates, text, caret, change, focusAt])

  useEffect(() => {
    const root = props.eGridCell?.closest('.ag-root-wrapper')
    if (!root || !formula || !colIdOfRef || node.id == null) return
    const painted: HTMLElement[] = []
    for (const [name, colour] of refColours) {
      if (unknown.has(name)) continue
      const colId = colIdOfRef(name)
      if (!colId) continue
      for (const cell of root.querySelectorAll<HTMLElement>(`.ag-row[row-id="${CSS.escape(node.id)}"] .ag-cell[col-id="${CSS.escape(colId)}"]`)) {
        cell.classList.add('nds-formula-ref-cell')
        cell.style.setProperty('--nds-formula-ref', colour.hex)
        painted.push(cell)
      }
    }
    return () => painted.forEach(cell => { cell.classList.remove('nds-formula-ref-cell'); cell.style.removeProperty('--nds-formula-ref') })
  }, [formula, colIdOfRef, refColours, unknown, node.id, props.eGridCell])

  const [metrics, setMetrics] = useState<React.CSSProperties | null>(null)
  useLayoutEffect(() => {
    const input = inputRef.current
    const wrap = input?.closest('.nds-formula-fieldwrap')
    if (!formula || !input || !wrap) { setMetrics(null); return }
    const measure = () => {
      const cs = getComputedStyle(input)
      const rect = input.getBoundingClientRect(), origin = wrap.getBoundingClientRect()
      // Computed `font` can be empty when ligatures are disabled; copy its individual values.
      setMetrics({ fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight, fontStyle: cs.fontStyle,
        lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing, left: rect.left - origin.left, top: rect.top - origin.top, width: rect.width,
        paddingLeft: parseFloat(cs.paddingLeft) || 0, paddingRight: parseFloat(cs.paddingRight) || 0, height: rect.height })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(input); observer.observe(wrap)
    return () => observer.disconnect()
  }, [formula, text])
  const syncScroll = () => { if (inputRef.current && overlayRef.current) overlayRef.current.scrollLeft = inputRef.current.scrollLeft }
  useLayoutEffect(syncScroll, [text, caret, metrics])

  const save = async () => {
    if (!touched.current || (formula && !expr.trim())) { props.api.stopEditing(true); return }
    if (submitting) return
    if (formula) {
      const revision = editRevision.current
      setSubmitting(true)
      try {
        const checked = await preview(expr)
        if (revision !== editRevision.current) return
        setResponse(checked)
        setInFlight(false)
        if (!checked.ok) { focusAt(caret); return }
      } catch {
        if (revision === editRevision.current) setResponse({ ok: false, error: 'Could not check the formula. Please try again.' })
        return
      } finally {
        if (revision === editRevision.current) setSubmitting(false)
      }
    }
    if (!formula && formulaExpr && props.replaceFormula) {
      const revision = editRevision.current
      setSubmitting(true)
      try {
        const removed = await props.replaceFormula(commitValue(text, original == null ? '' : String(original), commitKind))
        if (revision !== editRevision.current) return
        if (!removed.ok) { setPickMessage(removed.error ?? 'Could not replace this formula.'); return }
        props.api.stopEditing(true)
        return
      } catch {
        if (revision === editRevision.current) setPickMessage('Could not replace this formula. Please try again.')
        return
      } finally {
        if (revision === editRevision.current) setSubmitting(false)
      }
    }
    report(text)
    props.stopEditing()
  }
  const cancel = () => props.api.stopEditing(true)
  const keyboard = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.target !== inputRef.current) return
    if (open && ['ArrowDown', 'ArrowUp', 'Tab'].includes(e.key) && !e.shiftKey) {
      e.preventDefault(); e.stopPropagation()
      if (e.key === 'Tab') {
        const chosen = completionToAccept(matches, options, active)
        if (chosen) applyChosen(chosen.value)
      } else setActive(i => Math.max(0, Math.min(matches.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))))
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation(); cancel()
    } else if (e.key === 'Enter' && !(multiline && !formula && e.shiftKey)) {
      e.preventDefault(); e.stopPropagation(); save()
    }
  }
  const hint = functionHint(callAt(tokens, Math.max(0, caret - offset)), functions)
  const cellRect = props.eGridCell?.getBoundingClientRect()
  const box = editorBox({ cellWidth: cellRect?.width ?? column.getActualWidth(), cellHeight: cellRect?.height ?? 0,
    roomToRight: cellRect ? roomToRightOf(cellRect.left, window.innerWidth) : window.innerWidth,
    kind: multiline && !formula ? 'longtext' : 'formula' })
  const inputProps = {
    value: text, spellCheck: !formula, 'aria-label': formula ? 'Formula' : 'Cell value',
    'aria-describedby': `${id}-help ${id}-preview`,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => change({ text: e.target.value, caret: e.target.selectionStart ?? e.target.value.length }),
    onSelect: (e: React.SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>) => setCaret(e.currentTarget.selectionStart ?? 0),
  }
  return (
    <div className={`nds-formula-editor nds-readable${props.eGridCell?.closest('.dark') ? ' dark' : ''}`} data-completions={open} style={{ width: box.width, maxWidth: box.width }} onKeyDownCapture={keyboard}>
      <div className="nds-formula-body">
      <div className="nds-formula-fieldwrap">
        {formula && metrics && <div ref={overlayRef} className="nds-formula-overlay" aria-hidden style={{ ...metrics, fontVariantLigatures: 'none' }}>
          <span className="nds-formula-overlay-line">{renderTokens(text, expr, offset, tokens, refColours, unknown, errorAt)}</span>
        </div>}
        {multiline && !formula ? <Textarea {...inputProps} ref={el => { inputRef.current = el }} rows={6} /> :
          <Input {...inputProps} ref={el => { inputRef.current = el }} size="sm" autoComplete="off"
            role={formula ? 'combobox' : undefined} aria-autocomplete={formula ? 'list' : undefined}
            aria-expanded={formula ? open : undefined} aria-controls={open ? `${id}-listbox` : undefined}
            aria-activedescendant={open && matches[active] ? `${id}-o${active}` : undefined}
            className={formula ? `nds-formula-input${metrics ? ' highlighted' : ''}` : undefined}
            leadingIcon={formula ? <FormulaGlyph /> : undefined} onScroll={syncScroll} />}
      </div>
      <div id={`${id}-help`} className="nds-formula-help">
        {formula ? <>Click a field in this row, or start typing.</> :
          <>Start with <code>=</code> to calculate or combine fields.{multiline && ' Shift+Enter adds a line.'}</>}
      </div>
      {formula && <FormulaGuidance text={text} sourceLabel={response?.sourceLabel ?? props.sourceLabel} disabled={submitting} allowText={commitKind !== 'number'}
        onInteractionChange={setAssisting} onChange={next => { change(next); focusAt(next.caret) }} />}
      {open && <ListboxPanel ariaLabel="Formula suggestions" options={options} query={token?.query ?? ''} autoFocus={false} onCommit={applyChosen}
        onCancel={() => setDismissed(completionKey)} activeIndex={active} onActiveIndexChange={setActive}
        onMatchesChange={setMatches} idPrefix={id} className="nds-formula-pop"
        style={{ position: 'static', width: '100%', maxWidth: '100%', maxHeight: 168 }} />}
      {formula && hint && <div className="nds-formula-hint"><code>
        {hint.signature.slice(0, hint.signature.indexOf('(') + 1)}
        {hint.args.map((arg, i) => <span key={i} className={i === hint.argIndex ? 'on' : undefined}>{arg}{i < hint.args.length - 1 ? ', ' : ''}</span>)})
      </code><span className="nds-formula-hint-sum">{hint.summary}</span></div>}
      <div id={`${id}-preview`} role="status" aria-live="polite" aria-atomic="true">
        {!formula && pickMessage && <div className="nds-formula-preview bad">{pickMessage}</div>}
        {formula && <div className={`nds-formula-preview${line.kind === 'error' ? ' bad' : ''}`}>
          {pickMessage || (line.kind === 'idle' ? 'Result will appear here' :
            line.kind === 'checking' ? 'Checking formula…' : line.kind === 'error' ? line.message :
            line.kind === 'empty' ? 'Result: empty' : `Result: ${line.value}`)}
        </div>}
      </div>
      {response?.retryable && <Button size="xs" disabled={submitting} onClick={retry}>Retry preview</Button>}
      </div>
      <div className="nds-formula-actions"><span>Enter to apply</span>
        <Button size="sm" onClick={cancel}>Cancel</Button><Button size="sm" variant="primary" disabled={submitting || (formula && !expr.trim())} onClick={save}>{submitting ? 'Checking…' : 'Apply'}</Button>
      </div>
    </div>
  )
})
function renderTokens(
  text: string,
  expr: string,
  offset: number,
  tokens: readonly Token[],
  refColours: ReturnType<typeof assignRefColours>,
  unknown: ReadonlySet<string>,
  errorAt: number | null,
) {
  const out: React.ReactNode[] = []
  // The stripped prefix (`=`) is part of what the operator sees and is drawn plainly.
  if (offset > 0) out.push(<span key="eq" className="nds-fx-eq">{text.slice(0, offset)}</span>)
  tokens.forEach((t, i) => {
    const body = expr.slice(t.start, t.end)
    if (t.kind === 'ref') {
      const name = (t.value ?? '').toLowerCase()
      const bad = unknown.has(name)
      const colour = bad ? null : colourFor(name, refColours)
      out.push(
        <span
          key={i}
          className={bad ? 'nds-fx-ref bad' : 'nds-fx-ref'}
          style={colour ? { color: `color-mix(in srgb, var(--nds-text) 70%, ${colour.hex})`, textDecoration: `underline ${colour.hex}`, textUnderlineOffset: 3 } : undefined}
        >
          {body}
        </span>,
      )
      return
    }
    out.push(<span key={i} className={`nds-fx-${t.kind}`}>{body}</span>)
  })
  if (errorAt !== null) {
    // A caret-position mark under the offending character, drawn after the text so it composites
    // over it rather than displacing anything.
    out.push(<span key="mark" className="nds-fx-errmark" style={{ left: `${errorAt}ch` }} aria-hidden />)
  }
  return out
}

export interface FormulaWiring<TRow> {
  replaceFormula?: (rowId: string, fieldKey: string, value: unknown) => Promise<{ ok: boolean; error?: string }>
  unavailableReason?: () => string | null
  retry?: () => void
  sourceLabel?: (fieldKey?: string) => string
  canEditRow?: (row: TRow) => boolean
  candidatesFor: (row: TRow, fieldKey?: string) => FormulaCandidate[]
  preview: (rowId: string, fieldKey: string, expr: string, signal?: AbortSignal) => Promise<FormulaPreviewResponse>
  functions: () => FormulaFunctionDoc[]
  exprFor: (rowId: string, fieldKey: string) => string | null
  /**
   * #780 — the SERVER'S reason this cell's formula produced nothing, or `null`. Read through the
   * same ref-backed wiring as `exprFor`, so a refusal landing after first paint repaints the mark
   * without rebuilding a hundred column definitions.
   */
  errorFor?: (rowId: string, fieldKey: string) => string | null
  colIdOfRef: (name: string, fieldKey?: string) => string | null
}


type FallbackEditor = { component: unknown; params?: Record<string, unknown>; popup?: boolean }

/** Keeps option/list/measure controls, and promotes a typed or pasted = without ending the edit. */
function FormulaAwareEditor(props: FormulaEditorParams & { fallback: FallbackEditor }) {
  const [draft, setDraft] = useState<string | null>(null)
  if (draft !== null) return <FormulaCellEditor {...props} initialText={draft} />
  return <div className={props.eGridCell?.closest('.dark') ? 'dark' : undefined} onChangeCapture={e => {
    const target = e.target
    if ((target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && isFormulaDraft(target.value)) {
      e.stopPropagation()
      setDraft(target.value)
    }
  }} onKeyDownCapture={e => {
    if (e.key === '=' && !e.nativeEvent.isComposing) {
      e.preventDefault(); e.stopPropagation(); setDraft('=')
    }
  }}>{createElement(props.fallback.component as ComponentType<any>, { ...props, ...props.fallback.params })}</div>
}

export function formulaCellEditorSelector<TRow>(
  wiring: FormulaWiring<TRow>,
  col: { key: string; kind?: string; formulaWritable?: boolean },
  fallback: FallbackEditor | ((row: TRow | undefined) => FallbackEditor),
  rowIdOf: (row: TRow) => string,
) {
  return {
    cellEditorSelector: (p: { data?: TRow; eventKey?: string | null }) => {
      const unavailable = wiring.unavailableReason?.()
      if (unavailable) return { component: FormulaUnavailableEditor, popup: true, params: { message: unavailable, retry: wiring.retry } }
      const stored = p.data ? wiring.exprFor(rowIdOf(p.data), col.key) : null
      const rowWritable = p.data ? wiring.canEditRow?.(p.data) : undefined
      const editor = typeof fallback === 'function' ? fallback(p.data) : fallback
      const available = rowWritable !== false && formulaAvailability({ formulaWritable: col.formulaWritable, hasStoredFormula: !!stored }).kind === 'available'
      const choice = formulaEditorChoice({ eventKey: p.eventKey, storedExpr: stored, formulaWritable: col.formulaWritable, rowWritable })
      if (!available) return editor
      const scalar = typeof editor.component === 'string' && ['agTextCellEditor', 'agLargeTextCellEditor', 'agNumberCellEditor'].includes(editor.component)
      return {
        component: choice.use === 'formula' || scalar ? FormulaCellEditor : FormulaAwareEditor,
        popup: true,
        params: {
          fallback: editor,
          candidates: p.data ? wiring.candidatesFor(p.data, col.key).filter(c => c.kind !== 'field' || (wiring.colIdOfRef(c.name, col.key) ?? c.name).toLowerCase() !== col.key.toLowerCase()) : [],
          sourceLabel: wiring.sourceLabel?.(col.key),
          functions: wiring.functions(), formulaExpr: stored, colIdOfRef: (name: string) => wiring.colIdOfRef(name, col.key),
          replaceFormula: stored && p.data && wiring.replaceFormula ? (value: unknown) => wiring.replaceFormula!(rowIdOf(p.data!), col.key, value) : undefined,
          multiline: editor.component === 'agLargeTextCellEditor',
          commitKind: col.kind === 'number' ? ('number' as const) : ('text' as const),
          preview: (expr: string, signal?: AbortSignal) => wiring.preview(p.data ? rowIdOf(p.data) : '', col.key, expr, signal),
        },
      }
    },
  }
}

function FormulaUnavailableEditor(props: { message: string; retry?: () => void; api: { stopEditing: (cancel?: boolean) => void } }) {
  useGridCellEditor({ isCancelAfterEnd: () => true })
  return <div className="nds-formula-editor"><p role="status">{props.message}</p>
    <Button size="sm" onClick={() => { props.retry?.(); props.api.stopEditing(true) }}>Retry</Button>
    <Button size="sm" onClick={() => props.api.stopEditing(true)}>Close</Button></div>
}
