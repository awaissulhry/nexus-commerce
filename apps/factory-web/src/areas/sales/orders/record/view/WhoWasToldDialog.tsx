'use client'

import { useEffect, useState } from 'react'
import { Banner, EmptyState, KeyValue } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { useOfficeApi } from '../../../../../lib/session/context'
import { readProblem } from '../../model'
import { readWhoWasTold, type WhoWasTold } from '../told'

/**
 * F-SA-244 (sales page plan P8, P8', R2, R7, R8; 14-change-flow §4.1 "Told: … opens the Who was told window", §5.2; review WP-1, WP-2)
 * — Who was told of ONE change of the order, opened from its system line's card (`GET /sales/orders/:orderId/told?messageId=`):
 *
 *   In the office   the people the change's ONE bell item reached, by name (office staff, inside the record), grouped by why:
 *                   supervisor or backup · has a task · follows the order · follows a work order (named only when the reader
 *                   reaches it); "Nobody else follows this order" when none
 *   The floor       "Told the floor at 10:42 · WO-0311, WO-0312" (the work orders this reader reaches; "1 more work order")
 *   The workshops   "Told the workshop at 10:44 · SC-0007" per subcontract order; still waiting counted
 * WHO WAS TOLD, NEVER WHO READ IT: no "seen", no "read", no "not yet" for anyone — the floor least of all (Statuto dei Lavoratori art. 4).
 */
export function WhoWasToldDialog({ orderId, messageId, onClose }: { orderId: string; messageId: string; onClose: () => void }) {
  const t = useT('orders')
  const api = useOfficeApi()
  const [read, setRead] = useState<{ state: 'loading' } | { state: 'ready'; told: WhoWasTold } | { state: 'error'; problem: string }>({ state: 'loading' })
  const [seq, setSeq] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setRead({ state: 'loading' })
    readWhoWasTold(api, orderId, messageId, controller.signal)
      .then((told) => setRead({ state: 'ready', told }))
      .catch((error: unknown) => {
        if ((error as { name?: string } | null)?.name !== 'AbortError') setRead({ state: 'error', problem: readProblem(error) })
      })
    return () => controller.abort()
  }, [api, orderId, messageId, seq])
  return (
    <Modal
      open
      size="md"
      onClose={onClose}
      title={t('told.title')}
      footer={
        <>
          <span className="grow" />
          <Button size="sm" variant="primary" onClick={onClose}>
            {t('told.close')}
          </Button>
        </>
      }
    >
      {read.state === 'loading' ? (
        <div className="fw-so-stack">
          <Skeleton height={22} />
          <Skeleton height={22} />
        </div>
      ) : read.state === 'error' ? (
        <Banner
          tone="danger"
          title={t(read.problem)}
          action={
            <Button size="sm" onClick={() => setSeq((value) => value + 1)}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : (
        <WhoWasToldBody told={read.told} />
      )}
    </Modal>
  )
}

/** The window's content (also drawn on its own by the tests: the DS Modal draws nothing before hydration). */
export function WhoWasToldBody({ told }: { told: WhoWasTold }) {
  const t = useT('orders')
  const locale = useLocale()
  const lang = locale === 'en' ? 'en' : 'it'
  const time = (at: string) => formatTime(at, { locale })
  const floorNames = told.floor.workOrders.map((workOrder) => workOrder.number)
  const floorLine = told.floor.at
    ? [t('told.floorAt', { time: time(told.floor.at) }), floorNames.length > 0 ? floorNames.join(', ') : null, told.floor.leftOut > 0 ? t(floorNames.length > 0 ? 'told.floorMore' : 'told.floorOther', { count: told.floor.leftOut }) : null].filter(Boolean).join(' · ')
    : t('told.noFloor')
  const shops = told.workshop.subcontractOrders
  const shopLine = told.workshop.at
    ? [t('told.workshopAt', { time: time(told.workshop.at) }), shops.map((shop) => (shop.toldAt ? t('told.workshopOn', { number: shop.number, time: time(shop.toldAt) }) : shop.number)).join(', ') || null, told.workshop.leftOut > 0 ? t('told.workshopMore', { count: told.workshop.leftOut }) : null].filter(Boolean).join(' · ')
    : null
  return (
    <div className="fw-so-stack">
      <p className="fw-so-hint">{t('told.subtitle', { order: told.order.number, time: time(told.change.at) })}</p>
      <section aria-labelledby="fw-so-told-office">
        <h3 className="fw-so-h3" id="fw-so-told-office">
          {t('told.office', { count: told.people.count })}
        </h3>
        {told.people.groups.length === 0 ? (
          <EmptyState title={t('told.nobody')} />
        ) : (
          <KeyValue
            dense
            labelCase="sentence"
            items={told.people.groups.map((group) => ({
              label: group.words[lang],
              value: group.people.map((person) => (person.workOrder ? t('told.followsWorkOrder', { name: person.name, number: person.workOrder.number }) : person.name)).join(', '),
            }))}
          />
        )}
      </section>
      <section aria-labelledby="fw-so-told-floor">
        <h3 className="fw-so-h3" id="fw-so-told-floor">
          {t('told.floor')}
        </h3>
        <p>{floorLine}</p>
        {shopLine && <p>{shopLine}</p>}
        {told.workshop.waiting > 0 && <p className="fw-so-hint">{t('told.workshopWaiting', { count: told.workshop.waiting })}</p>}
      </section>
      {/* Who was told, never who read it (R2): said once, plainly. */}
      <p className="fw-so-hint">{t('told.neverRead')}</p>
    </div>
  )
}
