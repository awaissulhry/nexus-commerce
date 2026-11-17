'use client'

import Link from 'next/link'
import { Banner } from '@nexus/ui/components'
import { Button, Spinner, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import type { InvoiceCandidates } from '../../api'
import { fromDdtsHref, heldKey, type FigureDoor } from './overall'
import './sheet.css'

type Translate = (key: string, params?: Record<string, string | number>) => string

/**
 * B-TH-244: the overall view's parts — a line of figures (each a real link that opens exactly the rows it counts, ⌘-click a new tab;
 * a 0 or a figure without a filter is plain words), and Finance's drafts for "Invoice shipped goods for N" (one per customer and
 * company, each opening Finance's From-DDTs dialog with its DDTs chosen; nothing is made here).
 */
export function FiguresLine({ doors, label }: { doors: readonly FigureDoor[]; label: string }) {
  return (
    <span className="fw-sheet-figures" role="group" aria-label={label}>
      {doors.map((door) =>
        door.href ? (
          <Link key={door.key} href={door.href} className={`fw-sheet-door${door.tone ? ` ${door.tone}` : ''}`} data-door="">
            {door.words}
          </Link>
        ) : (
          <span key={door.key} className="fw-sheet-plain">
            {door.words}
          </span>
        ),
      )}
    </span>
  )
}

export interface InvoiceDraftsState {
  /** null while the candidates are read. */
  readonly value: InvoiceCandidates | null
  readonly problem: string | null
  readonly count: number
}

/** "Invoice shipped goods for N": the drafts it would open in Finance (for whom, how many DDTs), and the orders held with why. */
export function InvoiceDraftsDialog({ state, prefix, t, onClose, onRetry }: { state: InvoiceDraftsState; prefix: string; t: Translate; onClose: () => void; onRetry?: () => void }) {
  const drafts = state.value?.drafts ?? []
  const held = state.value?.held ?? []
  return (
    <Modal open onClose={onClose} title={t('invoiceShipped.title', { count: state.count })} size="md" footer={<Button onClick={onClose}>{t('invoiceShipped.close')}</Button>}>
      <div className="fw-sheet-drafts">
        {state.problem ? (
          <Banner tone="danger" title={t(state.problem)} action={onRetry ? <Button size="sm" onClick={onRetry}>{t('invoiceShipped.retry')}</Button> : undefined} />
        ) : state.value === null ? (
          <p className="fw-sheet-sub" role="status">
            <Spinner size={12} /> {t('invoiceShipped.reading')}
          </p>
        ) : (
          <>
            <p>{drafts.length === 0 ? t('invoiceShipped.none') : t('invoiceShipped.drafts', { count: drafts.length })}</p>
            {drafts.length > 0 && (
              <ul className="fw-sheet-draft-list">
                {drafts.map((draft) => (
                  <li key={`${draft.partyId}-${draft.companyId}-${draft.month}-${draft.currency}`}>
                    <span>
                      <b>{draft.legalName}</b> · {t('invoiceShipped.ddts', { count: draft.ddts.length })} · {t('invoiceShipped.orders', { numbers: draft.orders.map((order) => order.number).join(', ') })}
                    </span>
                    <Button size="sm" variant="primary" asChild>
                      <Link href={fromDdtsHref(prefix, draft)}>{t('invoiceShipped.open')}</Link>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {held.length > 0 && (
              <>
                <p className="fw-sheet-sub">{t('invoiceShipped.heldTitle', { count: held.length })}</p>
                <ul className="fw-sheet-draft-list">
                  {held.map((order) => (
                    <li key={order.orderId}>
                      <span>
                        <b>{order.number}</b> <Tag tone="neutral">{t(heldKey(order.reason))}</Tag>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
