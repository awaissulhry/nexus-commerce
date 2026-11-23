'use client'

import { SummaryTable } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { PortalAccess } from '../../portal/PortalAccess'
import type { OrderRow } from '../../../orders/api'
import { counterOffersOf, type Read, type RequestsRead } from '../use-customer-work'
import type { DockPick } from './WorkTab'
import './customer-work.css'

/**
 * F-SA-278 (sales page plan N5, N3; picks R5, P10; 11-customer-page §3.2 "Waiting for <customer>", §3.6 Requests; Round 4: "the
 * existing requests card in a centred window"; rule: details in a centred modal) — what waits on the customer, in one centred
 * window: what we asked them (the portal's requests card as it is, through its own container: its reads, live, and "Cancel the
 * request" held without partners.tasks.manage), the counter-offers waiting for their answer, and the changes waiting for their new
 * yes. Each order row picks that order in the page's dock (the window closes). Every list is one customer's, walled by its API read.
 */
export function WaitingForCustomerDialog({ party, can, requests, reaccept, onPick, onClose }: {
  party: { id: string; name: string; companyId: string | null }
  /** partners.view: our asks are read (else that part is left out). */
  can: { readonly partners: boolean }
  requests: Read<RequestsRead>
  /** The orders whose change waits for the customer's new yes (read when the window opens). */
  reaccept: Read<readonly OrderRow[]>
  onPick: (pick: DockPick) => void
  onClose: () => void
}) {
  const t = useT('parties')
  const locale = useLocale()
  const pick = (pick: DockPick) => {
    onPick(pick)
    onClose()
  }
  const orderButton = (id: string, number: string, companyId: string | null) => (
    <Button size="sm" variant="quiet" title={t('customers.work.window.pickTip', { record: number })} onClick={() => pick({ type: 'SalesOrder', id, label: number, companyId })}>
      {number}
    </Button>
  )
  const counters = requests.status === 'ready' ? counterOffersOf(requests.value.items) : null
  return (
    // cw fx5 (walk W-26): the wide window — the portal's requests card needs about 800 px for its own columns (Request, On, By,
    // Asked by, ⋯); in the 660 px window it scrolled sideways by 213 px with "Asked by" off screen and the date cut.
    <Modal open onClose={onClose} size="xl" title={t('customers.work.window.customerTitle', { customer: party.name })}>
      <div className="fw-cw">
        {can.partners && (
          <section className="fw-cw" aria-label={t('customers.work.window.asked', { customer: party.name })}>
            <h3 className="fw-cw-glabel">{t('customers.work.window.asked', { customer: party.name })}</h3>
            <PortalAccess side="customers" party={party} parts={['requests']} />
          </section>
        )}
        <section className="fw-cw" aria-label={t('customers.work.window.counters', { customer: party.name })}>
          <h3 className="fw-cw-glabel">{t('customers.work.window.counters', { customer: party.name })}</h3>
          {requests.status === 'reading' ? (
            <Skeleton height={64} />
          ) : requests.status === 'failed' ? (
            <p className="fw-cw-line">{t('customers.work.tile.failed')}</p>
          ) : !counters || counters.length === 0 ? (
            <p className="fw-cw-line">{t('customers.work.window.none')}</p>
          ) : (
            <SummaryTable
              label={t('customers.work.window.counters', { customer: party.name })}
              stackOnPhone
              columns={[t('customers.work.window.col.order'), t('customers.work.window.col.what'), t('customers.work.window.col.asked')]}
              rows={counters.map((request) => ({
                id: request.id,
                cells: [orderButton(request.orderId, request.orderNumber, request.companyId), locale === 'en' ? request.standing.en : request.standing.it, formatDate(request.askedAt, { locale })],
              }))}
            />
          )}
        </section>
        <section className="fw-cw" aria-label={t('customers.work.window.reaccept', { customer: party.name })}>
          <h3 className="fw-cw-glabel">{t('customers.work.window.reaccept', { customer: party.name })}</h3>
          {reaccept.status === 'reading' ? (
            <Skeleton height={64} />
          ) : reaccept.status === 'failed' ? (
            <p className="fw-cw-line">{t('customers.work.tile.failed')}</p>
          ) : reaccept.status !== 'ready' || reaccept.value.length === 0 ? (
            <p className="fw-cw-line">{t('customers.work.window.none')}</p>
          ) : (
            <SummaryTable
              label={t('customers.work.window.reaccept', { customer: party.name })}
              stackOnPhone
              columns={[t('customers.work.window.col.order'), t('customers.work.window.col.ref'), t('customers.work.window.col.promised')]}
              rows={reaccept.value.map((order) => ({
                id: order.id,
                cells: [orderButton(order.id, order.number, order.companyId), order.customerRef ?? '—', order.promiseDate ? formatDate(`${order.promiseDate}T12:00:00Z`, { locale }) : '—'],
              }))}
            />
          )}
        </section>
      </div>
    </Modal>
  )
}
