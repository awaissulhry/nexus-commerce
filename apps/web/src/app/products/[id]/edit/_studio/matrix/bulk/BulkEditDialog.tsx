'use client'

/**
 * The Matrix's ONE bulk Edit (Owner 2026-10-07: "an action button with which I'm able to make changes to any attribute
 * in bulk … super simple and easy to understand"; v2 2026-10-12: "make it the best it can be … even for a beginner").
 *
 * See your rows, pick what to change from a visible list, type the new value, check Now → New, apply.
 *
 * Desktop: two panes at ONE fixed height (nothing jumps) — the field list on the left (a radio list under Prices ·
 * Listing · Stock), and on the right the field's heading, How (its mode), the value, the mode's one-line hint, the
 * markets, then the notices and the table. The table is the only thing that scrolls. Phone (DS `useNarrow`): one column,
 * the field list becomes a `Listbox`, the body scrolls, and the table has two columns (Variant · Change).
 *
 * Before anything can be previewed the table shows the rows as they are NOW (the runner's `current`), with the one next
 * step above it; then the preview, re-asked 250 ms after the last change: every `Now → New` line, the skipped lines by
 * reason, the notices → Apply (counted, held with its reason, never silent) → Done, with Undo.
 *
 * Pure UI and its own state. It never writes and never computes a number it shows: the page's runner (`types.ts`,
 * `BulkEditSource`) previews and applies; the words and the rules are `dialogModel.ts`.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react'

import {
  Banner, ConfirmPhraseField, DateField, Disclosure, EmptyState, Field, Listbox, Modal, phraseMatches, useNarrow,
} from '@/design-system/components'
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import { Button, Checkbox, Divider, Input, RadioCard, SegmentedControl, Skeleton, Tag } from '@/design-system/primitives'

import type { CoordinateKey } from '../contract'
import {
  ALL_NONE_MIN, DEFAULT_INPUT_LABEL, PREVIEW_DELAY_MS, SEGMENT_CHOICES_MAX, applyHeldReason, applyLabel, buildRequest, copySource,
  createTableKeys, currencySymbol, effectiveFilter, errorText, fieldDefaults, fieldGroups, fieldListOptions, filterRows, footerStatus,
  groupSkipped, heldMarketsLine, lineFilterOptions, localIsoDate, marketsShown, modeRaw, nextStep, noChoiceText, noticesFor, parseInput,
  requestKey, requestMarkets, resolveInitial, skipGroupLine, skippedSummary, skippedText, tableRows, type BulkFormState, type BulkPhase,
  type BulkRaw, type LineFilter, type TableRow,
} from './dialogModel'
import type { BulkAdjustUnit, BulkEditSource, BulkInitial, BulkLine, BulkPreview, BulkResult } from './types'
import { SellsFromPicker } from '../SellsFromPicker'
import styles from './bulkEdit.module.css'
import dialogs from '../dialogs.module.css'

export interface BulkEditDialogProps {
  open: boolean
  /** Everything the page supplies for this opening (one set of rows); null = nothing to edit. */
  source: BulkEditSource | null
  /** What it opens on; the dialog defaults the rest. */
  initial?: BulkInitial
  onClose: () => void
  /** After `source.apply` resolved (the done screen is on). */
  onApplied?: (result: BulkResult) => void
}

interface PreviewState {
  preview: BulkPreview | null
  /** The key of the request this preview answers (the request that was sent). */
  key: string | null
  /** A preview is on its way for the request on screen. */
  loading: boolean
  error: string | null
}
const NO_PREVIEW: PreviewState = { preview: null, key: null, loading: false, error: null }
const NO_LINES: readonly BulkLine[] = Object.freeze([])

/** Today on the operator's calendar (a new sale starts on it). */
const todayIso = () => localIsoDate(new Date())

/** Below this width the table area shows two columns (Variant · Change) instead of four. */
const COMPACT_TABLE_BELOW = 520
/** The table's height until its area has been measured. */
const TABLE_HEIGHT_FALLBACK = 320

// ── the table ────────────────────────────────────────────────────────────────────────────────────────────────────

/** `now` = the rows as they are (nothing worked out yet) · `preview` = what would change · `done` = what was changed. */
type TableMode = 'now' | 'preview' | 'done'

/**
 * The variant: its name in bold with the SKU under it (the SKU alone when it has no name); on a phone, the market too.
 * On a desktop, the next rows of the same variant say only its name, quietly (`repeat`): one line each, easy to scan.
 */
function VariantCell({ line, withMarket = false, repeat = false }: { line: BulkLine; withMarket?: boolean; repeat?: boolean }) {
  if (repeat && !withMarket) return <span className={`${styles.muted} ${line.name ? '' : styles.mono}`}>{line.name ?? line.sku}</span>
  return (
    <span className={styles.stack}>
      {line.name ? (
        <>
          <b className={styles.name}>{line.name}</b>
          <span className={`${styles.mono} ${styles.muted}`}>{line.sku}</span>
        </>
      ) : <span className={styles.mono}>{line.sku}</span>}
      {withMarket && <span className={styles.muted}>{line.where}</span>}
    </span>
  )
}

/** What a line will say (or said): the new value in bold, or why it is skipped; a consequence under it. */
function NewCell({ line, mode }: { line: BulkLine; mode: TableMode }) {
  if (mode === 'now') return <span className={styles.muted} title="Not worked out yet">—</span>
  const skipped = line.skipped !== null
  const value = skipped
    ? <span className={styles.muted}>{mode === 'done' ? line.skipped : skippedText(line.skipped!)}</span>
    : <b className={styles.value}>{line.next ?? '—'}</b>
  return (
    <span className={styles.stack}>
      {mode === 'done'
        ? <span className={styles.tagged}><Tag tone={skipped ? 'warning' : 'success'}>{skipped ? 'Skipped' : 'Saved'}</Tag>{value}</span>
        : value}
      {line.note && <span className={styles.note}>{line.note}</span>}
    </span>
  )
}

/** The phone's one Change column: Now, then New (or why it is skipped), then the consequence. */
function ChangeCell({ line, mode }: { line: BulkLine; mode: TableMode }) {
  const done = mode === 'done'
  return (
    <span className={styles.stack}>
      <span className={styles.wrap}><span className={styles.muted}>{done ? 'Before' : 'Now'} </span>{line.now}</span>
      {mode !== 'now' && (
        line.skipped !== null ? (
          done
            ? <span className={styles.tagged}><Tag tone="warning">Skipped</Tag><span className={styles.muted}>{line.skipped}</span></span>
            : <span className={styles.muted}>{skippedText(line.skipped)}</span>
        ) : (
          <span className={styles.tagged}>
            {done ? <Tag tone="success">Saved</Tag> : <span className={styles.muted}>New</span>}
            <b className={styles.value}>{line.next ?? '—'}</b>
          </span>
        )
      )}
      {mode !== 'now' && line.note && <span className={styles.note}>{line.note}</span>}
    </span>
  )
}

/*
 * Widths are proportions: the grid widens every column to fill the area (all are widthed), and the text in a cell wraps
 * (the rows grow), so nothing is cut. Their sum is the narrowest area each form is used at — four columns from 520 px,
 * two on a phone (a 390 px screen leaves 294 px inside the dialog).
 */
const wideColumns = (mode: TableMode): Column<TableRow>[] => [
  // Variant is the widest: a whole SKU on one line (`GALE-JACKET-BLACK-MEN-XXS`) at the narrowest desktop pane.
  { key: 'variant', label: 'Variant', width: 190, render: (r) => <VariantCell line={r.line} repeat={!r.first} /> },
  { key: 'market', label: 'Market', width: 96, render: (r) => <span className={styles.wrap}>{r.line.where}</span> },
  { key: 'now', label: mode === 'done' ? 'Before' : 'Now', width: 80, render: (r) => <span className={styles.wrap}>{r.line.now}</span> },
  { key: 'new', label: mode === 'done' ? 'After' : 'New', width: 154, render: (r) => <NewCell line={r.line} mode={mode} /> },
]
const compactColumns = (mode: TableMode): Column<TableRow>[] => [
  { key: 'variant', label: 'Variant', width: 110, render: (r) => <VariantCell line={r.line} withMarket /> },
  { key: 'change', label: 'Change', width: 150, render: (r) => <ChangeCell line={r.line} mode={mode} /> },
]
const MODES: readonly TableMode[] = ['now', 'preview', 'done']
const WIDE = Object.fromEntries(MODES.map((m) => [m, wideColumns(m)])) as Record<TableMode, Column<TableRow>[]>
const COMPACT = Object.fromEntries(MODES.map((m) => [m, compactColumns(m)])) as Record<TableMode, Column<TableRow>[]>

const rowsWord = (n: number) => `${n.toLocaleString('en')} ${n === 1 ? 'row' : 'rows'}`

/** The width and height an element is given by the layout (not by its content), kept up to date. */
function useBox(el: HTMLElement | null): { width: number; height: number } {
  const [box, setBox] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return
    const read = () => setBox((b) => (b.width === el.clientWidth && b.height === el.clientHeight ? b : { width: el.clientWidth, height: el.clientHeight }))
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return box
}

export function BulkEditDialog(p: BulkEditDialogProps) {
  const { open, source, initial } = p
  const narrow = useNarrow()
  const [form, setForm] = useState<BulkFormState>(() => resolveInitial(source, initial, todayIso()))
  const [typed, setTyped] = useState('')
  const [filter, setFilter] = useState<LineFilter>('all')
  const [phase, setPhase] = useState<BulkPhase>('form')
  const [pv, setPv] = useState<PreviewState>(NO_PREVIEW)
  /** The preview that was applied: the done screen keeps its table. */
  const [applied, setApplied] = useState<BulkPreview | null>(null)
  const [result, setResult] = useState<BulkResult | null>(null)
  /** Undo's answer; the banner says it instead of the result, and Undo goes away. */
  const [receipt, setReceipt] = useState<string | null>(null)
  const [failure, setFailure] = useState<{ title: string; message: string } | null>(null)
  /** Bumped per opening and per "Edit something else": a fresh preview and the opening focus. */
  const [round, setRound] = useState(0)
  const applying = useRef(false)
  /** A new key per set of lines: the grid draws every row of a new set afresh (no stale cell from the last one). */
  const [tableKeyOf] = useState(() => createTableKeys())

  const startOver = (next: BulkFormState) => {
    setForm(next); setTyped(''); setFilter('all'); setPhase('form'); setPv(NO_PREVIEW)
    setApplied(null); setResult(null); setReceipt(null); setFailure(null); setRound((r) => r + 1)
  }

  /* Everything starts again when the dialog opens or its rows change. Not while a change is applied, undone or shown
     as done: that would drop the receipt and its Undo. (State adjusted during render, React's pattern for a prop change.) */
  const [seen, setSeen] = useState({ open, source })
  if (seen.open !== open || seen.source !== source) {
    const opening = open && !seen.open
    setSeen({ open, source })
    if (opening || (seen.source !== source && !(open && phase !== 'form'))) startOver(resolveInitial(source, initial, todayIso()))
  }

  const field = source?.fields.find((f) => f.id === form.field) ?? null
  const mode = field?.modes.find((m) => m.id === form.mode) ?? null
  const kind = mode?.input ?? 'none'
  const handoff = kind === 'handoff'

  // Markets: the runner's, with the Copy from source held; the request names the ticked ones that can be ticked.
  const marketOptions = useMemo(() => (source && field?.perMarket ? source.marketsFor(field.id) : []), [source, field])
  const fromKey = copySource(mode?.id, form.raw)
  const shownMarkets = useMemo(() => marketsShown(marketOptions, fromKey), [marketOptions, fromKey])
  const tickable = useMemo(() => shownMarkets.filter((m) => m.held === null), [shownMarkets])
  const reqMarkets = useMemo(() => requestMarkets(form.markets, shownMarkets), [form.markets, shownMarkets])
  const reqMarketsKey = reqMarkets.join('|')
  const heldLine = useMemo(() => heldMarketsLine(shownMarkets), [shownMarkets])
  const marketsNote = source && field?.perMarket && typeof source.marketsNote === 'function' ? source.marketsNote(field.id) : null

  const choices = useMemo(
    () => (source && field && mode && kind === 'choice' ? source.choicesFor(field.id, mode.id, reqMarkets) : []),
    // `reqMarkets` is what its key names.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source, field, mode, kind, reqMarketsKey],
  )
  const currency = useMemo(
    () => (source && field && (kind === 'money' || kind === 'sale' || kind === 'adjust') ? currencySymbol(source.currencyFor(field.id, reqMarkets)) : ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source, field, kind, reqMarketsKey],
  )
  const parsed = useMemo(
    () => parseInput(kind, form.raw, { choices: kind === 'choice' ? choices : undefined, mode: mode?.id }),
    [kind, form.raw, choices, mode],
  )
  const request = useMemo(() => buildRequest(field, mode, parsed, reqMarkets), [field, mode, parsed, reqMarkets])
  const key = requestKey(request)

  /** The rows as they are now, for this field on these markets (read from the page's cells; nothing is asked). */
  const currentLines = useMemo<readonly BulkLine[]>(
    () => (source && field && typeof source.current === 'function' ? source.current(field.id, field.perMarket ? reqMarkets : []) : NO_LINES),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source, field, reqMarketsKey],
  )

  /* The preview, 250 ms after the last change. An answer for a request no longer on screen is dropped (the cleanup
     turns its `live` off), and the one kept remembers the key it answers. */
  useEffect(() => {
    if (!open || !source || phase !== 'form' || !request || key === null) {
      setPv((s) => (s.loading || s.error ? { ...s, loading: false, error: null } : s))
      return
    }
    let live = true
    setPv((s) => ({ ...s, loading: true, error: null }))
    const timer = setTimeout(() => {
      source.preview(request).then(
        (preview) => { if (live) setPv({ preview, key, loading: false, error: null }) },
        (e: unknown) => { if (live) setPv({ preview: null, key: null, loading: false, error: errorText(e) }) },
      )
    }, PREVIEW_DELAY_MS)
    return () => { live = false; clearTimeout(timer) }
    // `request` is what `key` names; `round` asks again for the same request after "Edit something else".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, source, phase, key, round])

  /** The preview that answers what is on screen — the only one Apply sends. */
  const current = pv.preview && key !== null && pv.key === key && !pv.loading ? pv.preview : null
  const inForm = phase === 'form' || phase === 'applying'
  /* The preview the form shows: while the next answer is worked out, the last one stays (marked busy) — but only an
     answer for the same field and mode; another field's lines under this field's heading would mislead. */
  const formPreview = phase === 'form' && key !== null && !pv.error && pv.preview
    && pv.preview.request.field === form.field && pv.preview.request.mode === form.mode ? pv.preview : null
  const shownPreview: BulkPreview | null = phase === 'form' ? formPreview : applied
  const tableMode: TableMode = !inForm ? 'done' : shownPreview ? 'preview' : 'now'
  const lines: readonly BulkLine[] = shownPreview?.lines ?? (inForm ? currentLines : NO_LINES)
  const refreshing = phase === 'form' && formPreview !== null && formPreview !== current
  const working = phase === 'form' && key !== null && !pv.error && formPreview === null

  const confirmWord = inForm ? shownPreview?.confirmWord ?? null : null
  const confirmed = !!current?.confirmWord && phraseMatches(typed, current.confirmWord)
  const ticked = field?.perMarket ? reqMarkets.length : 0
  const held = applyHeldReason({ phase, field, mode, parsed, ticked, error: pv.error, current, confirmed })
  const step = phase === 'form' ? nextStep({ field, mode, parsed, ticked }) : null
  // A held field says why once, above the table; the footer does not repeat it.
  const status = field?.held ? '' : footerStatus({ phase, current, held })
  const locked = phase === 'applying' || phase === 'undoing'
  const handoffHeld = field?.held ?? (source?.openElsewhere ? null : 'This opens from the grid only')

  const filterOptions = useMemo(() => (tableMode === 'now' ? [] : lineFilterOptions(lines, tableMode === 'done')), [lines, tableMode])
  const activeFilter = tableMode === 'now' ? 'all' : effectiveFilter(lines, filter)
  const allRows = useMemo(() => tableRows(lines, tableKeyOf(lines)), [lines, tableKeyOf])
  const rows = useMemo(() => filterRows(allRows, activeFilter), [allRows, activeFilter])
  const skipGroups = useMemo(() => (tableMode === 'preview' ? groupSkipped(lines) : []), [lines, tableMode])
  const notices = useMemo(() => (tableMode === 'preview' && shownPreview ? noticesFor(shownPreview, mode?.hint) : []), [tableMode, shownPreview, mode])

  const groups = useMemo(() => fieldGroups(source?.fields ?? []), [source])
  const fieldOptions = useMemo(() => fieldListOptions(source?.fields ?? []), [source])

  // The table area's own size: its height bounds the grid (the table scrolls inside), its width picks the columns.
  const [areaEl, setAreaEl] = useState<HTMLDivElement | null>(null)
  const area = useBox(areaEl)
  const compact = narrow || (area.width > 0 && area.width < COMPACT_TABLE_BELOW)
  const columns = (compact ? COMPACT : WIDE)[tableMode]
  // Desktop: the area's height. Phone: none — the grid is as tall as its rows and the dialog body scrolls (one scrollbar).
  // Less the frame's two 1 px borders: the DS grid sizes itself without them, and the frame would scroll by 2 px.
  const tableMax = narrow ? undefined : Math.max(120, (area.height || TABLE_HEIGHT_FALLBACK) - 2)

  /* Focus: on opening and after "Edit something else", the value field when the mode has one, else the field list (the
     chosen field's radio; on a phone, the list's button). The Modal has already focused its first control (its effect
     runs before this one, a parent's). */
  const formId = useId()
  const hintId = useId()
  const radioName = useId()
  const bodyRef = useRef<HTMLDivElement>(null)
  const doneRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const body = bodyRef.current
    const target = body?.querySelector<HTMLElement>('[data-autofocus]')
      ?? body?.querySelector<HTMLElement>('[data-field-list] input[type="radio"]:checked, [data-field-list] button')
    target?.focus()
  }, [open, round])
  // The done screen replaces the button that was pressed (Apply; Undo once it worked): the focus goes to Done. A failed
  // Undo changes neither, so the focus stays on Undo to try again.
  useEffect(() => {
    if (open && phase === 'done') doneRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, result, receipt])

  const close = () => { if (!locked) p.onClose() }

  /** Choosing a field keeps the focus in the list (arrow keys go on working); a held field stays where it is. */
  const chooseField = (id: string) => {
    if (!source || locked || id === form.field) return
    const next = source.fields.find((f) => f.id === id)
    if (!next || next.held !== null) return // reachable and says why, but never chosen
    setForm(fieldDefaults(source, next.id, todayIso())); setTyped(''); setFilter('all'); setFailure(null)
  }
  const chooseMode = (id: string) => {
    const next = field?.modes.find((m) => m.id === id)
    if (!next || locked || next.id === form.mode) return
    // Raise ↔ Lower keeps the number and its unit: only the direction changed.
    setForm((f) => ({ ...f, mode: next.id, raw: kind === 'adjust' && next.input === 'adjust' ? f.raw : modeRaw(next, todayIso()) })); setTyped('')
  }
  const setRaw = (patch: Partial<BulkRaw>) => { if (!locked) setForm((f) => ({ ...f, raw: { ...f.raw, ...patch } })) }
  const toggleMarket = (k: CoordinateKey) => {
    if (locked) return
    setForm((f) => {
      const next = f.markets.includes(k) ? f.markets.filter((x) => x !== k) : [...f.markets, k]
      return { ...f, markets: marketOptions.map((m) => m.key).filter((x) => next.includes(x)) }
    })
  }
  const tickAll = () => { if (!locked) setForm((f) => ({ ...f, markets: tickable.map((m) => m.key) })) }
  const tickNone = () => { if (!locked) setForm((f) => ({ ...f, markets: [] })) }

  const apply = async () => {
    if (held !== null || !current || !source || applying.current) return
    applying.current = true
    setApplied(current); setPhase('applying'); setFailure(null)
    try {
      const r = await source.apply(current)
      // The table now says what the server answered, line by line (a line refused at Apply is skipped, with why).
      if (r.lines) {
        const changes = r.lines.filter((l) => l.skipped === null).length
        setApplied({ ...current, lines: r.lines, changes, skipped: r.lines.length - changes })
      }
      setResult(r); setReceipt(null); setPhase('done')
      p.onApplied?.(r)
    } catch (e) {
      setFailure({ title: 'The change was not applied', message: errorText(e) })
      setApplied(null); setPhase('form')
    } finally {
      applying.current = false
    }
  }
  const onSubmit = (e: FormEvent) => { e.preventDefault(); if (!handoff) void apply() }

  /** A hand-off field (Case size, Stock source): the page closes this dialog and opens the field's own. */
  const openElsewhere = () => {
    if (!source || !field || locked || handoffHeld) return
    source.openElsewhere?.(field.id)
  }

  const undo = async () => {
    if (!result?.undo || phase !== 'done' || receipt !== null) return
    setPhase('undoing'); setFailure(null)
    try { setReceipt(await result.undo()) } catch (e) { setFailure({ title: 'The change was not undone', message: errorText(e) }) } finally { setPhase('done') }
  }
  /** Back to the form: the same rows, field, mode and markets; the value cleared; a fresh preview. */
  const editAgain = () => {
    if (!source || locked) return
    const today = todayIso()
    startOver(source.fields.some((f) => f.id === form.field && f.held === null) ? { ...form, raw: modeRaw(mode, today) } : resolveInitial(source, undefined, today))
  }

  // ── the parts ──────────────────────────────────────────────────────────────────────────────────────────────────

  const errorAt = (at: 'value' | 'start' | 'end') => (parsed.state === 'invalid' && parsed.at === at ? parsed.reason : undefined)
  const describedBy = mode?.hint ? hintId : undefined
  const inputLabel = mode ? mode.inputLabel ?? DEFAULT_INPUT_LABEL[kind] : ''
  const choiceOptions = choices.map((c) => ({ value: c.value, label: c.label, title: c.title }))
  const units = mode?.units ?? []
  const unitOptions = units.map((u) => ({ value: u, label: u === 'percent' ? '%' : currency }))

  const valueControl = (() => {
    switch (kind) {
      case 'money': return (
        <div className={styles.value}>
          <Field label={inputLabel} error={errorAt('value')}>
            <Input size="sm" type="text" inputMode="decimal" autoComplete="off" prefix={currency} placeholder="0.00"
              value={form.raw.text} onChange={(e) => setRaw({ text: e.target.value })} aria-describedby={describedBy} data-autofocus />
          </Field>
        </div>
      )
      // Raise · Lower: an unsigned number (the mode is the direction) and, beside it, what the number is: % or the currency.
      case 'adjust': return (
        <div className={styles.adjust}>
          <div className={styles.value}>
            <Field label={inputLabel} error={errorAt('value')}>
              <Input size="sm" type="text" inputMode="decimal" autoComplete="off" placeholder={form.raw.unit === 'percent' ? '5' : '2.00'}
                prefix={form.raw.unit === 'money' ? currency : undefined} suffix={form.raw.unit === 'percent' ? '%' : undefined}
                value={form.raw.text} onChange={(e) => setRaw({ text: e.target.value })} aria-describedby={describedBy} data-autofocus />
            </Field>
          </div>
          {unitOptions.length > 1 && (
            <div className="nds-field-w">
              <span className="nds-field-lbl" aria-hidden="true">Unit</span>
              <SegmentedControl ariaLabel="Unit" size="sm" className={dialogs.seg} value={form.raw.unit}
                onChange={(v) => setRaw({ unit: v as BulkAdjustUnit })} options={unitOptions} />
            </div>
          )}
        </div>
      )
      case 'integer': return (
        <div className={styles.value}>
          <Field label={inputLabel} error={errorAt('value')}>
            <Input size="sm" type="text" inputMode="numeric" autoComplete="off" placeholder="0"
              value={form.raw.text} onChange={(e) => setRaw({ text: e.target.value })} aria-describedby={describedBy} data-autofocus />
          </Field>
        </div>
      )
      case 'choice':
        if (choiceOptions.length === 0) return <p className={styles.hint}>{noChoiceText(mode?.id ?? null, field?.perMarket ? reqMarkets.length : 1)}</p>
        return choiceOptions.length <= SEGMENT_CHOICES_MAX ? (
          <div className="nds-field-w">
            <span className="nds-field-lbl" aria-hidden="true">{inputLabel}</span>
            <SegmentedControl ariaLabel={inputLabel} size="sm" className={dialogs.seg} value={form.raw.choice} onChange={(v) => setRaw({ choice: v })} options={choiceOptions} />
          </div>
        ) : (
          <div className={styles.choice}>
            <Field label={inputLabel}>
              <Listbox size="sm" options={choiceOptions} value={form.raw.choice || undefined} onChange={(v) => setRaw({ choice: v })}
                placeholder="Choose…" aria-describedby={describedBy} />
            </Field>
          </div>
        )
      case 'sale': return (
        <div className={styles.sale}>
          <Field label={inputLabel} error={errorAt('value')}>
            <Input size="sm" type="text" inputMode="decimal" autoComplete="off" prefix={currency} placeholder="0.00"
              value={form.raw.text} onChange={(e) => setRaw({ text: e.target.value })} aria-describedby={describedBy} data-autofocus />
          </Field>
          <Field label="Starts" error={errorAt('start')}>
            <DateField value={form.raw.start} onChange={(v) => setRaw({ start: v })} max={form.raw.end || undefined} placeholder="Choose a date" clearable={false} />
          </Field>
          <Field label="Ends" error={errorAt('end')}>
            <DateField value={form.raw.end} onChange={(v) => setRaw({ end: v })} min={form.raw.start || undefined} placeholder="Choose a date" clearable={false} />
          </Field>
        </div>
      )
      // Sells from: the From pop-up's own picker (ticked = sells, top first).
      case 'locations': return (
        <div className="nds-field-w">
          <span className="nds-field-lbl" aria-hidden="true">{inputLabel}</span>
          <SellsFromPicker label={`${inputLabel}, in sale order`} locations={source?.locations ?? []} value={form.raw.codes}
            onChange={(codes) => setRaw({ codes })} disabled={locked} />
        </div>
      )
      case 'none': case 'handoff': return null
    }
  })()

  /* The field list. Desktop: native radios in one group (arrow keys move between fields, across the headings); a held
     field is reachable and says why instead of its description (`aria-disabled`, never a silent `disabled`). Phone: the
     same list as a Listbox, grouped, the descriptions as notes. */
  const fieldList = narrow ? (
    <div className={styles.change} data-field-list>
      <Field label="What do you want to change?" hint={field && !field.held ? field.description : undefined}>
        <Listbox size="sm" options={fieldOptions} value={form.field ?? undefined} onChange={chooseField} placeholder="Choose what to change" />
      </Field>
    </div>
  ) : (
    <div className={styles.fieldsPane} data-field-list>
      <fieldset className={styles.fields}>
        <legend className="nds-field-lbl">What do you want to change?</legend>
        {groups.map((g) => (
          <div key={g.group} role="group" aria-labelledby={`${radioName}-${g.group}`} className={styles.group}>
            <span id={`${radioName}-${g.group}`} className={styles.groupHead}>{g.group}</span>
            {g.fields.map((f) => (
              <RadioCard key={f.id} variant="row" name={radioName} value={f.id} checked={form.field === f.id} selected={form.field === f.id}
                onChange={() => chooseField(f.id)} aria-disabled={f.held !== null ? true : undefined}
                title={f.label} description={f.held ?? f.description} />
            ))}
          </div>
        ))}
      </fieldset>
    </div>
  )

  const head = field && !narrow && (
    <div className={styles.head}>
      <h3 className={styles.fieldTitle}>{field.label}</h3>
      <p className={styles.desc}>{field.description}</p>
    </div>
  )

  const controls = field && !field.held && mode && (
    <div className={styles.controls}>
      {field.modes.length > 1 && (
        <div className="nds-field-w">
          <span className="nds-field-lbl" aria-hidden="true">How</span>
          <SegmentedControl ariaLabel="How" size="sm" className={dialogs.seg} value={form.mode ?? ''} onChange={chooseMode}
            options={field.modes.map((m) => ({ value: m.id, label: m.label }))} />
        </div>
      )}
      {valueControl}
      {mode.hint && <p className={styles.hint} id={hintId}>{mode.hint}</p>}
    </div>
  )

  const markets = field?.perMarket && !field.held && !handoff ? (
    <fieldset className={styles.markets}>
      <legend className="nds-field-lbl">Markets</legend>
      {tickable.length === 0 ? <p className={styles.hint}>None of these rows is on a market that takes this.</p> : (
        <div className={styles.marketList}>
          {tickable.map((m) => <Checkbox key={m.key} checked={form.markets.includes(m.key)} onChange={() => toggleMarket(m.key)} label={m.label} />)}
          {tickable.length >= ALL_NONE_MIN && (
            <span className={styles.allNone}>
              <Button size="sm" variant="link" inline onClick={tickAll} aria-label="Tick every market">All</Button>
              <Button size="sm" variant="link" inline onClick={tickNone} aria-label="Untick every market">None</Button>
            </span>
          )}
        </div>
      )}
      {heldLine && <p className={styles.hint}>{heldLine}</p>}
      {marketsNote && <p className={styles.hint}>{marketsNote}</p>}
    </fieldset>
  ) : null

  const banners = tableMode === 'preview' && (
    <>
      {notices.map((n) => <Banner key={n.text} tone={n.tone}>{n.text}</Banner>)}
      {skipGroups.length > 0 && shownPreview && (
        <Disclosure summary={skippedSummary(shownPreview.skipped)}>
          <ul className={styles.list}>{skipGroups.map((g) => <li key={g.reason}>{skipGroupLine(g)}</li>)}</ul>
        </Disclosure>
      )}
    </>
  )

  // The line above the table: the filter once there is a preview, else the ONE next step (the footer says it shorter).
  const toolbarLead = filterOptions.length > 0
    ? <SegmentedControl ariaLabel="Show" size="sm" value={activeFilter} onChange={(v) => setFilter(v as LineFilter)} options={filterOptions} />
    : tableMode === 'now' && step ? <p className={styles.step} role="status">{step.long}</p> : <span />
  const toolbarTail = refreshing ? 'Updating…' : working ? 'Working out…' : rowsWord(rows.length)
  const skeleton = working && lines.length === 0
  const table = (
    <>
      <div className={styles.toolbar}>
        {toolbarLead}
        <span className={styles.muted}>{toolbarTail}</span>
      </div>
      <div ref={setAreaEl} className={styles.tableArea} aria-busy={refreshing || working || undefined}>
        {skeleton ? (
          <div className={styles.loading} role="status" aria-label="Working out the changes">
            <Skeleton height={14} /><Skeleton height={14} width="90%" /><Skeleton height={14} width="75%" /><Skeleton height={14} width="85%" />
          </div>
        ) : (
          <DataGrid ariaLabel={tableMode === 'done' ? 'What was changed' : tableMode === 'preview' ? 'What would change' : 'The rows now'} size="sm"
            keyboardScroll headerMenus={false} maxHeight={tableMax} columns={columns} rows={rows} rowKey={(r) => r.key}
            emptyState={<EmptyState title="Nothing to show" description="None of these rows is on the ticked markets." />} />
        )}
      </div>
    </>
  )

  const failureBanner = failure && <Banner tone="danger" title={failure.title}>{failure.message}</Banner>

  const body = inForm ? (
    <form id={formId} className={styles.form} onSubmit={onSubmit} noValidate>
      {!narrow && fieldList}
      <div className={styles.pane}>
        {failureBanner}
        {narrow && fieldList}
        {head}
        {controls}
        {markets}
        <Divider />
        {pv.error && phase === 'form' && key !== null && <Banner tone="danger" title="The changes could not be worked out">{pv.error}</Banner>}
        {banners}
        {/* A hand-off with nothing to show has no table: its button says what happens. */}
        {(!handoff || lines.length > 0) && table}
        {confirmWord && <ConfirmPhraseField phrase={confirmWord} value={typed} onChange={(v) => { if (!locked) setTyped(v) }} />}
      </div>
    </form>
  ) : (
    <div className={styles.done}>
      {failureBanner}
      {result && <Banner tone={receipt !== null ? 'success' : result.tone}>{receipt ?? result.sentence}</Banner>}
      {table}
    </div>
  )

  const heldProps = (reason: string | null) => (reason !== null ? { 'aria-disabled': true, className: 'held', title: reason } : {})
  const undoing = phase === 'undoing'
  const handoffLabel = mode?.inputLabel ?? 'Open'
  const footer = inForm ? (
    <>
      <span className={styles.status} role="status">{handoff ? handoffHeld ?? '' : status}</span>
      <span className="grow" />
      <Button size="sm" variant="secondary" onClick={close} {...heldProps(locked ? 'Applying…' : null)}>Cancel</Button>
      {handoff ? (
        <Button size="sm" variant="primary" onClick={openElsewhere} title={handoffHeld ?? handoffLabel} {...heldProps(handoffHeld)}>{handoffLabel}</Button>
      ) : (
        <Button size="sm" variant="primary" type="submit" form={formId} title={held ?? applyLabel(current)} {...heldProps(held)}>
          {phase === 'applying' ? 'Applying…' : applyLabel(current)}
        </Button>
      )}
    </>
  ) : (
    <>
      {result?.undo && receipt === null && (
        <Button size="sm" variant="secondary" onClick={() => { void undo() }} title="Put the change back" {...heldProps(undoing ? 'Undoing…' : null)}>
          {undoing ? 'Undoing…' : 'Undo'}
        </Button>
      )}
      <span className="grow" />
      <Button size="sm" variant="secondary" onClick={editAgain} {...heldProps(undoing ? 'Undoing…' : null)}>Edit something else</Button>
      <Button ref={doneRef} size="sm" variant="primary" onClick={close} {...heldProps(undoing ? 'Undoing…' : null)}>Done</Button>
    </>
  )

  return (
    <Modal open={open && source !== null} onClose={close} size="xxl" title={source?.title} subtitle={source?.subtitle} footer={footer}>
      <div ref={bodyRef} className={styles.body}>{body}</div>
    </Modal>
  )
}
