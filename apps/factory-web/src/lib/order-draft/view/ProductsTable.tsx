'use client'

import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { AlertTriangle, FileText, Hourglass, LayoutGrid, MoreHorizontal, Plus, Users } from 'lucide-react'
import { holdsSend } from '@nexus/factory-domain/sales/portal-ordering/rules'
import { Card, Menu, type MenuItemDef } from '@nexus/ui/components'
import { Button, Input, Select, Tag } from '@nexus/ui/primitives'
import { choiceWords, fromOrderText, problemWords, rowPiecesWords, rowProductOf, type ProductRow } from '../model'
import type { Sizing } from '../schema'
import { useDraftWords } from '../words'

/**
 * The products table (od-w1.2, R3; 10-design-r1 § 3): ONE row per product, the same part in both doors — # · Product · Sizing ·
 * Colour · Pieces · Options · Files · ⋯. Every cell is optional and edited in place; an empty cell reads "Not decided yet" (muted).
 * Product: the customer's words, or a style of the customer's catalogue (typing offers them; a catalogue row shows its style and the
 * "Catalogue" tag). Sizing: Standard sizes · Custom size · Not decided yet (a row with people stays a custom size: remove them first,
 * said in words). Colour: words, or the style's colourway. Pieces, Options and Files open a centred window. ⋯: Remove product.
 * "Add a product" draws an empty row here; it is saved on its first input. No price in any cell, ever (the rows are price-free).
 * Below 800 px the row takes two lines, on a phone a stacked card (a container query). Arrows move between cells (← → in a row, ↑ ↓
 * between rows); Enter edits a text cell or opens a window; Esc restores what a text cell held.
 */

export interface ProductsTableModel {
  rows: readonly ProductRow[]
  /** "Add a product" drew a row that is not saved yet (it saves on its first input). */
  pending: boolean
  /** Why nothing can be written now (words), or null (a sent draft: read only). */
  writeHeld: string | null
  /** The styles the Product cell offers (the customer's catalogue); null while not read. */
  styles: readonly { readonly id: string; readonly code: string; readonly name: string }[] | null
  /** Rows being saved. */
  saving: readonly string[]
}

/** A row's cell typed or picked: `rowId` null = the row "Add a product" drew (not saved yet). */
export interface ProductsTableActions {
  onProduct?: (rowId: string | null, value: { words: string } | { styleId: string }) => void
  onSizing?: (rowId: string | null, sizing: Sizing | null) => void
  onColour?: (rowId: string | null, value: { words: string } | { colourwayId: string }) => void
  onPieces?: (rowId: string) => void
  onOptions?: (rowId: string) => void
  onFiles?: (rowId: string) => void
  onRemove?: (rowId: string) => void
  onAdd?: () => void
  /** The empty row "Add a product" drew goes (nothing was saved). */
  onDropPending?: () => void
}

const COLS = ['product', 'sizing', 'colour', 'pieces', 'options', 'files', 'more'] as const

/** The table's arrow keys: ← → in a row, ↑ ↓ between rows (a text cell keeps ← → for its caret; a list keeps ↑ ↓ for its choices). */
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
  else if (event.key === 'Home' && !typing) next = [event.ctrlKey ? 0 : row, 0]
  else if (event.key === 'End' && !typing) next = [row, COLS.length - 1]
  if (!next) return
  const control = event.currentTarget.querySelector<HTMLElement>(`[data-cell="${next[0]}:${next[1]}"] :is(input, select, button)`)
  if (!control) return
  event.preventDefault()
  control.focus()
}

export function ProductsTable({ model, actions, below }: { model: ProductsTableModel; actions?: ProductsTableActions; below?: ReactNode }) {
  const { t } = useDraftWords()
  const count = model.rows.length
  return (
    <Card padded>
      <section className="fw-od-section" id="od-products" tabIndex={-1} aria-labelledby="od-products-title">
        <div className="fw-od-parthead">
          <h2 id="od-products-title" className="fw-od-h2">
            {t('tbl.title')}
          </h2>
          {count > 0 ? <Tag tone="neutral">{count === 1 ? t('tbl.count_one', { n: count }) : t('tbl.count_other', { n: count })}</Tag> : null}
        </div>
        <div className="fw-od-tablewrap">
          <div className="fw-od-table" role="grid" aria-labelledby="od-products-title" aria-rowcount={count + (model.pending ? 1 : 0) + 1} onKeyDown={moveInGrid}>
            <div className="fw-od-trow fw-od-thead" role="row">
              <span role="columnheader" className="fw-od-c-n">
                #
              </span>
              <span role="columnheader" className="fw-od-c-product">
                {t('col.product')}
              </span>
              <span role="columnheader" className="fw-od-c-sizing">
                {t('col.sizing')}
              </span>
              <span role="columnheader" className="fw-od-c-colour">
                {t('col.colour')}
              </span>
              <span role="columnheader" className="fw-od-c-pieces">
                {t('col.pieces')}
              </span>
              <span role="columnheader" className="fw-od-c-options">
                {t('col.options')}
              </span>
              <span role="columnheader" className="fw-od-c-files">
                {t('col.files')}
              </span>
              <span role="columnheader" className="fw-od-c-more" />
            </div>
            {model.rows.map((row, index) => (
              <Row key={row.id} index={index} row={row} model={model} actions={actions} />
            ))}
            {model.pending ? <Row index={count} row={null} model={model} actions={actions} /> : null}
            {count === 0 && !model.pending ? (
              <div className="fw-od-trow fw-od-tempty" role="row">
                <span role="gridcell" className="fw-od-quiet">
                  {t('tbl.empty')}
                </span>
              </div>
            ) : null}
          </div>
        </div>
        <div className="fw-od-tablefoot">
          {/* R1 point 5: "Add a product" draws a row here; nothing is saved until its first input. */}
          <Button size="sm" variant="secondary" heldReason={model.writeHeld ?? (model.pending ? t('save.notYet') : null)} onClick={() => actions?.onAdd?.()}>
            <Plus size={14} aria-hidden /> {t('add.product')}
          </Button>
          {below}
        </div>
      </section>
    </Card>
  )
}


function NotDecided() {
  const { t } = useDraftWords()
  return (
    <span className="fw-od-open">
      <Hourglass size={12} aria-hidden /> {t('state.OPEN')}
    </span>
  )
}

function Row({ index, row, model, actions }: { index: number; row: ProductRow | null; model: ProductsTableModel; actions?: ProductsTableActions }) {
  const words = useDraftWords()
  const { t, locale } = words
  const [peopleFirst, setPeopleFirst] = useState(false)
  const held = model.writeHeld
  const id = row?.id ?? null
  const seq = row?.seq ?? index + 1
  const product = row ? rowProductOf(row) : null
  const pieces = row ? rowPiecesWords(row.pieces, t, words.pieces) : null
  const styles = model.styles ?? []
  const styleLabel = (style: { code: string; name: string }) => `${style.code} · ${style.name}`
  const listId = `od-styles-${id ?? 'new'}`
  const kit = { t, price: () => null, locale }
  const cell = (col: (typeof COLS)[number]) => `${index}:${COLS.indexOf(col)}`
  const commitProduct = (typed: string) => {
    const text = typed.trim()
    if (text === (row?.words ?? '') || (row?.style && text === styleLabel(row.style))) return
    const style = styles.find((entry) => styleLabel(entry) === text)
    if (style) actions?.onProduct?.(id, { styleId: style.id })
    else if (text !== '' || row?.words) actions?.onProduct?.(id, { words: text })
  }
  const pickSizing = (value: string) => {
    const next: Sizing | null = value === 'STANDARD' || value === 'MADE_TO_MEASURE' ? value : null
    // R3: a row that has people stays by person — remove them first (in words, nothing is written).
    if (row && next !== 'MADE_TO_MEASURE' && row.pieces.mode === 'PEOPLE' && row.pieces.people > 0) {
      setPeopleFirst(true)
      return
    }
    setPeopleFirst(false)
    actions?.onSizing?.(id, next)
  }
  const more: MenuItemDef[] = [
    id
      ? { id: 'remove', label: t('row.remove'), disabled: held !== null, description: held ?? undefined, onSelect: () => actions?.onRemove?.(id) }
      : { id: 'remove', label: t('row.remove'), onSelect: () => actions?.onDropPending?.() },
  ]
  // A row not saved yet: its windows wait for its first input (they write the saved row). od-fx8 W-10: a reader opens them to READ
  // (read-only windows: no field, no save) — only writing is barred, never reading.
  const windowHeld = id ? null : t('save.notYet')
  return (
    <div className={`fw-od-trow${model.saving.includes(id ?? '') ? ' is-saving' : ''}`} role="row" id={id ? `row-${id}` : 'row-new'} aria-rowindex={index + 2}>
      <span role="rowheader" className="fw-od-c-n" aria-label={t('row.label', { seq })}>
        {seq}
      </span>
      <div role="gridcell" className="fw-od-c-product" data-cell={cell('product')}>
        {row?.catalogue && row.style ? (
          <span className="fw-od-product">
            <strong>{row.style.name}</strong>
            <span className="fw-od-productmeta">
              <Tag tone="info">{t('cell.catalogue')}</Tag> {row.style.code}
            </span>
            {/* od-fx2 (B-TH-304): a row copied from a past order says which — the customer's own number and PO, never SO-…. */}
            {row.from ? <span className="fw-od-productmeta">{fromOrderText(row.from, t, words.day)}</span> : null}
          </span>
        ) : (
          <>
            <Input
              key={`${id ?? 'new'}|${product ?? ''}`}
              defaultValue={product ?? ''}
              list={listId}
              aria-label={t('col.product')}
              placeholder={t('cell.productPh')}
              disabled={held !== null}
              autoFocus={id === null}
              onBlur={(event) => commitProduct(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
                if (event.key === 'Escape') (event.target as HTMLInputElement).value = product ?? ''
              }}
            />
            <datalist id={listId}>
              {styles.map((style) => (
                <option key={style.id} value={styleLabel(style)} />
              ))}
            </datalist>
          </>
        )}
        {/* od-fx8 W-14: nothing is required — a row says only an INVALID value (the domain's holdsSend); a missing one is Still open's. */}
        {row && row.problems.filter((problem) => !problem.personId && holdsSend(problem.code)).length > 0 ? (
          <ul className="fw-od-notes">
            {row.problems
              .filter((problem) => !problem.personId && holdsSend(problem.code))
              .map((problem, at) => (
                <li key={at} className="fw-od-note is-danger">
                  <AlertTriangle size={14} aria-hidden /> {problemWords(problem, [], kit)}
                </li>
              ))}
          </ul>
        ) : null}
      </div>
      <div role="gridcell" className="fw-od-c-sizing" data-cell={cell('sizing')}>
        <span className="fw-od-celllabel">{t('col.sizing')}</span>
        {/* od-fx8 W-12: the words alone (no icon beside the box): "Standard sizes", "Non ancora deciso" fit whole. */}
        <span className="fw-od-sizing">
          <Select value={row?.sizing ?? ''} aria-label={t('col.sizing')} aria-describedby={peopleFirst ? `od-siz-${id}` : undefined} disabled={held !== null} onChange={(event) => pickSizing(event.target.value)}>
            <option value="">{t('state.OPEN')}</option>
            <option value="STANDARD">{t('siz.STANDARD')}</option>
            <option value="MADE_TO_MEASURE">{t('siz.MADE_TO_MEASURE')}</option>
          </Select>
        </span>
        {peopleFirst ? (
          <p id={`od-siz-${id}`} className="fw-od-held" role="alert">
            {t('siz.peopleFirst')}
          </p>
        ) : null}
      </div>
      <div role="gridcell" className="fw-od-c-colour" data-cell={cell('colour')}>
        <span className="fw-od-celllabel">{t('col.colour')}</span>
        {row?.colours ? (
          <Select value={row.colourwayId ?? ''} aria-label={t('col.colour')} disabled={held !== null} onChange={(event) => (event.target.value ? actions?.onColour?.(id, { colourwayId: event.target.value }) : undefined)}>
            {row.colourwayId === null ? <option value="">{t('state.OPEN')}</option> : null}
            {row.colours.map((colour) => (
              <option key={colour.id} value={colour.id}>
                {colour.name}
              </option>
            ))}
          </Select>
        ) : (
          <Input
            key={`${id ?? 'new'}|${row?.colour ?? ''}`}
            defaultValue={row?.colour ?? ''}
            aria-label={t('col.colour')}
            placeholder={t('state.OPEN')}
            maxLength={200}
            disabled={held !== null}
            onBlur={(event) => (event.target.value.trim() !== (row?.colour ?? '') ? actions?.onColour?.(id, { words: event.target.value.trim() }) : undefined)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
              if (event.key === 'Escape') (event.target as HTMLInputElement).value = row?.colour ?? ''
            }}
          />
        )}
      </div>
      <div role="gridcell" className="fw-od-c-pieces" data-cell={cell('pieces')}>
        <span className="fw-od-celllabel">{t('col.pieces')}</span>
        <button type="button" className="fw-od-cellbtn" aria-haspopup="dialog" aria-disabled={windowHeld !== null || undefined} title={windowHeld ?? undefined} onClick={() => (id && windowHeld === null ? actions?.onPieces?.(id) : undefined)}>
          {pieces ? (
            <span className="fw-od-pieces">
              <span>
                {row?.pieces.mode === 'PEOPLE' ? <Users size={14} aria-hidden /> : <LayoutGrid size={14} aria-hidden />} {pieces.main}
              </span>
              {pieces.sizes ? <span className="fw-od-quiet">{pieces.sizes}</span> : null}
            </span>
          ) : (
            <NotDecided />
          )}
        </button>
      </div>
      <div role="gridcell" className="fw-od-c-options" data-cell={cell('options')}>
        <span className="fw-od-celllabel">{t('col.options')}</span>
        <button type="button" className="fw-od-cellbtn" aria-haspopup="dialog" aria-label={`${t('col.options')} · ${t('row.label', { seq })}`} aria-disabled={windowHeld !== null || undefined} title={windowHeld ?? undefined} onClick={() => (id && windowHeld === null ? actions?.onOptions?.(id) : undefined)}>
          {row && row.choices.length > 0 ? (
            <span className="fw-od-chips">
              {row.choices.map((choice) => (
                <span key={choice.topic} className={`fw-od-chip${choice.picked ? '' : ' is-open'}`}>
                  {choice.picked ? null : <Hourglass size={12} aria-hidden />} {choiceWords(choice, t)}
                </span>
              ))}
            </span>
          ) : (
            <span className="fw-od-quiet">—</span>
          )}
        </button>
      </div>
      <div role="gridcell" className="fw-od-c-files" data-cell={cell('files')}>
        <span className="fw-od-celllabel">{t('col.files')}</span>
        <button
          type="button"
          className="fw-od-cellbtn"
          aria-haspopup="dialog"
          aria-label={row && row.files.length > 0 ? t('cell.files', { count: row.files.length }) : `${t('col.files')} · ${t('row.label', { seq })}`}
          aria-disabled={windowHeld !== null || undefined}
          title={windowHeld ?? undefined}
          onClick={() => (id && windowHeld === null ? actions?.onFiles?.(id) : undefined)}
        >
          {row && row.files.length > 0 ? (
            <span>
              <FileText size={14} aria-hidden /> {row.files.length}
            </span>
          ) : (
            <span className="fw-od-quiet">—</span>
          )}
        </button>
      </div>
      <div role="gridcell" className="fw-od-c-more" data-cell={cell('more')}>
        <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('col.more', { seq }) }} items={more} />
      </div>
    </div>
  )
}
