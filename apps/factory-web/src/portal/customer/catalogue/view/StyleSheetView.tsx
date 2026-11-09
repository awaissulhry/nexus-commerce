'use client'

import { Printer } from 'lucide-react'
import { KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import type { StyleDetail } from '../api'
import { ppeKey, sizeMatrix, styleName, typeKey } from '../model'
import { useOrderingWords } from '../../neworder/words'
import { Loading, ReadFailed } from '../../neworder/view/parts'
import '../catalogue.css'

/**
 * tab:style-sheet (design portal.customer.neworder "Style sheet PDF from the picker — reading beside the draft"): one style
 * on one sheet in its own tab, to read beside the draft or to print and save as PDF from the browser (no PDF is made by the
 * API for a style: the page is the sheet). Prices only with the price grain. Made from the same read as the detail.
 */

export interface StyleSheetModel {
  state: 'loading' | 'error' | 'missing' | 'ready'
  detail: StyleDetail | null
  /** The customer's organisation (on the sheet's head). */
  partyName: string
  printedAt: string
}

export function StyleSheetView({ model, onRetry }: { model: StyleSheetModel; onRetry?: () => void }) {
  const words = useOrderingWords()
  const { t, locale } = words
  if (model.state === 'loading') return <Loading rows={4} />
  if (model.state !== 'ready' || !model.detail) return <ReadFailed title={model.state === 'missing' ? t('detail.missing') : t('detail.failed')} onRetry={model.state === 'error' ? onRetry : undefined} />
  const { style, seesPrices, currency } = model.detail
  const matrix = sizeMatrix(style)
  return (
    <article className="fw-pcat-sheet" aria-labelledby="sheet-title">
      <header className="fw-pcat-sheet-head">
        <div>
          <h2 id="sheet-title" className="fw-pcat-sheet-title">
            {style.code} · {styleName(style, locale)}
          </h2>
          <p className="fw-pcat-quiet">{t('sheet.for', { party: model.partyName, at: words.at(model.printedAt) })}</p>
        </div>
        <Button className="fw-pcat-noprint" variant="secondary" onClick={() => window.print()}>
          <Printer size={14} aria-hidden /> {t('sheet.print')}
        </Button>
      </header>
      <KeyValue
        columns={2}
        labelCase="sentence"
        items={[
          { label: t('card.type'), value: `${t(typeKey(style.productType))}${style.season ? ` · ${style.season}` : ''}` },
          { label: t('filters.range'), value: style.ownLabel ? t('card.ownLabel') : t('card.openRange') },
          { label: t('card.sizes'), value: style.range || '—', hint: style.baseSize ? t('detail.baseSize', { size: style.baseSize }) : undefined },
          ...(style.revision !== null ? [{ label: t('detail.revision'), value: t('detail.revisionValue', { revision: style.revision }) }] : []),
          { label: t('detail.category'), value: t(ppeKey(style.ppe.category)) },
          { label: t('detail.standard'), value: [style.ppe.standard, style.ppe.class ? t('ppe.class', { class: style.ppe.class }) : null].filter(Boolean).join(' · ') || '—' },
        ]}
      />
      {style.description ? <p>{style.description}</p> : null}
      <SummaryTable
        label={t('detail.colours', { count: style.colourways.length })}
        columns={[t('detail.colour'), t('sheet.sizesOffered'), ...(seesPrices ? [t('detail.price')] : [])]}
        rows={matrix.rows.map((row, index) => ({
          id: row.id,
          cells: [row.label, matrix.sizes.filter((_, column) => row.offered[column]).join(' · ') || '—', ...(seesPrices ? [words.price(style.colourways[index]?.price, currency) ?? '—'] : [])],
        }))}
        stackOnPhone
      />
      {!seesPrices ? <p className="fw-pcat-quiet">{t('prices.none')}</p> : null}
    </article>
  )
}
