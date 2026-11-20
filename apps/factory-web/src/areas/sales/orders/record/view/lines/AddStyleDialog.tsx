'use client'

import { useEffect, useRef, useState } from 'react'
import { Plus, Search } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, Input, RadioCard, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../../lib/i18n/provider'
import type { StyleDetail } from '../../../../quotes/api'
import type { Order } from '../../../api'
import type { LinesDraft } from '../../lines-draft'
import type { AddStyleState, LinesTabActions } from '../../lines-tab-model'
import { rowName } from './StyleTable'
import type { StyleCardModel } from '../../lines-table'

/**
 * F-OL-04 (Order LINES lane; 11-design-dialogs D-a as settled by 18-lead-settles F1, F24) — "Add a style": the ORDER's own search
 * (`?forOrder`: our collection and THIS customer's own styles only — another customer's style is never listed), a style picked, its
 * active colours ticked; a colour already on the order cannot be ticked (said beside it); for Sales a colour no price list prices for
 * this customer is held in the dialog ("someone who sees prices adds it"). The new rows land at the end of the style's card, tagged
 * New, their first box focused: the pieces are typed in the table, never here. Fetches nothing (the container searches).
 */
export function AddStyleDialog({ order, draft, state, seesPrices, actions }: { order: Order; draft: LinesDraft; state: AddStyleState; seesPrices: boolean; actions?: LinesTabActions }) {
  const t = useT('orders')
  const [query, setQuery] = useState(state.query)
  const typed = useRef(false)
  const search = useRef(actions?.onAddStyleQuery)
  search.current = actions?.onAddStyleQuery
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => search.current?.(query), 250)
    return () => clearTimeout(timer)
  }, [query])
  const customer = order.party?.legalName ?? ''
  const chosen = state.chosen
  const have = new Set([...order.lines.map((line) => `${line.styleId}:${line.colourwayId}`), ...draft.added.map((line) => `${line.styleId}:${line.colourwayId}`)])
  const listOf = (colourwayId: string) => state.row?.colourways?.find((entry) => entry.id === colourwayId)?.listPriced
  const holdOf = (styleId: string, colourwayId: string): string | null => (have.has(`${styleId}:${colourwayId}`) ? t('lines.addStyle.already') : !seesPrices && listOf(colourwayId) === false ? t('lines.addStyle.noList', { customer }) : null)
  const picked = chosen ? state.picked.filter((id) => !holdOf(chosen.id, id)) : []
  const held = !chosen ? t('editor.held.style') : picked.length === 0 ? t('editor.held.colour') : null
  return (
    <Modal
      open
      onClose={() => actions?.onAddStyleClose?.()}
      title={t('lines.addStyle.title', { number: order.number })}
      size="lg"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onAddStyleClose?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onAddStyleAdd?.()}>
            <Plus size={14} aria-hidden /> {t('editor.add.go', { count: picked.length })}
          </Button>
        </>
      }
    >
      <div className="fw-so-dialog">
        <Field label={t('editor.add.style')} hint={t('lines.addStyle.scope', { customer })}>
          <Input
            value={query}
            type="search"
            autoFocus
            leadingIcon={<Search size={14} aria-hidden />}
            placeholder={t('editor.add.placeholder')}
            autoComplete="off"
            onChange={(event) => {
              typed.current = true
              setQuery(event.target.value)
            }}
          />
        </Field>
        {state.problem ? (
          <Banner tone="danger" title={t(state.problem.key, state.problem.params)} />
        ) : state.searching && !state.row ? (
          <p className="fw-so-hint" role="status">
            <Spinner size={14} /> {t('editor.add.searching')}
          </p>
        ) : state.results && !state.row ? (
          <fieldset className="fw-so-choices">
            <legend className="fw-so-legend" aria-live="polite">
              {state.results.length === 0 ? t('editor.add.none') : t('editor.add.found', { count: state.results.length })}
            </legend>
            {state.results.map((style) => (
              <RadioCard
                key={style.id}
                variant="row"
                name={`fw-lt-style-${order.id}`}
                value={style.id}
                checked={false}
                onChange={() => actions?.onAddStylePick?.(style)}
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
        {state.row && (
          <div className="fw-so-stack-tight">
            <div className="fw-so-card-head">
              <strong>
                {state.row.code} · {state.row.name}
              </strong>
              <Button size="sm" variant="quiet" onClick={() => actions?.onAddStylePick?.(null)}>
                {t('editor.add.change')}
              </Button>
            </div>
            {!chosen ? (
              <p className="fw-so-hint" role="status">
                <Spinner size={12} /> {t('editor.styleReading')}
              </p>
            ) : (
              <fieldset className="fw-so-colours">
                <legend className="fw-so-legend">{t('editor.add.colours')}</legend>
                {chosen.colourways
                  .filter((colourway) => colourway.status === 'ACTIVE')
                  .map((colourway) => {
                    const hold = holdOf(chosen.id, colourway.id)
                    return (
                      <span key={colourway.id} className="fw-so-stack-tight">
                        <Checkbox
                          checked={!hold && state.picked.includes(colourway.id)}
                          disabled={!!hold}
                          onChange={() => actions?.onAddStyleToggle?.(colourway.id)}
                          label={
                            <span className="fw-so-inline">
                              {colourway.colour?.hex && <span className="fw-so-swatch" style={{ background: colourway.colour.hex }} aria-hidden />}
                              {colourway.code} · {colourway.name}
                            </span>
                          }
                        />
                        {hold && <span className="fw-so-hint">{hold}</span>}
                      </span>
                    )
                  })}
              </fieldset>
            )}
            <p className="fw-so-hint">{t('lines.addStyle.after')}</p>
          </div>
        )}
      </div>
    </Modal>
  )
}

/**
 * F-OL-04 (Order LINES lane; preview frame E8) — "+ Add a colour" of one card: a colour of the style not on the order yet, and "Copy the
 * sizes of: {colour}" (any colour row of the card; nothing: an empty row). The row lands at the end of the card, its first box focused.
 */
export function AddColourDialog({ card, style, actions }: { card: StyleCardModel; style: StyleDetail | null | undefined; actions?: LinesTabActions }) {
  const t = useT('orders')
  const [colourwayId, setColourwayId] = useState<string | null>(null)
  const [copyFrom, setCopyFrom] = useState('')
  const taken = new Set(card.rows.map((row) => (row.kind === 'line' ? row.line.colourwayId : row.row.colourwayId)))
  const free = (style?.colourways ?? []).filter((colourway) => colourway.status === 'ACTIVE' && !taken.has(colourway.id))
  const held = !style ? t('editor.styleReading') : !colourwayId ? t('lines.addColourPick') : null
  return (
    <Modal
      open
      onClose={() => actions?.onAddColourOpen?.(null)}
      title={t('lines.addColourTitle', { style: card.code })}
      size="sm"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onAddColourOpen?.(null)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => colourwayId && actions?.onAddColour?.(card.styleId, colourwayId, copyFrom || null)}>
            <Plus size={14} aria-hidden /> {t('lines.addColourGo')}
          </Button>
        </>
      }
    >
      <div className="fw-so-dialog">
        {style === undefined ? (
          <p className="fw-so-hint" role="status">
            <Spinner size={12} /> {t('editor.styleReading')}
          </p>
        ) : style === null ? (
          <Banner tone="warning" title={t('editor.styleUnread')} />
        ) : free.length === 0 ? (
          <p className="fw-so-hint">{t('lines.addColourNone')}</p>
        ) : (
          <>
            <fieldset className="fw-so-choices">
              <legend className="fw-so-legend">{t('lines.col.colour')}</legend>
              {free.map((colourway) => (
                <RadioCard key={colourway.id} variant="row" name={`fw-lt-colour-${card.styleId}`} value={colourway.id} checked={colourwayId === colourway.id} selected={colourwayId === colourway.id} onChange={() => setColourwayId(colourway.id)} title={`${colourway.code} · ${colourway.name}`} />
              ))}
            </fieldset>
            <Field label={t('lines.addColourCopy')}>
              <Select value={copyFrom} onChange={(event) => setCopyFrom(event.target.value)}>
                <option value="">{t('lines.addColourEmpty')}</option>
                {card.rows
                  .filter((row) => !(row.kind === 'line' && (row.removed || row.line.kind !== 'SIZE_GRID')))
                  .map((row) => (
                    <option key={row.key} value={row.key}>
                      {rowName(row)}
                    </option>
                  ))}
              </Select>
            </Field>
          </>
        )}
      </div>
    </Modal>
  )
}
