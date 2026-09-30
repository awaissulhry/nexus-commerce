'use client'

import { FormulaGuidance, formulaSuggestions, useFormulaPreview } from './formulaAssistance'

import { createElement, forwardRef, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import type { ICellEditorParams } from 'ag-grid-community'
import { useGridCellEditor } from 'ag-grid-react'
import { History, Link2, Sparkles } from 'lucide-react'
import { Button, Input, Textarea, ToolbarButton, TooltipPortalProvider } from '../../primitives'
import { ListboxPanel, type ListboxOption } from '../../components'
import { editorBox, roomToRightOf } from './editorBox'
import {
  coerceTyped, commitValue, completionToAccept,
  exprOf, formulaAvailability, formulaEditorChoice, insertFieldReference, isFormulaDraft, unknownRefs,
  type Applied, type CommitKind, type FormulaCandidate,
} from './formulaEditing'
import { EDITOR_KEY_HINT } from './editorHint'
import { acceptNumberEdit, NUMBER_ONLY_MESSAGE, numberCommitText, numberStart } from './numberEntry'
import { assignRefColours, colourFor } from './formulaPalette'
import { errorMarkAt, functionHint, previewLine, unknownRefNames, type FormulaFunctionDoc, type FormulaPreviewResponse } from './formulaPreview'
import { callAt, refsOf, tokenizeForDisplay, type Token } from './formulaTokens'

/**
 * 2026-09-26 (Owner: cell editor OPTION A) — what a cell carries besides its value. Each part shows an icon in the editor
 * only when it is present, so an ordinary cell opens as one clean line.
 */
export interface CellEditorContext {
  /** An AI draft waiting for this cell. `accept` / `reject` are the review's own verbs (they write through the drafts API). */
  aiDraft?: { value: string; accept: () => Promise<unknown>; reject: () => Promise<unknown> } | null
  /** Earlier values, read when the operator opens the list. Picking one fills the field; Enter saves it as usual. */
  history?: () => Promise<CellHistoryEntry[]>
  /** The row shows another row's value (a child following its parent). Typing gives this row its own value. */
  inherited?: { from: string; value: string } | null
  /** The channel's length cap. The counter turns red past it; nothing is ever truncated. */
  maxLength?: number | null
}

export interface CellHistoryEntry { value: string; when: string; who?: string | null }

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
  /**
   * R-63 — `false` makes this the plain VALUE editor with formulas OFF: `=` is text, no preview, no suggestions. It is
   * the ONE text/number editor wherever no formula is available (a sheet built without formula wiring — the Variants
   * page — or a column/row the formula writer refuses), so text and number open the same editor on every surface.
   */
  formulas?: boolean
  /** Option A — the selector opened this editor `under` its cell, so the cell keeps painting its saved value. */
  openedUnder?: boolean
  /** Option A — the cell's AI draft, history, inheritance and length cap (`CellEditorContext`). */
  cellContext?: CellEditorContext | null
}

export function FormulaGlyph({ title = 'Formula' }: { title?: string }) {
  return <span className="nds-cell-prov nds-cell-prov-formula nds-formula-glyph" aria-hidden title={title}>ƒ</span>
}

/**
 * AG's popup keyboard handling runs before React's bubble handlers. Enter and Esc are always the editor's; Tab and the
 * arrows are its own while completions are open; and Tab is also its own on a FORMULA (Option A, 2026-09-26), so a broken
 * formula is refused the same way Enter refuses it instead of being committed by AG and failing on the cell.
 */
export function suppressFormulaKeys({ event, editing }: { event: KeyboardEvent; editing: boolean }): boolean {
  if (!editing || !(event.target instanceof Element)) return false
  const editor = event.target.closest('.nds-formula-editor')
  if (!editor) return false
  return event.key === 'Enter' || event.key === 'Escape' ||
    (editor.getAttribute('data-completions') === 'true' && ['Tab', 'ArrowUp', 'ArrowDown'].includes(event.key)) ||
    (editor.getAttribute('data-formula') === 'true' && event.key === 'Tab')
}

/** The class that tells `grid.css` this cell's editor sits UNDER it, so its value stays painted (#769 is for `over`). */
export const CELL_EDITING_UNDER_CLASS = 'nds-cell-editing-under'

type ContextPanel = 'ai' | 'history' | 'parent' | null

/**
 * THE ONE TEXT/NUMBER CELL EDITOR (R-63), laid out as the Owner's OPTION A (2026-09-26, previewed in
 * `/design/grid-lab` and approved):
 *   - it opens UNDER the cell (`formulaCellEditorSelector` → `popupPosition: 'under'`), so the cell and the rest of the row
 *     stay in view — the row is what a formula refers to;
 *   - one compact line and no Cancel / Apply: Enter saves, Esc cancels, and the one key line stays (R-48);
 *   - `=` expands the formula help below the line: suggestions (every function and this row's fields), the signature, a
 *     live result, error marks, Insert field / Add text / Help, and click-a-cell to insert;
 *   - context icons only when they apply: an AI draft (use / dismiss), history, "follows the parent";
 *   - long text opens a taller box with a character counter, red past the channel's cap and never truncated;
 *   - Enter or Tab on a formula with an error says "Not saved" and keeps the draft — a broken formula is never written.
 * The state, keys, preview, suggestions, pick-a-cell and reference outlines are unchanged from the editor it replaces.
 */
export const FormulaCellEditor = forwardRef<unknown, FormulaEditorParams>(function FormulaCellEditor(props, _ref) {
  const { candidates, preview, functions = [], formulaExpr, colIdOfRef, commitKind = 'text', multiline = false,
    value, initialValue, eventKey, node, column, onValueChange } = props
  const context = props.cellContext ?? {}
  const formulasOn = props.formulas !== false
  // AG's reactive value changes as we type. Neither the initial selection nor cancel may chase it.
  /* R-47 — a NUMBER cell opens through `numberStart`: a start key that cannot begin a number is refused and the stored
     value is kept (untouched, so it never writes). Every other kind keeps "typing replaces". */
  const start = useRef((() => {
    const stored = formulaExpr ? `=${formulaExpr}` : value == null ? '' : String(value)
    if (props.initialText !== undefined) return { text: props.initialText, touched: true, refused: false }
    if (commitKind === 'number') return numberStart({ eventKey, stored, allowFormula: formulasOn })
    return eventKey?.length === 1 ? { text: eventKey, touched: true, refused: false } : { text: stored, touched: false, refused: false }
  })()).current
  const initial = start.text
  const original = useRef(initialValue !== undefined ? initialValue : value).current
  const [text, setText] = useState(initial)
  const [caret, setCaret] = useState(initial.length)
  const textRef = useRef(initial)
  const touched = useRef(start.touched)
  const [numberMessage, setNumberMessage] = useState(start.refused ? NUMBER_ONLY_MESSAGE : '')
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const formula = formulasOn && isFormulaDraft(text)
  const expr = exprOf(text)
  const offset = text.length - expr.length
  const tokens = useMemo(() => formula ? tokenizeForDisplay(expr) : [], [formula, expr])
  const refColours = useMemo(() => assignRefColours(refsOf(tokens).map(t => t.value ?? '')), [tokens])
  const id = useId()
  const [pickMessage, setPickMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  /** Enter / Tab was pressed on a formula with an error: say plainly that nothing was saved, until the next edit. */
  const [refused, setRefused] = useState(false)
  const [panel, setPanel] = useState<ContextPanel>(null)
  const [history, setHistory] = useState<{ state: 'idle' | 'loading' | 'ready' | 'error'; entries: CellHistoryEntry[] }>({ state: 'idle', entries: [] })
  const [draftBusy, setDraftBusy] = useState(false)
  const editRevision = useRef(0)
  useEffect(() => () => { editRevision.current += 1 }, [])

  /* Option A — an editor that sits UNDER its cell leaves the cell's saved value painted (grid.css keys #769's hide on
     this class). Only when the selector opened it under: an `=` typed into an option editor stays in that editor's
     `over` popup, which still covers the cell. */
  useEffect(() => {
    const cell = props.eGridCell
    if (!props.openedUnder || !cell) return
    cell.classList.add(CELL_EDITING_UNDER_CLASS)
    return () => cell.classList.remove(CELL_EDITING_UNDER_CLASS)
  }, [props.openedUnder, props.eGridCell])

  const report = useCallback((draft: string) => {
    const typed = commitKind === 'number' ? numberCommitText(draft) : draft
    if (!formulasOn) onValueChange?.(coerceTyped(typed, commitKind))
    else if (isFormulaDraft(draft) && !exprOf(draft).trim()) onValueChange?.(original)
    else onValueChange?.(commitValue(typed, original == null ? '' : String(original), commitKind))
  }, [original, commitKind, formulasOn, onValueChange])
  const change = useCallback((next: Applied) => {
    /* R-47 — on a number cell every edit (a keystroke, a paste, a deletion) is judged whole; one that would make the
       text not a number is refused, the text stays, and the caret goes back to where the edit began. */
    if (commitKind === 'number') {
      const prev = textRef.current
      if (acceptNumberEdit(prev, next.text, formulasOn).refused) {
        setNumberMessage(NUMBER_ONLY_MESSAGE)
        const at = Math.max(0, Math.min(prev.length, next.caret - (next.text.length - prev.length)))
        requestAnimationFrame(() => { inputRef.current?.setSelectionRange(at, at) })
        return
      }
    }
    setNumberMessage('')
    textRef.current = next.text
    touched.current = true
    editRevision.current += 1
    setSubmitting(false)
    setRefused(false)
    setText(next.text)
    setCaret(next.caret)
    setPickMessage('')
    // updateValue is synchronous: even an immediate Enter reads the latest keystroke.
    report(next.text)
  }, [report, commitKind, formulasOn])
  useEffect(() => { if (touched.current) report(initial) }, [])
  useGridCellEditor({ isCancelAfterEnd: () => !touched.current || (formula && !exprOf(text).trim()) })

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

  /** Commit what is typed, then leave the cell (`move`: Tab moves right, Shift+Tab left — AG's own Tab, reproduced). */
  const save = async (move: 'next' | 'previous' | null = null) => {
    const leave = () => {
      if (move === 'next') props.api.tabToNextCell()
      else if (move === 'previous') props.api.tabToPreviousCell()
    }
    if (!touched.current || (formula && !expr.trim())) { props.api.stopEditing(true); leave(); return }
    if (submitting) return
    if (formula) {
      const revision = editRevision.current
      setSubmitting(true)
      try {
        const checked = await preview(expr)
        if (revision !== editRevision.current) return
        setResponse(checked)
        setInFlight(false)
        if (!checked.ok) { setRefused(true); focusAt(caret); return }
      } catch {
        if (revision === editRevision.current) { setResponse({ ok: false, error: 'Could not check the formula. Please try again.', retryable: true }); setRefused(true) }
        return
      } finally {
        if (revision === editRevision.current) setSubmitting(false)
      }
    }
    if (!formula && formulaExpr && props.replaceFormula) {
      const revision = editRevision.current
      setSubmitting(true)
      try {
        const removed = await props.replaceFormula(commitValue(commitKind === 'number' ? numberCommitText(text) : text, original == null ? '' : String(original), commitKind))
        if (revision !== editRevision.current) return
        if (!removed.ok) { setPickMessage(removed.error ?? 'Could not replace this formula.'); return }
        props.api.stopEditing(true)
        leave()
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
    leave()
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
      e.preventDefault(); e.stopPropagation(); void save()
    } else if (e.key === 'Tab' && formula) {
      // `suppressFormulaKeys` handed Tab to this editor on a formula: check it like Enter, then move like AG would.
      e.preventDefault(); e.stopPropagation(); void save(e.shiftKey ? 'previous' : 'next')
    }
  }

  const toggle = (next: Exclude<ContextPanel, null>) => {
    setPanel(current => current === next ? null : next)
    if (next === 'history' && context.history && history.state !== 'loading' && history.state !== 'ready') {
      setHistory({ state: 'loading', entries: [] })
      context.history().then(entries => setHistory({ state: 'ready', entries }), () => setHistory({ state: 'error', entries: [] }))
    }
  }
  const use = (draft: string) => { change({ text: draft, caret: draft.length }); setPanel(null); focusAt(draft.length) }
  const decideDraft = async (verb: 'accept' | 'reject') => {
    const draft = context.aiDraft
    if (!draft || draftBusy) return
    setDraftBusy(true)
    try {
      await (verb === 'accept' ? draft.accept() : draft.reject())
      // The review wrote (or dismissed) the value; this edit has nothing left to add.
      props.api.stopEditing(true)
    } catch {
      setPickMessage(verb === 'accept' ? 'Could not use the AI draft. Please try again.' : 'Could not dismiss the AI draft. Please try again.')
      setDraftBusy(false)
    }
  }

  const hint = functionHint(callAt(tokens, Math.max(0, caret - offset)), functions)
  const cellRect = props.eGridCell?.getBoundingClientRect()
  /* Option A widths: one line asks for 400px (the key line and the counter fit on one row), a formula 480px, long text its
     cap — never wider than the room to the right, never narrower than the cell (editorBox). */
  const box = editorBox({ cellWidth: cellRect?.width ?? column.getActualWidth(), cellHeight: cellRect?.height ?? 0,
    roomToRight: cellRect ? roomToRightOf(cellRect.left, window.innerWidth) : window.innerWidth,
    kind: multiline && !formula ? 'longtext' : 'formula', contentWidth: formula ? 480 : multiline ? undefined : 400 })
  const cap = context.maxLength ?? undefined
  const length = text.length
  const over = cap !== undefined && length > cap
  const showCount = !formula && (multiline || cap !== undefined)
  const inputProps = {
    value: text, spellCheck: !formula, 'aria-label': formula ? 'Formula' : 'Cell value',
    'aria-invalid': refused || over || undefined,
    'aria-describedby': `${id}-keys ${id}-preview`,
    placeholder: formulasOn ? 'Type a value, or = for a formula' : 'Type a value',
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => change({ text: e.target.value, caret: e.target.selectionStart ?? e.target.value.length }),
    onSelect: (e: React.SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>) => setCaret(e.currentTarget.selectionStart ?? 0),
  }
  const hasContext = !!(context.aiDraft || context.history || context.inherited)
  return (
    <div className={`nds-formula-editor nds-readable${props.eGridCell?.closest('.dark') ? ' dark' : ''}`} data-completions={open} data-formula={formula}
      style={{ width: box.width, maxWidth: box.width }} onKeyDownCapture={keyboard}>
      <div className="nds-formula-body">
        <div className="nds-formula-line">
          <div className="nds-formula-fieldwrap">
            {formula && metrics && <div ref={overlayRef} className="nds-formula-overlay" aria-hidden style={{ ...metrics, fontVariantLigatures: 'none' }}>
              <span className="nds-formula-overlay-line">{renderTokens(text, expr, offset, tokens, refColours, unknown, errorAt)}</span>
            </div>}
            {multiline && !formula ? <Textarea {...inputProps} ref={el => { inputRef.current = el }} rows={5} /> :
              <Input {...inputProps} ref={el => { inputRef.current = el }} size="sm" autoComplete="off"
                role={formula ? 'combobox' : undefined} aria-autocomplete={formula ? 'list' : undefined}
                aria-expanded={formula ? open : undefined} aria-controls={open ? `${id}-listbox` : undefined}
                aria-activedescendant={open && matches[active] ? `${id}-o${active}` : undefined}
                className={formula ? `nds-formula-input${metrics ? ' highlighted' : ''}` : undefined}
                leadingIcon={formula || formulaExpr ? <FormulaGlyph title={formula ? 'Formula' : 'This cell holds a formula. Typing a value replaces it.'} /> : undefined}
                onScroll={syncScroll} />}
          </div>
          {/* Portaled tips: inside this scrolling editor a tip widened the body and focusing an icon scrolled it sideways. */}
          {hasContext && <TooltipPortalProvider><div className="nds-formula-context">
            {context.aiDraft && <ToolbarButton icon={<Sparkles size={14} />} label="AI draft" description="An AI suggestion is waiting for this cell" aria-expanded={panel === 'ai'} onClick={() => toggle('ai')} />}
            {context.history && <ToolbarButton icon={<History size={14} />} label="History" description="Earlier values of this cell" aria-expanded={panel === 'history'} onClick={() => toggle('history')} />}
            {context.inherited && <ToolbarButton icon={<Link2 size={14} />} label={`Follows ${context.inherited.from}`} description="Typing here gives this row its own value" aria-expanded={panel === 'parent'} onClick={() => toggle('parent')} />}
          </div></TooltipPortalProvider>}
        </div>

        {panel === 'ai' && context.aiDraft && <div className="nds-formula-contextpanel">
          <span className="nds-formula-contextpanel-label"><Sparkles size={12} aria-hidden /> AI suggests</span>
          <span className="nds-formula-contextpanel-value">{context.aiDraft.value}</span>
          <div className="nds-formula-contextpanel-actions">
            <Button size="xs" variant="primary" disabled={draftBusy} onClick={() => void decideDraft('accept')}>Use it</Button>
            <Button size="xs" variant="quiet" disabled={draftBusy} onClick={() => void decideDraft('reject')}>Dismiss</Button>
          </div>
        </div>}
        {panel === 'history' && context.history && <div className="nds-formula-contextpanel" role="list" aria-label="Earlier values" aria-busy={history.state === 'loading'}>
          {history.state === 'loading' && <span className="nds-formula-note">Reading earlier values…</span>}
          {history.state === 'error' && <span className="nds-formula-note bad">Could not read earlier values.</span>}
          {history.state === 'ready' && !history.entries.length && <span className="nds-formula-note">No earlier values recorded.</span>}
          {history.entries.map((h, i) => <button key={i} type="button" role="listitem" className="nds-formula-historyrow" onClick={() => use(h.value)}>
            <span className="nds-formula-contextpanel-value">{h.value || <em>empty</em>}</span>
            <span className="nds-formula-note">{[h.who, h.when].filter(Boolean).join(' · ')}</span>
          </button>)}
        </div>}
        {panel === 'parent' && context.inherited && <div className="nds-formula-contextpanel">
          <span className="nds-formula-contextpanel-label"><Link2 size={12} aria-hidden /> Follows {context.inherited.from}</span>
          <span className="nds-formula-contextpanel-value">{context.inherited.value || <em>empty</em>}</span>
          <span className="nds-formula-note">Typing here gives this row its own value.</span>
        </div>}

        {formula && <>
          {hint && <div className="nds-formula-hint"><code>
            {hint.signature.slice(0, hint.signature.indexOf('(') + 1)}
            {hint.args.map((arg, i) => <span key={i} className={i === hint.argIndex ? 'on' : undefined}>{arg}{i < hint.args.length - 1 ? ', ' : ''}</span>)})
          </code><span className="nds-formula-hint-sum">{hint.summary}</span></div>}
          {open && <ListboxPanel ariaLabel="Formula suggestions" options={options} query={token?.query ?? ''} autoFocus={false} onCommit={applyChosen}
            onCancel={() => setDismissed(completionKey)} activeIndex={active} onActiveIndexChange={setActive}
            onMatchesChange={setMatches} idPrefix={id} className="nds-formula-pop"
            style={{ position: 'static', width: '100%', maxWidth: '100%', maxHeight: 180 }} />}
          <FormulaGuidance text={text} sourceLabel={response?.sourceLabel ?? props.sourceLabel} disabled={submitting} allowText={commitKind !== 'number'}
            onInteractionChange={setAssisting} onChange={next => { change(next); focusAt(next.caret) }} />
          <span className="nds-formula-note">Click a field in this row to insert it.</span>
        </>}
        {multiline && !formula && <span className="nds-formula-note">Shift+Enter adds a line.</span>}

        <div id={`${id}-preview`} role="status" aria-live="polite" aria-atomic="true">
          {pickMessage && <div className="nds-formula-preview bad">{pickMessage}</div>}
          {!formula && numberMessage && <div className="nds-formula-preview bad">{numberMessage}</div>}
          {/* While a suggestion is being picked, a half-typed name is not an error yet. */}
          {formula && !pickMessage && !open && <div className={`nds-formula-preview${line.kind === 'error' ? ' bad' : ''}`}>
            {line.kind === 'idle' ? 'The result shows here' : line.kind === 'checking' ? 'Checking…'
              : line.kind === 'error' ? (refused ? <><b>Not saved.</b> {line.message}{/[.!?]$/.test(line.message.trim()) ? '' : '.'} Fix it, or press Esc to cancel.</> : line.message)
              : line.kind === 'empty' ? '= empty' : <>= <b>{String(line.value)}</b></>}
            {response?.retryable && <Button size="xs" variant="quiet" disabled={submitting} onClick={retry}>Retry</Button>}
          </div>}
        </div>
      </div>
      <div className="nds-formula-foot">
        <span id={`${id}-keys`} className="nds-editor-keyhint">{EDITOR_KEY_HINT}</span>
        {submitting && <span className="nds-formula-note">Checking…</span>}
        {showCount && <span className={`nds-formula-count${over ? ' bad' : ''}`} aria-live="polite">{length}{cap !== undefined ? ` / ${cap}` : ''}</span>}
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
  /**
   * Why THIS cell cannot open its editor yet (its formula state is still loading, or its read failed), or null. Per
   * cell: one slow or failed formula read must not block the cells whose state is already known.
   */
  unavailableReason?: (rowId: string | undefined, fieldKey: string) => string | null
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
  /** Option A — the cell's AI draft, history and inheritance, shown as icons in the editor only when present. */
  contextFor?: (row: TRow, fieldKey: string) => CellEditorContext | null
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
  col: { key: string; kind?: string; formulaWritable?: boolean; maxLength?: number | null },
  fallback: FallbackEditor | ((row: TRow | undefined) => FallbackEditor),
  rowIdOf: (row: TRow) => string,
) {
  return {
    cellEditorSelector: (p: { data?: TRow; eventKey?: string | null }) => {
      const unavailable = wiring.unavailableReason?.(p.data ? rowIdOf(p.data) : undefined, col.key)
      if (unavailable) return { component: FormulaUnavailableEditor, popup: true, params: { message: unavailable, retry: wiring.retry } }
      const stored = p.data ? wiring.exprFor(rowIdOf(p.data), col.key) : null
      const rowWritable = p.data ? wiring.canEditRow?.(p.data) : undefined
      const editor = typeof fallback === 'function' ? fallback(p.data) : fallback
      const available = rowWritable !== false && formulaAvailability({ formulaWritable: col.formulaWritable, hasStoredFormula: !!stored }).kind === 'available'
      const choice = formulaEditorChoice({ eventKey: p.eventKey, storedExpr: stored, formulaWritable: col.formulaWritable, rowWritable })
      /* Option A — the cell's context and length cap ride with every value editor this selector opens. */
      const cellContext = { ...(p.data ? wiring.contextFor?.(p.data, col.key) : null), maxLength: col.maxLength ?? null }
      /* R-63 — no formula here: text and number still open the ONE value editor (formulas off), never AG's inline ones. */
      if (!available) {
        const plain = editor.component === 'agTextCellEditor' ? scalarValueEditorSpec('text') : editor.component === 'agNumberCellEditor' ? scalarValueEditorSpec('number') : null
        return plain ? { ...plain, params: { ...plain.params, cellContext } } : editor
      }
      const scalar = typeof editor.component === 'string' && ['agTextCellEditor', 'agLargeTextCellEditor', 'agNumberCellEditor'].includes(editor.component)
      const direct = choice.use === 'formula' || scalar
      return {
        component: direct ? FormulaCellEditor : FormulaAwareEditor,
        popup: true,
        /* Option A — the value editor opens UNDER its cell. An option / list / measure editor keeps its own position; an `=`
           typed there swaps to this editor inside that popup, which is why `openedUnder` travels with the position. */
        ...(direct ? { popupPosition: 'under' as const } : {}),
        params: {
          openedUnder: direct,
          cellContext,
          /* 🔴 Explicit, not defaulted: AG merges the COLUMN's `cellEditorParams` under these (`mergeParams`), so a column
             that also names the plain value editor would otherwise hand this formula editor `formulas: false` and `=`
             would stop switching (caught by the push gate on 2026-09-24). */
          formulas: true,
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

/** Never called: with `formulas: false` the value editor asks for no preview. Stated rather than left `undefined`. */
const NO_PREVIEW = async (): Promise<FormulaPreviewResponse> => ({ ok: false, error: 'Formulas are not available in this cell.' })

/**
 * R-63 (A-42 step 1, 2026-09-24) — THE ONE TEXT/NUMBER EDITOR as an editor spec, formulas OFF: the value popup every
 * studio sheet already opens for text and number, without the `=` switch. Used by the selector when no formula is
 * available, and by `scalarValueEditor` for a sheet built without formula wiring (the Variants page).
 */
export function scalarValueEditorSpec(kind: 'text' | 'number') {
  return { component: FormulaCellEditor, popup: true, popupPosition: 'under' as const,
    params: { formulas: false, commitKind: kind, candidates: [], preview: NO_PREVIEW, openedUnder: true } }
}

/**
 * The same editor as ColDef fields, for a builder with no formula wiring. `cellEditorPopup` is REQUIRED (an editor
 * that renders outside the cell without it is torn down when focus leaves the grid root), and `suppressKeyboardEvent`
 * gives Enter/Esc to the editor, as on every studio column.
 */
export function scalarValueEditor(kind: 'text' | 'number') {
  const spec = scalarValueEditorSpec(kind)
  return { cellEditor: spec.component, cellEditorPopup: true, cellEditorPopupPosition: spec.popupPosition, cellEditorParams: spec.params, suppressKeyboardEvent: suppressFormulaKeys }
}

function FormulaUnavailableEditor(props: { message: string; retry?: () => void; api: { stopEditing: (cancel?: boolean) => void } }) {
  useGridCellEditor({ isCancelAfterEnd: () => true })
  return <div className="nds-formula-editor"><p role="status">{props.message}</p>
    <Button size="sm" onClick={() => { props.retry?.(); props.api.stopEditing(true) }}>Retry</Button>
    <Button size="sm" onClick={() => props.api.stopEditing(true)}>Close</Button></div>
}
