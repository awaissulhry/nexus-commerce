'use client'

import { useMemo } from 'react'
import { AlertTriangle, Info, MoreHorizontal, Plus, ShoppingBag } from 'lucide-react'
import { Card, EmptyState, Menu, type MenuItemDef } from '@nexus/ui/components'
import { SizeGridEditor, type SizeGridCopy } from '@nexus/ui/grid/size-grid/index'
import { Button, Input, Select } from '@nexus/ui/primitives'
import { Field } from '@nexus/ui/components'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import type { DraftLine, DraftRecord } from '../api'
import { columnsOf, noticeTone, noticeWords, piecesOfCells, problemWords, type Cells } from '../model'
import { useOrderingWords, type OrderingWords } from '../words'

/**
 * sec:lines (design portal.customer.neworder "One line per style and colourway, with the whole size run in one grid"): each
 * line a card — the style (our code, name, your code), the colourway (offered colours only), the DS SizeGridEditor (the
 * sizes offered; stacked on a phone, `layout="auto"`; arrows between cells, Enter down, Esc restores; a block pasted from a
 * spreadsheet), pieces, the unit price from the customer's list and the line amount (price grain only), the line's
 * problems and a reorder's differences in our words, ⋯ Remove line (with Undo). Empty: "No lines yet…".
 */

export interface LinesModel {
  record: DraftRecord
  /** Typed sizes not saved yet, by line. */
  cells: Readonly<Record<string, Cells>>
  /** Typed notes not saved yet, by line. */
  notes: Readonly<Record<string, string>>
  /** Lines being saved. */
  saving: readonly string[]
  /** Why nothing can be written now (words), or null. */
  writeHeld: string | null
}

export interface LinesActions {
  onCells?: (lineId: string, cells: Record<string, number>) => void
  /** Focus left the line: save what was typed. */
  onLeave?: (lineId: string) => void
  onNote?: (lineId: string, note: string) => void
  onColour?: (lineId: string, colourwayId: string) => void
  onRemove?: (lineId: string) => void
  /** Leave a size no longer offered out of the line (and save it). */
  onDropSize?: (lineId: string, size: string) => void
  onAddStyles?: () => void
}

/** The DS size grid's words in the page's language (this catalogue's `size.*`, the stacked layout's from ds-words). */
export function useSizeCopy(t: OrderingWords['t']): Partial<SizeGridCopy> {
  const ds = useDsWords()
  return useMemo(
    () => ({
      caption: t('size.caption'),
      colourHeader: t('size.colour'),
      totalHeader: t('size.total'),
      cellName: (colour, size) => t('size.cellName', { colour, size }),
      notOffered: t('size.notOffered'),
      empty: t('size.empty'),
      totalsAnnouncement: ({ colour, rowTotal, size, columnTotal, grand }) => t('size.totals', { colour, rowTotal, size, columnTotal, grand }),
      notWhole: (cell, max) => t('size.notWhole', { cell, max }),
      cutToMax: (cell, max) => t('size.cutToMax', { cell, max }),
      pasteResult: ({ applied, notOffered, outside, invalid, clamped }) => t('size.pasted', { applied, skipped: notOffered + outside + invalid + clamped }),
      issuesHeading: t('size.issues'),
      ...ds.sizeGridStacked,
    }),
    [t, ds.sizeGridStacked],
  )
}

export function LinesSection({ model, actions }: { model: LinesModel; actions?: LinesActions }) {
  const words = useOrderingWords()
  const { t } = words
  const request = model.record.request
  return (
    <section className="fw-pno-section" id="lines" tabIndex={-1} aria-labelledby="lines-title">
      <div className="fw-pno-headrow">
        <h2 id="lines-title" className="fw-pno-h2">
          {t('lines.title', { count: request.lines.length })}
        </h2>
        <Button size="sm" variant="secondary" heldReason={model.writeHeld} onClick={() => actions?.onAddStyles?.()}>
          <Plus size={14} aria-hidden /> {t('lines.addStyles')}
        </Button>
      </div>
      {request.lines.length === 0 ? (
        <EmptyState icon={<ShoppingBag size={24} aria-hidden />} title={t('lines.empty')} description={t('lines.emptyBody')} />
      ) : (
        <ol className="fw-pno-lines">
          {request.lines.map((line) => (
            <li key={line.id}>
              <LineCard line={line} model={model} actions={actions} />
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function LineCard({ line, model, actions }: { line: DraftLine; model: LinesModel; actions?: LinesActions }) {
  const words = useOrderingWords()
  const { t, locale } = words
  const copy = useSizeCopy(t)
  const record = model.record
  const currency = record.request.currency
  const typed = model.cells[line.id]
  const cells: Cells = typed ?? Object.fromEntries(line.sizes.map((row) => [row.size, row.quantity]))
  const columns = columnsOf(line)
  const kit = { t, price: (value: string | null | undefined) => words.price(value, currency) }
  const shownPieces = piecesOfCells(cells)
  const unit = words.price(line.unitPriceShown, currency)
  const amount = typed ? (line.unitPriceShown ? words.price((Number(line.unitPriceShown) * shownPieces).toFixed(2), currency) : null) : words.price(line.amount, currency)
  // A size no longer offered has no cell to type into: its problem says so with "Leave size 62 out".
  const lineProblems = line.problems
  const discontinued = line.problems.some((problem) => problem.code === 'COLOUR_DISCONTINUED')
  const empty = shownPieces === 0
  const more: MenuItemDef[] = [{ id: 'remove', label: t('lines.remove'), disabled: model.writeHeld !== null, description: model.writeHeld ?? undefined, onSelect: () => actions?.onRemove?.(line.id) }]
  const title = `${line.style.code} · ${line.style.name}`
  return (
    <Card padded>
      <div
        className="fw-pno-line"
        id={`line-${line.id}`}
        tabIndex={-1}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) actions?.onLeave?.(line.id)
        }}
      >
        <div className="fw-pno-linehead">
          <div className="fw-pno-linetitle">
            <span className="fw-pno-linename">{t('lines.lineTitle', { seq: line.seq, title })}</span>
            <span className="fw-pno-quiet">
              {line.colourway.name} ({line.colourway.code})
              {line.source ? ` · ${line.source.customerRef ? t('lines.fromOrderRef', { order: line.source.orderNumber, ref: line.source.customerRef }) : t('lines.fromOrder', { order: line.source.orderNumber })}` : ''}
            </span>
          </div>
          <div className="fw-pno-lineactions">
            {line.colours.length > 1 || discontinued ? (
              <Field label={t('lines.colour')}>
                <Select value={line.colourway.id} disabled={model.writeHeld !== null} onChange={(event) => actions?.onColour?.(line.id, event.target.value)}>
                  {discontinued && !line.colours.some((colour) => colour.id === line.colourway.id) ? <option value={line.colourway.id}>{t('lines.colourGone', { colour: line.colourway.name })}</option> : null}
                  {line.colours.map((colour) => (
                    <option key={colour.id} value={colour.id}>
                      {colour.name} ({colour.code})
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('lines.menu', { seq: line.seq }) }} items={more} />
          </div>
        </div>
        {line.notices.length > 0 || lineProblems.length > 0 ? (
          <ul className="fw-pno-notes">
            {lineProblems.map((problem, index) => (
              <li key={`p${index}`} className="fw-pno-note is-danger">
                <AlertTriangle size={14} aria-hidden /> {problemWords(problem, record.request.lines, kit)}
                {problem.code === 'SIZE_NOT_OFFERED' && problem.size ? (
                  <Button size="sm" variant="quiet" heldReason={model.writeHeld} onClick={() => actions?.onDropSize?.(line.id, problem.size!)}>
                    {t('lines.dropSize', { size: problem.size })}
                  </Button>
                ) : null}
              </li>
            ))}
            {line.notices
              .filter((notice) => notice.code !== 'PRICE_CHANGED' || !line.problems.some((problem) => problem.code === 'PRICE_CHANGED'))
              .map((notice, index) => (
                <li key={`n${index}`} className={`fw-pno-note is-${noticeTone(notice.code)}`}>
                  <Info size={14} aria-hidden /> {noticeWords(notice.code, { style: line.style.code, colour: line.colourway.name, priceNow: line.priceNow, priceThen: line.unitPriceShown }, kit)}
                </li>
              ))}
          </ul>
        ) : null}
        <SizeGridEditor
          layout="auto"
          colours={[{ key: line.id, label: line.colourway.name, offered: line.offered }]}
          sizes={columns.map((size) => ({ key: size, label: size }))}
          value={{ [line.id]: cells }}
          onChange={(next) => actions?.onCells?.(line.id, { ...(next[line.id] ?? {}) })}
          issues={empty ? [{ colour: line.id, message: t('lines.held.empty'), tone: 'warning' as const }] : []}
          caption={t('lines.gridCaption', { title, colour: line.colourway.name })}
          locale={INTL_LOCALE[locale]}
          copy={copy}
        />
        <div className="fw-pno-linefoot">
          <Field label={t('lines.note')} hint={t('lines.noteHint')}>
            <Input value={model.notes[line.id] ?? line.note ?? ''} maxLength={1000} disabled={model.writeHeld !== null} onChange={(event) => actions?.onNote?.(line.id, event.target.value)} />
          </Field>
          <dl className="fw-pno-figures">
            <div>
              <dt>{t('lines.pieces')}</dt>
              <dd>{words.pieces(shownPieces)}</dd>
            </div>
            {record.seesPrices ? (
              <>
                <div>
                  <dt>{t('lines.unitPrice')}</dt>
                  <dd>{unit ?? '—'}</dd>
                </div>
                <div>
                  <dt>{t('lines.amount')}</dt>
                  <dd>{amount ?? '—'}</dd>
                </div>
              </>
            ) : null}
          </dl>
        </div>
        {model.saving.includes(line.id) ? <p className="fw-pno-quiet" role="status">{t('state.saving')}</p> : null}
      </div>
    </Card>
  )
}
