'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Search } from 'lucide-react'
import { Banner, Card, EmptyState, Field, SummaryTable } from '@nexus/ui/components'
import { SizeGridEditor, type SizeGridIssue } from '@nexus/ui/grid/size-grid/index'
import { Button, Checkbox, Input, RadioCard, Spinner, Tag } from '@nexus/ui/primitives'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { StyleDetail } from '../../../quotes/api'
import { money, unitPrice } from '../../../quotes/model'
import { sizeGridWords } from '../../../quotes/record/view/grid-copy'
import type { Order } from '../../api'
import { badPrice, changeOf, draftGrid, draftGroups, namesOf, piecesOf, underWorkOrders, type DraftLine } from '../../daily-model'
import type { ComposerState, EditorActions } from '../record-model'

/** What the lines editor draws: an amendment of an order's lines, or the lines of a typed New order. */
export interface LinesEditorModel {
  mode: 'amend' | 'new'
  lines: DraftLine[]
  /** The order amended (names, prices as accepted, what work orders make); null for a typed order. */
  order: Order | null
  styles: Record<string, StyleDetail | null | undefined>
  composer: ComposerState
  price: boolean
  currency: string
  priceBasis: 'NET' | 'GROSS'
  /** Pieces work orders already make, by line and size. */
  minimums: Record<string, Record<string, number>>
  /** A typed order: each line's net and its resolved unit price, from the preview (by line key). */
  nets?: Record<string, number | undefined>
  listPrices?: Record<string, string | undefined>
  busy: boolean
}

/**
 * The lines editor (design `order.lines.cards` in amend mode, and the typed New order's Lines): "Add a style" (type a
 * style, pick its colours, Add: their rows open in its grid), then one card per style — the DS SizeGridEditor (keyboard,
 * paste, a cell a colour does not offer is blocked; a cell under what work orders already make says so) and each colour
 * line's pieces and unit price (price grain; empty = unchanged, or the customer's list price on a new line), with what
 * happens to it (added, changed, removed). A line closed short is shown, never edited (reopen it first).
 */
export function LinesEditor({ model, actions }: { model: LinesEditorModel; actions?: EditorActions }) {
  const t = useT('orders')
  const groups = draftGroups(model.lines)
  return (
    <div className="fw-so-stack">
      <Composer composer={model.composer} actions={actions} busy={model.busy} />
      {groups.length === 0 ? (
        <Card padded>
          <EmptyState title={t('editor.empty.title')} description={t(`editor.empty.${model.mode}`)} />
        </Card>
      ) : (
        groups.map((group) => <StyleCard key={group.styleId} styleId={group.styleId} lines={group.lines} model={model} actions={actions} />)
      )}
    </div>
  )
}

function Composer({ composer, actions, busy }: { composer: ComposerState; actions?: EditorActions; busy: boolean }) {
  const t = useT('orders')
  const [query, setQuery] = useState(composer.query)
  const typed = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  const cleared = composer.query === '' && composer.results === null && !composer.chosen
  useEffect(() => {
    if (cleared) setQuery('')
  }, [cleared])
  const search = useRef(actions?.onComposerQuery)
  search.current = actions?.onComposerQuery
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => search.current?.(query), 250)
    return () => clearTimeout(timer)
  }, [query])
  // n: the Style box, from anywhere on the page (not while typing, not inside a dialog).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.key !== 'n' || event.metaKey || event.ctrlKey || event.altKey) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') || target.isContentEditable)) return
      event.preventDefault()
      input.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const chosen = composer.chosen
  const held = !chosen ? t('editor.held.style') : composer.picked.length === 0 ? t('editor.held.colour') : busy ? t('held.busy') : null
  return (
    <Card padded className="fw-so-composer">
      <h2 className="fw-so-h2">{t('editor.add.title')}</h2>
      <Field label={t('editor.add.style')} hint={t('editor.add.styleHint')}>
        <Input
          ref={input}
          value={query}
          type="search"
          leadingIcon={<Search size={14} aria-hidden />}
          placeholder={t('editor.add.placeholder')}
          autoComplete="off"
          aria-keyshortcuts="n"
          onChange={(event) => {
            typed.current = true
            setQuery(event.target.value)
          }}
        />
      </Field>
      {composer.problem ? (
        <Banner tone="danger" title={t(composer.problem)} />
      ) : composer.searching && !chosen ? (
        <p className="fw-so-hint" role="status">
          <Spinner size={14} /> {t('editor.add.searching')}
        </p>
      ) : composer.results && !chosen ? (
        <fieldset className="fw-so-choices">
          <legend className="fw-so-legend" aria-live="polite">
            {composer.results.length === 0 ? t('editor.add.none') : t('editor.add.found', { count: composer.results.length })}
          </legend>
          {composer.results.map((style) => (
            <RadioCard
              key={style.id}
              variant="row"
              name="fw-so-style"
              value={style.id}
              checked={false}
              onChange={() => actions?.onComposerPick?.(style.id)}
              title={`${style.code} · ${style.name}`}
              description={
                <span className="fw-so-inline">
                  {style.season && <Tag>{style.season}</Tag>}
                  {style.revisionState !== 'RELEASED' && <Tag tone="warning">{t(style.revisionState === 'DRAFT' ? 'editor.add.estimate' : 'editor.add.noCost')}</Tag>}
                  <span className="fw-so-hint">{style.sizes.join(' · ')}</span>
                </span>
              }
            />
          ))}
        </fieldset>
      ) : null}
      {chosen && (
        <div className="fw-so-stack-tight">
          <div className="fw-so-card-head">
            <strong>
              {chosen.code} · {chosen.name}
            </strong>
            <Button size="sm" variant="quiet" onClick={() => actions?.onComposerPick?.(null)}>
              {t('editor.add.change')}
            </Button>
          </div>
          <fieldset className="fw-so-colours">
            <legend className="fw-so-legend">{t('editor.add.colours')}</legend>
            {chosen.colourways
              .filter((colourway) => colourway.status === 'ACTIVE')
              .map((colourway) => (
                <Checkbox
                  key={colourway.id}
                  checked={composer.picked.includes(colourway.id)}
                  onChange={() => actions?.onComposerToggle?.(colourway.id)}
                  label={
                    <span className="fw-so-inline">
                      {colourway.colour?.hex && <span className="fw-so-swatch" style={{ background: colourway.colour.hex }} aria-hidden />}
                      {colourway.code} · {colourway.name}
                    </span>
                  }
                />
              ))}
          </fieldset>
          <div>
            <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onComposerAdd?.()}>
              <Plus size={14} aria-hidden /> {t('editor.add.go', { count: composer.picked.length })}
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}

function StyleCard({ styleId, lines, model, actions }: { styleId: string; lines: DraftLine[]; model: LinesEditorModel; actions?: EditorActions }) {
  const t = useT('orders')
  const sales = useT('sales')
  const locale = useLocale()
  const style = model.styles[styleId]
  const copy = useMemo(() => sizeGridWords(sales), [sales])
  const grid = draftGrid(lines, style, model.order)
  const first = namesOf(lines[0]!, model.order, style)
  const name = style?.name ?? model.order?.lines.find((line) => line.styleId === styleId)?.style?.name ?? ''
  const under = underWorkOrders(lines, model.minimums)
  const issues: SizeGridIssue[] = under.map((cell) => ({ colour: cell.key, size: cell.size, tone: 'error', message: t('editor.underWorkOrders', { size: cell.size, made: cell.made }) }))
  const locked = lines.filter((line) => line.locked)
  const editable = lines.filter((line) => !line.locked)
  const columns = [t('lines.col.colour'), t('lines.col.pieces'), ...(model.price ? [t(model.priceBasis === 'GROSS' ? 'lines.col.unitGross' : 'lines.col.unitNet'), ...(model.nets ? [t('lines.col.net')] : [])] : []), t('editor.col.change')]
  const rows = editable.map((line) => {
    const names = namesOf(line, model.order, style)
    const change = changeOf(line, model.order)
    const own = line.lineId ? model.order?.lines.find((entry) => entry.id === line.lineId) : undefined
    const placeholder = line.lineId ? t('editor.priceKept') : model.listPrices?.[line.key] ? t('editor.priceList', { price: unitPrice(model.listPrices[line.key], model.currency, locale) }) : t('editor.priceListUnknown')
    return {
      id: line.key,
      cells: [
        <span key="c" className="fw-so-cell">
          {names.colour}
        </span>,
        String(piecesOf(line)),
        ...(model.price
          ? [
              <Input
                key="p"
                size="sm"
                fieldClassName="fw-so-price"
                inputMode="decimal"
                aria-label={t('editor.priceOf', { colour: names.colour })}
                value={line.price}
                placeholder={placeholder}
                aria-invalid={badPrice(line) || undefined}
                onChange={(event) => actions?.onPrice?.(line.key, event.target.value)}
              />,
              ...(model.nets ? [money(model.nets[line.key], model.currency, locale)] : []),
            ]
          : []),
        change ? (
          <Tag key="t" tone={change === 'removed' ? 'danger' : change === 'added' ? 'info' : 'warning'}>
            {t(`editor.change.${change}`)}
          </Tag>
        ) : own ? (
          <span key="t" className="fw-so-hint">
            {t('editor.change.none')}
          </span>
        ) : (
          <span key="t" className="fw-so-hint">
            {t('editor.change.empty')}
          </span>
        ),
      ],
    }
  })
  return (
    <Card padded className="fw-so-block">
      <div className="fw-so-card-head">
        <h2 className="fw-so-h3">
          {first.style} · {name}
        </h2>
        {style === undefined && (
          <span className="fw-so-hint" role="status">
            <Spinner size={12} /> {t('editor.styleReading')}
          </span>
        )}
        {style === null && <Tag tone="warning">{t('editor.styleUnread')}</Tag>}
      </div>
      {editable.length > 0 && (
        <div className="fw-so-gridbox">
          <SizeGridEditor
            colours={grid.colours}
            sizes={grid.sizes}
            value={grid.value}
            onChange={(next) => actions?.onCells?.(styleId, next)}
            issues={issues}
            caption={t('editor.gridCaption', { style: first.style })}
            locale={INTL_LOCALE[locale]}
            copy={copy}
          />
        </div>
      )}
      {editable.length > 0 && <SummaryTable label={t('editor.pricesOf', { style: first.style })} columns={columns} rows={rows} density="roomy" stackOnPhone align={columns.map((_, index) => (index === 0 ? 'left' : 'right'))} />}
      {locked.length > 0 && (
        <ul className="fw-so-list" aria-label={t('editor.lockedLabel')}>
          {locked.map((line) => {
            const own = model.order?.lines.find((entry) => entry.id === line.lineId)
            return (
              <li key={line.key}>
                {t(own?.closedShort ? 'editor.lockedClosed' : 'editor.lockedMtm', { colour: namesOf(line, model.order, style).colour, count: own?.closedShort?.quantity ?? 0 })}
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}
