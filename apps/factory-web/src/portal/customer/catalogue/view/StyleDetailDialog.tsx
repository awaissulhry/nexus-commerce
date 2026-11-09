'use client'

import { Check, Minus } from 'lucide-react'
import { KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Pill } from '@nexus/ui/primitives'
import { DetailModal } from '../../../../lib/i18n/ds-parts'
import type { StyleDetail } from '../api'
import { isPpe, ppeKey, sizeMatrix, styleName, typeKey } from '../model'
import { useOrderingWords } from '../../neworder/words'
import '../catalogue.css'

/**
 * pop:style-detail (design portal.customer.catalogue "JKT-RACE": DetailModal, J / K next style, Esc closes, Enter adds to
 * order): the style's facts, its colours with the sizes each offers and the price per colour (price grain only), the PPE
 * category, standard and class. The size chart and the public declaration of conformity are not partner-readable yet: their
 * new-tab buttons are held with the reason (a gap). The style sheet opens in a new tab to print or save as PDF.
 */

export interface StyleDetailModel {
  state: 'loading' | 'error' | 'missing' | 'ready'
  /** The style's id (also while it is read). */
  id: string
  detail: StyleDetail | null
  /** J / K through the results shown. */
  ids: readonly string[]
  /** Why "Add to order" cannot act (a key), or null. */
  addHeld: string | null
  sheetHref: string | null
}

export interface StyleDetailActions {
  onClose?: () => void
  onGo?: (id: string) => void
  onAdd?: (id: string) => void
  onRetry?: () => void
}

export function StyleDetailDialog({ model, actions }: { model: StyleDetailModel; actions?: StyleDetailActions }) {
  const words = useOrderingWords()
  const { t, locale } = words
  const style = model.detail?.style ?? null
  const seesPrices = model.detail?.seesPrices ?? false
  const currency = model.detail?.currency ?? 'EUR'
  const addHeld = model.addHeld ? t(model.addHeld) : null
  const matrix = style ? sizeMatrix(style) : null
  return (
    <DetailModal
      open
      onClose={() => actions?.onClose?.()}
      title={style ? style.code : t('detail.reading')}
      subtitle={style ? styleName(style, locale) : undefined}
      meta={
        style ? (
          <span className="fw-pcat-pills">
            <Pill tone={style.ownLabel ? 'info' : 'neutral'}>{style.ownLabel ? t('card.ownLabel') : t('card.openRange')}</Pill>
            <Pill tone={isPpe(style.ppe.category) ? 'warning' : 'neutral'}>{t(ppeKey(style.ppe.category))}</Pill>
          </span>
        ) : undefined
      }
      nav={model.ids.length > 1 ? { ids: model.ids, current: model.id, onGo: (id) => actions?.onGo?.(id), noun: t('detail.noun') } : undefined}
      loading={model.state === 'loading'}
      error={model.state === 'error' ? t('detail.failed') : model.state === 'missing' ? t('detail.missing') : undefined}
      onRetry={model.state === 'error' ? actions?.onRetry : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={() => actions?.onClose?.()}>
            {t('dialog.close')}
          </Button>
          <Button variant="primary" heldReason={style ? addHeld : t('detail.reading')} onClick={() => (style ? actions?.onAdd?.(style.id) : undefined)} aria-keyshortcuts="Enter">
            {t('card.add')}
          </Button>
        </>
      }
    >
      {style && matrix ? (
        <div
          className="fw-pcat-detail"
          onKeyDown={(event) => {
            const target = event.target as HTMLElement
            if (event.key === 'Enter' && !addHeld && target.tagName !== 'BUTTON' && target.tagName !== 'A') actions?.onAdd?.(style.id)
          }}
        >
          <div className="fw-pcat-detail-grid">
            <section className="fw-pcat-section" aria-labelledby="style-facts">
              <h3 id="style-facts" className="fw-pcat-h3">
                {t('detail.facts')}
              </h3>
              <KeyValue
                labelCase="sentence"
                items={[
                  { label: t('card.type'), value: `${t(typeKey(style.productType))}${style.season ? ` · ${style.season}` : ''}` },
                  { label: t('card.sizes'), value: style.range || '—', hint: style.baseSize ? t('detail.baseSize', { size: style.baseSize }) : undefined },
                  ...(style.revision !== null ? [{ label: t('detail.revision'), value: t('detail.revisionValue', { revision: style.revision }) }] : []),
                  ...(seesPrices && style.priceFrom ? [{ label: t('detail.price'), value: t('card.from', { price: words.price(style.priceFrom, currency) ?? '' }) }] : []),
                ]}
              />
              {style.description ? <p className="fw-pcat-quiet">{style.description}</p> : null}
            </section>
            <section className="fw-pcat-section" aria-labelledby="style-ppe">
              <h3 id="style-ppe" className="fw-pcat-h3">
                {t('detail.certificate')}
              </h3>
              <KeyValue
                labelCase="sentence"
                items={[
                  { label: t('detail.category'), value: t(ppeKey(style.ppe.category)) },
                  { label: t('detail.standard'), value: style.ppe.standard ?? '—' },
                  { label: t('detail.class'), value: style.ppe.class ?? '—' },
                ]}
              />
              <div className="fw-pcat-links">
                <Button size="sm" variant="secondary" heldReason={t('detail.sizeChartHeld')}>
                  {t('detail.sizeChart')}
                </Button>
                <Button size="sm" variant="secondary" heldReason={t('detail.docHeld')}>
                  {t('detail.publicDoc')}
                </Button>
                {model.sheetHref ? (
                  <Button size="sm" variant="secondary" asChild>
                    <a href={model.sheetHref} target="_blank" rel="noopener">
                      {t('card.sheet')}
                    </a>
                  </Button>
                ) : null}
              </div>
            </section>
          </div>
          <section className="fw-pcat-section" aria-labelledby="style-colours">
            <h3 id="style-colours" className="fw-pcat-h3">
              {t('detail.colours', { count: style.colourways.length })}
            </h3>
            {!seesPrices ? <p className="fw-pcat-quiet">{t('prices.none')}</p> : null}
            <SummaryTable
              label={t('detail.colours', { count: style.colourways.length })}
              columns={[t('detail.colour'), ...matrix.sizes, ...(seesPrices ? [t('detail.price')] : [])]}
              rows={matrix.rows.map((row, index) => ({
                id: row.id,
                cells: [
                  row.label,
                  ...row.offered.map((offered, column) =>
                    offered ? (
                      <span key={column} aria-label={t('detail.offered')}>
                        <Check size={14} aria-hidden />
                      </span>
                    ) : (
                      <span key={column} aria-label={t('detail.notOffered')} className="fw-pcat-quiet">
                        <Minus size={14} aria-hidden />
                      </span>
                    ),
                  ),
                  ...(seesPrices ? [words.price(style.colourways[index]?.price, currency) ?? '—'] : []),
                ],
              }))}
              align={[undefined, ...matrix.sizes.map(() => 'left' as const), ...(seesPrices ? ['right' as const] : [])]}
              stackOnPhone
            />
          </section>
          <p className="fw-pcat-quiet">{t('detail.later')}</p>
        </div>
      ) : null}
    </DetailModal>
  )
}
