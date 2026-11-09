'use client'

import type { KeyboardEvent, ReactNode } from 'react'
import { Shirt } from 'lucide-react'
import { Card } from '@nexus/ui/components'
import { Button, Checkbox, Pill } from '@nexus/ui/primitives'
import type { StyleCard } from '../api'
import { isPpe, ppeWords, styleName, typeKey } from '../model'
import { useOrderingWords } from '../../neworder/words'
import '../catalogue.css'

/**
 * One style as a card (design portal.customer.catalogue sec:styles "Card: image · name · code · colour swatches · size range
 * · certificate class pill · your price"; the style picker's cards): shared by the Catalogue and New order's "Add styles".
 * COMPOSED from the DS Card, Pill and Button: the DS MediaCard names its controls in English ("Inspect", "Select", "No
 * preview available") and needs a picture, and the portal has none yet (no style photo is partner-readable — a gap).
 */

export interface StyleCardProps {
  style: StyleCard
  currency: string
  seesPrices: boolean
  /** The card's name opens the style (the detail, or its own address). */
  onOpen?: () => void
  /** "Add to order" (held with its reason). */
  add?: { heldReason: string | null; onAdd?: () => void } | null
  /** The picker: the card is chosen with its box or Space. */
  select?: { selected: boolean; onToggle: () => void } | null
  /** The style sheet in a new tab (tab:style-sheet). */
  sheetHref?: string | null
  extra?: ReactNode
}

export function StyleCardView({ style, currency, seesPrices, onOpen, add, select, sheetHref, extra }: StyleCardProps) {
  const words = useOrderingWords()
  const { t, locale } = words
  const name = styleName(style, locale)
  const price = seesPrices ? words.price(style.priceFrom, currency) : null
  const onKey = (event: KeyboardEvent<HTMLElement>) => {
    if (!select || event.target !== event.currentTarget) return
    if (event.key === ' ') {
      event.preventDefault()
      select.onToggle()
    }
  }
  return (
    <Card className={select?.selected ? 'fw-pcat-card is-selected' : 'fw-pcat-card'} tabIndex={select ? 0 : undefined} onKeyDown={onKey} aria-label={select ? t('picker.cardLabel', { code: style.code, name }) : undefined}>
      <div className="fw-pcat-photo" aria-hidden>
        <Shirt size={32} />
        <span>{t('card.noPhoto')}</span>
      </div>
      <div className="fw-pcat-body">
        <div className="fw-pcat-head">
          {select ? <Checkbox checked={select.selected} onChange={() => select.onToggle()} aria-label={t('picker.choose', { code: style.code })} /> : null}
          <div className="fw-pcat-title">
            {onOpen ? (
              <button type="button" className="fw-pcat-name" onClick={onOpen}>
                {name}
              </button>
            ) : (
              <span className="fw-pcat-name">{name}</span>
            )}
            <span className="fw-pcat-code">{style.code}</span>
          </div>
        </div>
        <div className="fw-pcat-pills">
          <Pill tone={style.ownLabel ? 'info' : 'neutral'}>{style.ownLabel ? t('card.ownLabel') : t('card.openRange')}</Pill>
          <Pill tone={isPpe(style.ppe.category) ? 'warning' : 'neutral'}>{ppeWords(style.ppe, t)}</Pill>
        </div>
        <dl className="fw-pcat-facts">
          <div>
            <dt>{t('card.type')}</dt>
            <dd>{t(typeKey(style.productType))}{style.season ? ` · ${style.season}` : ''}</dd>
          </div>
          <div>
            <dt>{t('card.colours', { count: style.colours.length })}</dt>
            <dd className="fw-pcat-colours">{style.colours.map((colour) => colour.name).join(' · ') || '—'}</dd>
          </div>
          <div>
            <dt>{t('card.sizes')}</dt>
            <dd>{style.range || '—'}</dd>
          </div>
        </dl>
        {price ? <p className="fw-pcat-price">{t('card.from', { price })}</p> : null}
        {extra}
        {add || sheetHref ? (
          <div className="fw-pcat-actions">
            {sheetHref ? (
              <Button size="sm" variant="quiet" asChild>
                <a href={sheetHref} target="_blank" rel="noopener">
                  {t('card.sheet')}
                </a>
              </Button>
            ) : null}
            {add ? (
              <Button size="sm" variant="secondary" heldReason={add.heldReason} onClick={() => add.onAdd?.()}>
                {t('card.add')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  )
}
