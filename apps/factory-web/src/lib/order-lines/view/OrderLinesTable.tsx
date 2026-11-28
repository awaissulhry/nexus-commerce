'use client'

import type { CSSProperties, KeyboardEvent, ReactNode } from 'react'
import { Columns3, Copy, Hourglass, Plus, Undo2, X } from 'lucide-react'
import { Button, Input, Select } from '@nexus/ui/primitives'
import { useRoomWidth } from '../../order-cells/use-room-width'
import { roomOf, type Room } from '../../window-shell/model'
import { modelChoiceOf, modelGroupsOf, modeHeldOf, piecesOfRows, piecesTyped, priceHintOf, type LinePrices, type LineRow, type LinesMode, type ModelChoice, type ModelStyle, type NewDesignKind } from '../model'
import { cleanOwnValue, ownValueText } from '../own-columns/rules'
import { useCell, useHeldModel } from '../redraw'
import type { OwnColumn, OwnValue, RemovedLine } from '../schema'
import { useLinesWords, type LinesWords } from '../words'
import '../order-lines.css'

/**
 * owb-po3.2 — THE ONE LINES TABLE (design § 5zi B, § 5j; prototype portal.js `composeWin` rows, oplus.js): the same part in the New order
 * window, the portal order's Lines tab (web B, po6) and the office Lines tab (S2). Columns: Model · Material · Sizes · Pieces · the
 * record's own columns · Your price (ONLY when the host passes `prices`: no column, no key without money). A new line takes the model
 * and the material of the line above (the host's `onAdd`); the first one asks "Choose the model…" — nothing is chosen for you. Copy a
 * line · Take out → Put it back. In a narrow room (a phone, a docked panel) each line is one card with its fields. Tab and the arrows
 * move through the cells. Modes: draft (saves) · sent (reads, says why) · confirmed (typing makes an ASK: the host's `onAsk`) ·
 * shipped (reads: "It left the factory. A change now is a return."). Own values apply at once in every mode but shipped.
 * The trap "type then click": a field keeps what you typed while you are in it (`useCell`) and the rows wait while a pointer is down
 * (`useHeldModel`), so the first click after typing does its work and a Tab keeps the next field's keys. Draws what it is given.
 */

export interface OrderLinesModel {
  readonly rows: readonly LineRow[]
  readonly mode: LinesMode
  /** The record's own columns, in their order (drawn after Pieces). */
  readonly columns: readonly OwnColumn[]
  /** The Model cell's choices: the customer's styles (own label = Your designs) and the kinds of a new design. */
  readonly styles: readonly ModelStyle[]
  readonly kinds: readonly NewDesignKind[]
  /** Money: null = the reader has no price grain — no Your price column, no price anywhere. */
  readonly prices: LinePrices | null
  /** "Add a line" drew a row with nothing chosen yet (saved on its first pick). */
  readonly pending: boolean
  /** Lines taken out (DRAFT only): each comes back with "Put it back". */
  readonly removed: readonly RemovedLine[]
  /** Why nothing can be written now (words: a preview, offline), or null. */
  readonly writeHeld: string | null
  /** Rows being saved. */
  readonly saving: readonly string[]
  /** The "Columns · 3…" / "Add a column…" door is offered (the reader may change the record's columns). */
  readonly columnsDoor: boolean
  /** A line's refusal said on leaving its field (line id → words). */
  readonly refusals?: Readonly<Record<string, string>>
  /** The design index and the tests: the room as given; absent: measured (`useRoomWidth`). */
  readonly room?: Room
  /** The office reads its own word for a few keys (`office.<key>`: "Price", "Sent by the customer…"); absent: the portal's. */
  readonly door?: 'portal' | 'office'
}

/** The keys the office says in its own words. */
const OFFICE_KEYS: ReadonlySet<string> = new Set(['col.price', 'mode.sent', 'mode.confirmed', 'price.factory', 'price.aria'])

export type AskField = 'model' | 'material' | 'pieces'

export interface OrderLinesActions {
  /** A model picked: `rowId` null = the row "Add a line" drew. */
  readonly onModel?: (rowId: string | null, choice: ModelChoice) => void
  /** A Material picked: a colourway id or the line's Material option value ('' = not decided yet). */
  readonly onMaterial?: (rowId: string, value: string) => void
  /** "Add the material…": the host opens the line's options with a Material option. */
  readonly onAddMaterial?: (rowId: string) => void
  /** The Sizes cell: the host opens the line's sizes (a size run, made to measure, people, a size file). */
  readonly onSizes?: (rowId: string) => void
  /** A typed total (null = not given yet), on leaving the cell. */
  readonly onPieces?: (rowId: string, count: number | null) => void
  readonly onOwnValue?: (rowId: string, columnId: string, value: OwnValue['value'], version: number | null) => void
  /** Your price typed (money only), on leaving the cell: the host checks and saves it. */
  readonly onPrice?: (rowId: string, text: string) => void
  readonly onCopy?: (rowId: string) => void
  readonly onTakeOut?: (rowId: string) => void
  readonly onPutBack?: (lineId: string) => void
  readonly onAdd?: () => void
  readonly onDropPending?: () => void
  readonly onColumns?: () => void
  /** A refusal said on leaving a field (the host shows it under the line). */
  readonly onRefused?: (rowId: string, words: string) => void
  /** Confirmed: a typed change becomes an ask (web B wires it, po6); absent: a confirmed order reads. */
  readonly onAsk?: (rowId: string, field: AskField, value: string) => void
}

/** The arrow keys: ← → in a row, ↑ ↓ between rows (a text field keeps ← → for its caret; a list keeps ↑ ↓ for its choices). */
function moveInGrid(event: KeyboardEvent<HTMLDivElement>) {
  const target = event.target as HTMLElement
  const cell = target.closest<HTMLElement>('[data-cell]')
  if (!cell) return
  const [row, col] = (cell.dataset.cell ?? '0:0').split(':').map(Number) as [number, number]
  const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
  const listing = target.tagName === 'SELECT'
  let next: [number, number] | null = null
  if (event.key === 'ArrowLeft' && !typing) next = [row, col - 1]
  else if (event.key === 'ArrowRight' && !typing) next = [row, col + 1]
  else if (event.key === 'ArrowUp' && !listing) next = [row - 1, col]
  else if (event.key === 'ArrowDown' && !listing) next = [row + 1, col]
  if (!next) return
  const control = event.currentTarget.querySelector<HTMLElement>(`[data-cell="${next[0]}:${next[1]}"] :is(input, select, button)`)
  if (!control) return
  event.preventDefault()
  control.focus()
}

export function OrderLinesTable({ model: given, actions, foot }: { model: OrderLinesModel; actions?: OrderLinesActions; foot?: ReactNode }) {
  const own = useLinesWords()
  const model = useHeldModel(given)
  const words: LinesWords = model.door === 'office' ? { ...own, t: (key, params) => own.t(OFFICE_KEYS.has(key) ? `office.${key}` : key, params) } : own
  const { t } = words
  const measured = useRoomWidth(roomOf, 'wide')
  const room = model.room ?? measured.value
  const asks = model.mode === 'confirmed' && actions?.onAsk !== undefined
  const modeHeld = modeHeldOf(model.mode, asks)
  const lineHeld = model.writeHeld ?? (modeHeld ? t(modeHeld) : null)
  const ownHeld = model.writeHeld ?? (model.mode === 'shipped' ? t('mode.shipped') : null)
  const draft = model.mode === 'draft'
  const heads = [t('col.model'), t('col.material'), t('col.sizes'), t('col.pieces'), ...model.columns.map((column) => column.name), ...(model.prices ? [t('col.price')] : [])]
  const pieces = piecesOfRows(model.rows)
  const ctx: RowContext = { words, model, actions, lineHeld, ownHeld, draft, asks }
  return (
    <section ref={measured.ref} className={`fw-ol fw-ol-${room}`} aria-label={t('title')}>
      {modeHeld ? <p className="fw-ol-mode">{t(modeHeld)}</p> : null}
      {model.rows.length === 0 && !model.pending ? (
        <p className="fw-ol-quiet">{t('empty')}</p>
      ) : room === 'narrow' ? (
        <ul className="fw-ol-cards" aria-label={t('title')}>
          {model.rows.map((row, index) => (
            <li key={row.id} className={`fw-ol-card${model.saving.includes(row.id) ? ' is-saving' : ''}`} id={`line-${row.id}`}>
              <Cells ctx={ctx} row={row} index={index} card />
            </li>
          ))}
          {model.pending ? (
            <li className="fw-ol-card" id="line-new">
              <Cells ctx={ctx} row={null} index={model.rows.length} card />
            </li>
          ) : null}
        </ul>
      ) : (
        <div className="fw-ol-scroll">
          <div className="fw-ol-grid" role="grid" aria-label={t('title')} aria-rowcount={model.rows.length + (model.pending ? 1 : 0) + 1} style={{ '--fw-ol-rest': String(heads.length - 1) } as CSSProperties} onKeyDown={moveInGrid}>
            <div className="fw-ol-row fw-ol-head" role="row">
              <span role="columnheader" className="fw-ol-n">
                #
              </span>
              {heads.map((head, index) => (
                <span key={index} role="columnheader" className={index === 3 || (model.prices && index === heads.length - 1) ? 'fw-ol-num' : undefined}>
                  {head}
                </span>
              ))}
              <span role="columnheader" className="fw-ol-acts" />
            </div>
            {model.rows.map((row, index) => (
              <div key={row.id} role="row" id={`line-${row.id}`} className={`fw-ol-row${model.saving.includes(row.id) ? ' is-saving' : ''}`} aria-rowindex={index + 2}>
                <Cells ctx={ctx} row={row} index={index} />
              </div>
            ))}
            {model.pending ? (
              <div role="row" id="line-new" className="fw-ol-row" aria-rowindex={model.rows.length + 2}>
                <Cells ctx={ctx} row={null} index={model.rows.length} />
              </div>
            ) : null}
          </div>
        </div>
      )}
      <div className="fw-ol-foot">
        {draft ? (
          <Button size="sm" heldReason={model.writeHeld ?? (model.pending ? t('pending') : null)} onClick={() => actions?.onAdd?.()}>
            <Plus size={14} aria-hidden /> {t('add')}
          </Button>
        ) : null}
        {model.columnsDoor && model.mode !== 'shipped' ? (
          <Button size="sm" variant="quiet" heldReason={model.writeHeld} onClick={() => actions?.onColumns?.()}>
            <Columns3 size={14} aria-hidden /> {model.columns.length > 0 ? t('columns.some', { n: model.columns.length }) : t('columns.none')}
          </Button>
        ) : null}
        {foot}
        <span className="fw-ol-grow" />
        {model.rows.length > 0 ? <strong className="fw-ol-total">{t('total', { pieces: words.count(pieces) })}</strong> : null}
      </div>
      {draft && model.removed.length > 0 && actions?.onPutBack ? (
        <ul className="fw-ol-removed" aria-label={t('removed.title')}>
          {model.removed.slice(-3).map((line) => (
            <li key={line.id}>
              <span>{t('removed.line', { seq: line.seq, words: line.words || t('removed.noWords') })}</span>
              <Button size="sm" variant="quiet" heldReason={model.writeHeld} onClick={() => actions?.onPutBack?.(line.id)}>
                <Undo2 size={14} aria-hidden /> {t('putBack')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

interface RowContext {
  readonly words: LinesWords
  readonly model: OrderLinesModel
  readonly actions?: OrderLinesActions
  /** Why the line's own cells write nothing (words), or null. */
  readonly lineHeld: string | null
  /** Why the own values write nothing (words), or null. */
  readonly ownHeld: string | null
  readonly draft: boolean
  readonly asks: boolean
}

/** One line's cells: a grid row's cells, or a card's labelled fields (`card`). */
function Cells({ ctx, row, index, card = false }: { ctx: RowContext; row: LineRow | null; index: number; card?: boolean }) {
  const { words, model, actions, lineHeld, ownHeld, draft } = ctx
  const { t } = words
  const seq = row?.seq ?? index + 1
  const cell = (col: number) => `${index}:${col}`
  const label = (text: string) => (card ? <span className="fw-ol-label">{text}</span> : null)
  const refusal = row ? model.refusals?.[row.id] : undefined
  let col = 0
  return (
    <>
      {card ? (
        <span className="fw-ol-cardhead">
          <strong>{t('line', { seq })}</strong>
        </span>
      ) : (
        <span role="rowheader" className="fw-ol-n" aria-label={t('line', { seq })}>
          {seq}
        </span>
      )}
      <div role={card ? undefined : 'gridcell'} className="fw-ol-cell" data-cell={cell(col++)}>
        {label(t('col.model'))}
        <ModelCell ctx={ctx} row={row} seq={seq} />
        {refusal ? (
          <p className="fw-ol-refused" role="alert">
            {refusal}
          </p>
        ) : null}
      </div>
      <div role={card ? undefined : 'gridcell'} className="fw-ol-cell" data-cell={cell(col++)}>
        {label(t('col.material'))}
        {row ? <MaterialCell ctx={ctx} row={row} seq={seq} /> : <span className="fw-ol-quiet">—</span>}
      </div>
      <div role={card ? undefined : 'gridcell'} className="fw-ol-cell" data-cell={cell(col++)}>
        {label(t('col.sizes'))}
        {row ? (
          <button type="button" className="fw-ol-cellbtn" aria-haspopup="dialog" aria-label={`${t('col.sizes')} · ${t('line', { seq })}`} onClick={() => actions?.onSizes?.(row.id)}>
            {sizesWords(row, words) ?? <Later words={words} />}
          </button>
        ) : (
          <span className="fw-ol-quiet">—</span>
        )}
      </div>
      <div role={card ? undefined : 'gridcell'} className="fw-ol-cell fw-ol-num" data-cell={cell(col++)}>
        {label(t('col.pieces'))}
        {row ? <PiecesCell ctx={ctx} row={row} seq={seq} /> : <span className="fw-ol-quiet">—</span>}
      </div>
      {model.columns.map((column) => (
        <div key={column.id} role={card ? undefined : 'gridcell'} className="fw-ol-cell" data-cell={cell(col++)}>
          {label(column.name)}
          {row ? <OwnCell column={column} row={row} seq={seq} held={ownHeld} words={words} actions={actions} /> : <span className="fw-ol-quiet">—</span>}
        </div>
      ))}
      {model.prices ? (
        <div role={card ? undefined : 'gridcell'} className="fw-ol-cell fw-ol-num" data-cell={cell(col++)}>
          {label(t('col.price'))}
          {row ? <PriceCell prices={model.prices} row={row} seq={seq} held={draft ? lineHeld : t('price.frozen')} words={words} actions={actions} /> : <span className="fw-ol-quiet">—</span>}
        </div>
      ) : null}
      <div role={card ? undefined : 'gridcell'} className="fw-ol-acts" data-cell={cell(col++)}>
        {draft && row ? (
          <>
            {actions?.onCopy ? (
              <Button size="sm" variant="quiet" aria-label={t('copy', { seq })} heldReason={lineHeld} onClick={() => actions.onCopy?.(row.id)}>
                <Copy size={14} aria-hidden />
              </Button>
            ) : null}
            <Button size="sm" variant="quiet" aria-label={t('takeOut', { seq })} heldReason={lineHeld} onClick={() => actions?.onTakeOut?.(row.id)}>
              <X size={14} aria-hidden />
            </Button>
          </>
        ) : draft && !row ? (
          <Button size="sm" variant="quiet" aria-label={t('dropPending')} onClick={() => actions?.onDropPending?.()}>
            <X size={14} aria-hidden />
          </Button>
        ) : null}
      </div>
    </>
  )
}

function Later({ words }: { words: LinesWords }) {
  return (
    <span className="fw-ol-quiet">
      <Hourglass size={12} aria-hidden /> {words.t('later')}
    </span>
  )
}

/** The Sizes cell's words: the size run · made to measure · n people · in the size file; null = can come later. */
export function sizesWords(row: Pick<LineRow, 'sizes'>, words: Pick<LinesWords, 't'>): string | null {
  switch (row.sizes.mode) {
    case 'SIZES':
      return row.sizes.run
    case 'MTM':
      return row.sizes.people > 0 ? words.t('sizes.mtmPeople', { count: row.sizes.people }) : words.t('sizes.mtm')
    case 'PEOPLE':
      return words.t('sizes.people', { count: row.sizes.people })
    case 'FILE':
      return words.t('sizes.file')
    default:
      return null
  }
}

function ModelCell({ ctx, row, seq }: { ctx: RowContext; row: LineRow | null; seq: number }) {
  const { words, model, actions, lineHeld, draft, asks } = ctx
  const { t } = words
  // A catalogue line keeps its style (its model is fixed: take it out and add another to change it); a confirmed order asks.
  if (row?.model.fixed || (!draft && !asks)) return <span className="fw-ol-strong">{row?.model.words ?? (row?.model.kind === 'TEXT' ? t('model.text') : '—')}</span>
  const groups = modelGroupsOf(model.styles, model.kinds)
  const value = row?.model.value ?? ''
  // The line's own style or kind, when the catalogue read does not list it (never an empty select for a chosen model).
  const listed = groups.some((group) => group.options.some((option) => option.value === value))
  return (
    <Select
      value={value}
      aria-label={t('model.aria', { seq })}
      disabled={lineHeld !== null}
      className={value === '' ? 'fw-ol-open' : undefined}
      onChange={(event) => {
        const choice = modelChoiceOf(event.target.value)
        if (!choice) return
        if (draft) actions?.onModel?.(row?.id ?? null, choice)
        else if (row) actions?.onAsk?.(row.id, 'model', event.target.value)
      }}
    >
      {value === '' ? <option value="">{t('model.choose')}</option> : null}
      {value !== '' && !listed ? <option value={value}>{row?.model.words ?? value}</option> : null}
      {groups.map((group) => (
        <optgroup key={group.kind} label={t(group.key)}>
          {group.options.map((option) => (
            <option key={option.value} value={option.value}>
              {group.kind === 'NEW' ? t('model.new', { kind: option.words }) : group.kind === 'TEXT' ? t('model.text') : option.words}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  )
}

function MaterialCell({ ctx, row, seq }: { ctx: RowContext; row: LineRow; seq: number }) {
  const { words, actions, lineHeld, draft, asks } = ctx
  const { t } = words
  const material = row.material
  if (material.how === 'NONE') {
    if (row.model.kind === 'TEXT' || row.model.kind === null) return <span className="fw-ol-quiet">{material.words ?? '—'}</span>
    return draft ? (
      <Button size="sm" variant="quiet" heldReason={lineHeld} onClick={() => actions?.onAddMaterial?.(row.id)}>
        {material.words ?? t('material.add')}
      </Button>
    ) : (
      <span>{material.words ?? '—'}</span>
    )
  }
  if (!draft && !asks) return <span>{material.words ?? t('later')}</span>
  return (
    <Select
      value={material.value}
      aria-label={t('material.aria', { seq })}
      disabled={lineHeld !== null}
      className={material.value === '' ? 'fw-ol-open' : undefined}
      onChange={(event) => (draft ? actions?.onMaterial?.(row.id, event.target.value) : actions?.onAsk?.(row.id, 'material', event.target.value))}
    >
      <option value="">{t('material.open')}</option>
      {material.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.words}
        </option>
      ))}
    </Select>
  )
}

function PiecesCell({ ctx, row, seq }: { ctx: RowContext; row: LineRow; seq: number }) {
  const { words, actions, lineHeld, draft, asks } = ctx
  const { t } = words
  const value = row.pieces.count === null ? '' : String(row.pieces.count)
  const field = useCell(value, (text) => {
    const typed = piecesTyped(text)
    if ('problem' in typed) {
      field.onChange(value) // the value from before comes back; the refusal says what to type
      actions?.onRefused?.(row.id, t(typed.problem))
      return
    }
    if (draft) actions?.onPieces?.(row.id, typed.count)
    else actions?.onAsk?.(row.id, 'pieces', text.trim())
  })
  if (!row.pieces.typed || (!draft && !asks)) return <span>{row.pieces.count === null ? '—' : words.count(row.pieces.count)}</span>
  return (
    <Input
      value={field.text}
      inputMode="numeric"
      aria-label={t('pieces.aria', { seq })}
      disabled={lineHeld !== null}
      className="fw-ol-numin"
      onFocus={field.onFocus}
      onChange={(event) => field.onChange(event.target.value)}
      onBlur={field.onBlur}
      onKeyDown={(event) => {
        if (event.key === 'Escape') field.onEscape()
        if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
      }}
    />
  )
}

function OwnCell({ column, row, seq, held, words, actions }: { column: OwnColumn; row: LineRow; seq: number; held: string | null; words: LinesWords; actions?: OrderLinesActions }) {
  const { t } = words
  const value = ownValueText(row.own[column.id])
  const version = row.ownVersions[column.id] ?? null
  const save = (text: string) => {
    const clean = cleanOwnValue(column, text)
    if ('problem' in clean) {
      field.onChange(value)
      actions?.onRefused?.(row.id, `${column.name}: ${t(clean.problem)}`)
      return
    }
    actions?.onOwnValue?.(row.id, column.id, clean.value, version)
  }
  const field = useCell(value, save)
  const aria = t('own.aria', { name: column.name, seq })
  if (held !== null) return <span>{value === '' ? '—' : column.kind === 'YES_NO' ? t(value === 'yes' ? 'own.yes' : 'own.no') : value}</span>
  if (column.kind === 'YES_NO' || column.kind === 'CHOICE') {
    return (
      <Select value={value} aria-label={aria} onChange={(event) => save(event.target.value)}>
        <option value="">—</option>
        {column.kind === 'YES_NO' ? (
          <>
            <option value="yes">{t('own.yes')}</option>
            <option value="no">{t('own.no')}</option>
          </>
        ) : (
          column.choices.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))
        )}
      </Select>
    )
  }
  return (
    <Input
      value={field.text}
      type={column.kind === 'DATE' ? 'date' : 'text'}
      inputMode={column.kind === 'NUMBER' ? 'decimal' : undefined}
      aria-label={aria}
      onFocus={field.onFocus}
      onChange={(event) => field.onChange(event.target.value)}
      onBlur={field.onBlur}
      onKeyDown={(event) => {
        if (event.key === 'Escape') field.onEscape()
        if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
      }}
    />
  )
}

function PriceCell({ prices, row, seq, held, words, actions }: { prices: LinePrices; row: LineRow; seq: number; held: string | null; words: LinesWords; actions?: OrderLinesActions }) {
  const { t } = words
  const mine = prices.byLine[row.id]
  const hint = priceHintOf(row, mine)
  const field = useCell(mine?.own ?? '', (text) => actions?.onPrice?.(row.id, text))
  const hintWords = hint.kind === 'AGREED' ? t('price.agreed', { amount: words.money(hint.amount, prices.currency) ?? hint.amount }) : hint.kind === 'MATERIAL' ? t('price.material') : t('price.factory')
  return (
    <span className="fw-ol-price">
      {prices.edit && held === null ? (
        <Input
          value={field.text}
          inputMode="decimal"
          aria-label={t('price.aria', { seq })}
          placeholder={hint.kind === 'AGREED' ? hint.amount : ''}
          className="fw-ol-numin"
          onFocus={field.onFocus}
          onChange={(event) => field.onChange(event.target.value)}
          onBlur={field.onBlur}
          onKeyDown={(event) => {
            if (event.key === 'Escape') field.onEscape()
            if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
          }}
        />
      ) : (
        <span>{words.money(mine?.own ?? null, prices.currency) ?? '—'}</span>
      )}
      <span className={`fw-ol-hint${hint.kind === 'AGREED' ? ' is-ok' : ''}`}>{hintWords}</span>
    </span>
  )
}
