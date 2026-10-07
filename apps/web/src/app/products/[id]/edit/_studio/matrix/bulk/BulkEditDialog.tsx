'use client'

/**
 * The Matrix's ONE bulk Edit (Owner 2026-10-07: "an action button with which I'm able to make changes to any attribute
 * in bulk … super simple and easy to understand, but very reactive, responsive and dynamic").
 *
 * Change (the field) → How (its mode) → Value → Markets → the preview, re-asked 250 ms after the last change: every
 * `Now → New` line, the skipped lines by reason, the notices → Apply (counted, held with its reason, never silent) →
 * Done, with Undo. The pattern the Owner liked (the Import dialog, 2026-09-26): a default for every choice, one summary,
 * one table, a counted primary button, Done with Undo.
 *
 * Pure UI and its own state. It never writes and never computes a number it shows: the page's runner (`types.ts`,
 * `BulkEditSource`) previews and applies; the words and the rules are `dialogModel.ts`.
 */
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'

import {
  Banner, ConfirmPhraseField, DateField, Disclosure, EmptyState, Field, Listbox, Modal, phraseMatches, type ListboxPanelOption,
} from '@/design-system/components'
// The DS grid's DataGrid (AG Grid, the same props) — the retiring `components/DataGrid` is on the grid-kit ratchet.
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import { Button, Checkbox, Input, SegmentedControl, Skeleton, Tag } from '@/design-system/primitives'

import type { CoordinateKey } from '../contract'
import {
  DEFAULT_INPUT_LABEL, EMPTY_RAW, PREVIEW_DELAY_MS, SEGMENT_CHOICES_MAX, applyHeldReason, applyLabel, buildRequest, currencySymbol,
  effectiveFilter, errorText, fieldDefaults, filterLines, footerStatus, groupSkipped, lineFilterOptions, parseInput, previewPrompt,
  requestKey, resolveInitial, skipGroupLine, type BulkFormState, type BulkPhase, type BulkRaw, type LineFilter,
} from './dialogModel'
import type { BulkEditSource, BulkInitial, BulkLine, BulkPreview, BulkResult } from './types'
import { SellsFromPicker } from '../SellsFromPicker'
import styles from './bulkEdit.module.css'

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

/** What a changed line will say: the new value in bold, or why it is skipped; a consequence under it. */
function NewCell({ line }: { line: BulkLine }) {
  return (
    <span className={styles.next}>
      {line.skipped !== null ? <span className={styles.reason}>{line.skipped}</span> : <b>{line.next ?? '—'}</b>}
      {line.note && <span className={styles.note}>{line.note}</span>}
    </span>
  )
}

/** The table's columns; once applied, a changed line reads Saved (the server's answer), a refused one Skipped. */
const columnsFor = (done: boolean): Column<BulkLine>[] => [
  { key: 'sku', label: 'Variant', width: 250, render: (l) => <span className={styles.mono}>{l.sku}</span> },
  { key: 'where', label: 'Where', width: 170, render: (l) => l.where },
  { key: 'now', label: 'Now', width: 120, render: (l) => l.now },
  { key: 'new', label: 'New', width: 240, render: (l) => <NewCell line={l} /> },
  { key: 'status', label: 'Status', width: 90, render: (l) => (l.skipped !== null ? <Tag tone="warning">Skipped</Tag> : done ? <Tag tone="success">Saved</Tag> : <Tag tone="info">Change</Tag>) },
]
const FORM_COLUMNS = columnsFor(false)
const DONE_COLUMNS = columnsFor(true)

const rows = (n: number) => `${n.toLocaleString('en')} ${n === 1 ? 'row' : 'rows'}`

export function BulkEditDialog(p: BulkEditDialogProps) {
  const { open, source, initial } = p
  const [form, setForm] = useState<BulkFormState>(() => resolveInitial(source, initial))
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
    if (opening || (seen.source !== source && !(open && phase !== 'form'))) startOver(resolveInitial(source, initial))
  }

  const field = source?.fields.find((f) => f.id === form.field) ?? null
  const mode = field?.modes.find((m) => m.id === form.mode) ?? null
  const kind = mode?.input ?? 'none'
  const marketOptions = useMemo(() => (source && field?.perMarket ? source.marketsFor(field.id) : []), [source, field])
  const choices = useMemo(
    () => (source && field && mode && kind === 'choice' ? source.choicesFor(field.id, mode.id, form.markets) : []),
    [source, field, mode, kind, form.markets],
  )
  const currency = useMemo(
    () => (source && field && (kind === 'money' || kind === 'sale') ? currencySymbol(source.currencyFor(field.id, form.markets)) : ''),
    [source, field, kind, form.markets],
  )
  const parsed = useMemo(() => parseInput(kind, form.raw, kind === 'choice' ? choices : undefined), [kind, form.raw, choices])
  const request = useMemo(() => buildRequest(field, mode, parsed, form.markets), [field, mode, parsed, form.markets])
  const key = requestKey(request)

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
  /** The table on screen: while the next answer is worked out, the last one stays (marked busy). */
  const shown: BulkPreview | null = !inForm || phase === 'applying' ? applied : key === null || pv.error ? null : pv.preview
  const refreshing = phase === 'form' && shown !== null && shown !== current
  const firstLoad = phase === 'form' && key !== null && !pv.error && shown === null

  const confirmWord = inForm ? shown?.confirmWord ?? null : null
  const confirmed = !!current?.confirmWord && phraseMatches(typed, current.confirmWord)
  const held = applyHeldReason({ phase, field, parsed, ticked: form.markets.length, error: pv.error, current, confirmed })
  const status = footerStatus({ phase, current, held })
  const locked = phase === 'applying' || phase === 'undoing'

  const filterOptions = useMemo(() => (shown ? lineFilterOptions(shown.lines, !inForm) : []), [shown, inForm])
  const activeFilter = shown ? effectiveFilter(shown.lines, filter) : 'all'
  const tableRows = useMemo(() => (shown ? filterLines(shown.lines, activeFilter) : []), [shown, activeFilter])
  const skipGroups = useMemo(() => (shown ? groupSkipped(shown.lines) : []), [shown])

  const fieldOptions = useMemo<ListboxPanelOption[]>(
    () => (source?.fields ?? []).map((f) => ({ value: f.id, label: f.label, group: f.group, ...(f.held !== null ? { heldReason: f.held, note: f.held } : {}) })),
    [source],
  )

  /* Focus: on opening and after "Edit something else", the value field when the mode has one, else the Change list.
     The Modal has already focused its first control (its effect runs before this one, a parent's). */
  const formId = useId()
  const hintId = useId()
  const bodyRef = useRef<HTMLDivElement>(null)
  const changeRef = useRef<HTMLDivElement>(null)
  const doneRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const target = bodyRef.current?.querySelector<HTMLElement>('[data-autofocus]') ?? changeRef.current?.querySelector<HTMLElement>('button')
    target?.focus()
  }, [open, round])
  // The done screen replaces the button that was pressed (Apply; Undo once it worked): the focus goes to Done. A failed
  // Undo changes neither, so the focus stays on Undo to try again.
  useEffect(() => {
    if (open && phase === 'done') doneRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, result, receipt])

  const close = () => { if (!locked) p.onClose() }

  const chooseField = (id: string) => {
    if (!source || locked || id === form.field) return
    const next = source.fields.find((f) => f.id === id)
    if (!next || next.held !== null) return // the list already refuses a held field; never chosen from here either
    setForm(fieldDefaults(source, next.id)); setTyped(''); setFilter('all'); setFailure(null)
  }
  const chooseMode = (id: string) => {
    const next = field?.modes.find((m) => m.id === id)
    if (!next || locked || next.id === form.mode) return
    setForm((f) => ({ ...f, mode: next.id, raw: EMPTY_RAW })); setTyped('')
  }
  const setRaw = (patch: Partial<BulkRaw>) => { if (!locked) setForm((f) => ({ ...f, raw: { ...f.raw, ...patch } })) }
  const toggleMarket = (k: CoordinateKey) => {
    if (locked) return
    setForm((f) => {
      const next = f.markets.includes(k) ? f.markets.filter((x) => x !== k) : [...f.markets, k]
      return { ...f, markets: marketOptions.map((m) => m.key).filter((x) => next.includes(x)) }
    })
  }

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
  const onSubmit = (e: FormEvent) => { e.preventDefault(); void apply() }

  const undo = async () => {
    if (!result?.undo || phase !== 'done' || receipt !== null) return
    setPhase('undoing'); setFailure(null)
    try { setReceipt(await result.undo()) } catch (e) { setFailure({ title: 'The change was not undone', message: errorText(e) }) } finally { setPhase('done') }
  }
  /** Back to the form: the same rows, field, mode and markets; the value cleared; a fresh preview. */
  const editAgain = () => {
    if (!source || locked) return
    startOver(source.fields.some((f) => f.id === form.field && f.held === null) ? { ...form, raw: EMPTY_RAW } : resolveInitial(source))
  }

  // ── the parts ──────────────────────────────────────────────────────────────────────────────────────────────────

  const errorAt = (at: 'value' | 'start' | 'end') => (parsed.state === 'invalid' && parsed.at === at ? parsed.reason : undefined)
  const describedBy = mode?.hint ? hintId : undefined
  const inputLabel = mode ? mode.inputLabel ?? DEFAULT_INPUT_LABEL[kind] : ''
  const choiceOptions = choices.map((c) => ({ value: c.value, label: c.label, title: c.title }))

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
      // A signed number: the phone's full keyboard, which has the minus sign (a decimal pad on iOS has none).
      case 'percent': return (
        <div className={styles.value}>
          <Field label={inputLabel} error={errorAt('value')}>
            <Input size="sm" type="text" autoComplete="off" suffix="%" placeholder="−5"
              value={form.raw.text} onChange={(e) => setRaw({ text: e.target.value })} aria-describedby={describedBy} data-autofocus />
          </Field>
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
        if (choiceOptions.length === 0) return <p className={styles.hint}>Nothing to choose on the ticked markets.</p>
        return choiceOptions.length <= SEGMENT_CHOICES_MAX ? (
          <div className="nds-field-w">
            <span className="nds-field-lbl" aria-hidden="true">{inputLabel}</span>
            <SegmentedControl ariaLabel={inputLabel} size="sm" wrap value={form.raw.choice} onChange={(v) => setRaw({ choice: v })} options={choiceOptions} />
          </div>
        ) : (
          <div className={styles.change}>
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
      case 'none': return null
    }
  })()

  const markets = field?.perMarket ? (
    <fieldset className={styles.markets}>
      <legend className="nds-field-lbl">Markets</legend>
      {marketOptions.length === 0 ? <p className={styles.hint}>None of these rows is on a market that takes this.</p> : (
        <div className={styles.marketList}>
          {marketOptions.map((m) => (m.held !== null ? (
            // Held, never a silent `disabled`: it stays reachable and says why; a click or Space does not tick it.
            <Checkbox key={m.key} checked={false} aria-disabled="true" title={m.held} onClick={(e) => e.preventDefault()} onChange={() => undefined}
              label={<>{m.label}<span className={styles.heldNote}>{m.held}</span></>} />
          ) : (
            <Checkbox key={m.key} checked={form.markets.includes(m.key)} onChange={() => toggleMarket(m.key)} label={m.label} />
          )))}
        </div>
      )}
    </fieldset>
  ) : null

  const table = shown && (
    <>
      <div className={styles.toolbar}>
        {filterOptions.length > 0
          ? <SegmentedControl ariaLabel="Show" size="sm" value={activeFilter} onChange={(v) => setFilter(v as LineFilter)} options={filterOptions} />
          : <span />}
        <span className={styles.muted}>{refreshing ? 'Updating…' : rows(tableRows.length)}</span>
      </div>
      <div className={styles.tableArea} aria-busy={refreshing || undefined}>
        <DataGrid ariaLabel={inForm ? 'What would change' : 'What was changed'} size="sm" keyboardScroll maxHeight={320}
          columns={inForm ? FORM_COLUMNS : DONE_COLUMNS} rows={tableRows} rowKey={(l) => l.id}
          emptyState={<EmptyState title="Nothing to show" description="None of these rows is on the chosen markets." />} />
      </div>
    </>
  )

  const notices = shown && inForm && (
    <>
      {shown.notices.map((n) => <Banner key={n} tone={n.startsWith('Preview') ? 'info' : 'warning'}>{n}</Banner>)}
      {!shown.undoable && <Banner tone="info">This cannot be undone once it is sent.</Banner>}
      {skipGroups.length > 0 && (
        <Disclosure summary={`${shown.skipped.toLocaleString('en')} skipped`}>
          <ul className={styles.list}>{skipGroups.map((g) => <li key={g.reason}>{skipGroupLine(g)}</li>)}</ul>
        </Disclosure>
      )}
    </>
  )

  const failureBanner = failure && <Banner tone="danger" title={failure.title}>{failure.message}</Banner>

  const body = inForm ? (
    <form id={formId} className={styles.form} onSubmit={onSubmit} noValidate>
      {failureBanner}
      <div className={styles.controls}>
        <div ref={changeRef} className={styles.change}>
          <Field label="Change">
            <Listbox size="sm" options={fieldOptions} value={form.field ?? undefined} onChange={chooseField} placeholder="Choose what to change" />
          </Field>
        </div>
        {field && field.modes.length > 1 && (
          <div className="nds-field-w">
            <span className="nds-field-lbl" aria-hidden="true">How</span>
            <SegmentedControl ariaLabel="How" size="sm" wrap value={form.mode ?? ''} onChange={chooseMode}
              options={field.modes.map((m) => ({ value: m.id, label: m.label }))} />
          </div>
        )}
        {valueControl}
        {mode?.hint && <p className={styles.hint} id={hintId}>{mode.hint}</p>}
      </div>
      {markets}
      <div className={styles.preview}>
        {pv.error && phase === 'form' && key !== null && <Banner tone="danger" title="The changes could not be worked out">{pv.error}</Banner>}
        {notices}
        {phase === 'form' && key === null ? (
          <div className={styles.prompt}>{previewPrompt({ field, kind, parsed, ticked: form.markets.length })}</div>
        ) : firstLoad ? (
          <div className={styles.loading} role="status" aria-label="Working out the changes">
            <Skeleton height={14} /><Skeleton height={14} width="90%" /><Skeleton height={14} width="75%" /><Skeleton height={14} width="85%" /><Skeleton height={14} width="60%" />
          </div>
        ) : table}
      </div>
      {confirmWord && <ConfirmPhraseField phrase={confirmWord} value={typed} onChange={(v) => { if (!locked) setTyped(v) }} />}
    </form>
  ) : (
    <>
      {failureBanner}
      {result && <Banner tone={receipt !== null ? 'success' : result.tone}>{receipt ?? result.sentence}</Banner>}
      <div className={styles.preview}>{table}</div>
    </>
  )

  const heldProps = (reason: string | null) => (reason !== null ? { 'aria-disabled': true, className: 'held', title: reason } : {})
  const undoing = phase === 'undoing'
  const footer = inForm ? (
    <>
      <span className={styles.status} role="status">{status}</span>
      <span className="grow" />
      <Button size="sm" variant="secondary" onClick={close} {...heldProps(locked ? 'Applying…' : null)}>Cancel</Button>
      <Button size="sm" variant="primary" type="submit" form={formId} title={held ?? applyLabel(current)} {...heldProps(held)}>
        {phase === 'applying' ? 'Applying…' : applyLabel(current)}
      </Button>
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
    <Modal open={open && source !== null} onClose={close} size="xl" title={source?.title} subtitle={source?.subtitle} footer={footer}>
      <div ref={bodyRef} className={styles.body}>{body}</div>
    </Modal>
  )
}
