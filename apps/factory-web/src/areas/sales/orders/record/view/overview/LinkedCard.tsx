'use client'

import { Card } from '@nexus/ui/components'
import { useT } from '../../../../../../lib/i18n/provider'
import type { Order } from '../../../api'
import { readOf } from '../../overview/model'
import { linkedRecordsOf } from '../../overview/linked'
import type { OrderRecordModel } from '../../record-model'
import { useSearchParams } from 'next/navigation'
import { TabLink } from '../../../../../../lib/tab-link/TabLink'

/**
 * F-OO-100 (order overview lane: one file per card) — moved out of OverviewTab.tsx unchanged.
 *
 * O6 Linked records: count buttons, each a real link; a list without its right is held in words with no number; left-out work orders counted.
 */
export function LinkedCard({ order, model }: { order: Order; model: OrderRecordModel }) {
  const t = useT('orders')
  const search = useSearchParams()?.toString() ?? '' // F-OP-104: the order's own tabs keep the dock's scope
  const read = readOf(model.production)
  const links = model.links && model.links.state === 'ready' ? model.links.links : null
  const { records, workOrdersLeftOut } = linkedRecordsOf({
    order,
    prefix: model.prefix,
    can: model.can,
    work: read?.work,
    complaints: links?.complaints ? links.complaints.length : null,
    returns: links?.returns ? links.returns.length : null,
    sameQuote: model.depth?.depth.value?.sameQuote ?? [],
    madeFrom: model.madeFromReading ? undefined : (model.madeFrom ?? null),
    search,
  })
  return (
    <Card padded>
      <h2 className="fw-so-h2">{t('overview.linked.title')}</h2>
      <ul className="fw-so-linked" aria-label={t('overview.linked.title')}>
        {records.map((entry, index) => {
          const label = t(`overview.linked.${entry.key}`)
          const value = entry.words ? t(entry.words.key, entry.words.params) : String(entry.count ?? '—')
          return (
            <li key={`${entry.key}-${index}`}>
              {entry.held ? (
                // F-OP-306 (walk #21): a list held for this reader says the Money tab's own sentence, alone (no label, no number).
                <span className="fw-so-countbtn is-plain">{t(entry.held.key)}</span>
              ) : entry.href ? (
                // F-OP-210: no prefetch (a tab address changes with the dock's scope).
                <TabLink className="fw-so-countbtn" href={entry.href}>
                  <span>{label}</span> <strong>{value}</strong>
                </TabLink>
              ) : (
                <span className="fw-so-countbtn is-plain">
                  <span>{label}</span> <strong>{value}</strong>
                </span>
              )}
            </li>
          )
        })}
      </ul>
      {workOrdersLeftOut > 0 && <p className="fw-so-hint">{t('overview.linked.leftOut', { count: workOrdersLeftOut })}</p>}
    </Card>
  )
}
