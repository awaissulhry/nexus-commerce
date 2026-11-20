'use client'

import Link from 'next/link'
import { Card, KeyValue } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import type { Order } from '../../../api'
import { useRecordFrame } from '../../../../../_shared/record-frame/RecordFrame' // F-OP-104: the owner door
import { readOf } from '../../overview/model'
import { placeWords } from '../../overview/people'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
// ---- F-SA-233: People (the production lane's SupervisorFact in place) ----
import { SupervisorFact } from '../../../../../_shared/production-supervisor/view/SupervisorFact'
import { NOTES_NS, openHeld as noteHeld } from '../../../../../production/_shared/notes/model'
import { FollowersDoor } from '../Discuss' // F-SA-266

/**
 * F-OO-100 (order overview lane: one file per card) — moved out of OverviewTab.tsx unchanged.
 *
 * O3 People (P3): the supervisor (SupervisorFact: Change… with production.brand.manage, Ask with threads.post), the customer's backup,
 * who answers the customer (the order thread's owner: there is no other sales owner), who made the order and when, where it is made —
 * places only (site · line · team, or an outside workshop). No operator, no team member, no per-person output (Statuto art. 4). The
 * people part needs workorders.view (its names stay inside this record); without it: held in words, never "Not set".
 */
export function PeopleCard({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const notes = useT(NOTES_NS)
  const locale = useLocale()
  const frame = useRecordFrame() // F-OP-104: "Answers the customer · Change…" is the conversation's owner door
  const customer = order.party?.legalName ?? ''
  const state = model.production ?? null
  const read = readOf(state)
  const people = read?.people ?? null
  const withheld = !!read && read.withheld.includes('people')
  const madeBy = order.createdById ? (order.people.find((person) => person.id === order.createdById)?.name ?? null) : null
  const askWait = model.people ? noteHeld(model.people.mayNote, 1) : null
  const supervisor = people?.supervisor ?? null
  const items = [
    ...(people
      ? [
          // F-OP-104: the backup is the customer's own setting (for every order of it): read here, changed on its page.
          {
            label: t('overview.people.backup'),
            value: (
              <span className="fw-so-stack-tight">
                <span>{people.backup?.name ?? '—'}</span>
                <span className="fw-so-cell-sub">
                  {t('doors.backupFor', { customer })} ·{' '}
                  <Link className="fw-so-link" href={`${model.prefix}/sales/customers/${encodeURIComponent(order.partyId)}`}>
                    {t('doors.backupElsewhere', { customer })}
                  </Link>
                </span>
              </span>
            ),
          },
          // F-OP-104: who answers the customer is the order conversation's owner — its own dialog, opened from here (the frame's door).
          {
            label: t('overview.people.answers'),
            value: (
              <span className="fw-so-inline">
                <span>{people.answersCustomer?.name ?? '—'}</span>
                <Button size="sm" variant="quiet" heldReason={frame?.openDoor ? null : t('waiting.noThread')} onClick={() => frame?.openDoor?.('owner')}>
                  {t('doors.change')}
                </Button>
              </span>
            ),
          },
        ]
      : []),
    { label: t('overview.people.madeBy'), value: madeBy ? t('overview.people.madeByOn', { name: madeBy, date: formatDate(order.createdAt, { locale }) }) : formatDate(order.createdAt, { locale }) },
    ...(people ? [{ label: t('overview.people.where'), value: people.places.length > 0 ? people.places.map(placeWords).join(' · ') : t('overview.people.notPlanned') }] : []),
  ]
  return (
    <Card padded>
      <h2 className="fw-so-h2">{t('overview.people.title')}</h2>
      {!state || state.status === 'loading' ? (
        <Skeleton height={44} />
      ) : (
        <div className="fw-so-stack">
          {people && (
            <SupervisorFact
              fact={supervisor ? { kind: 'person', name: supervisor.name, active: supervisor.active, from: supervisor.from, me: supervisor.me, muted: false } : { kind: 'notSet' }}
              can={!!model.people?.mayAssign}
              onChange={() => actions?.people?.onAssign?.()}
              ask={model.people ? { label: notes('open.askFact'), held: askWait ? notes(askWait.key, askWait.params) : null, onAsk: () => actions?.people?.onAsk?.() } : undefined}
            />
          )}
          {withheld && <p className="fw-so-hint">{t('overview.people.held')}</p>}
          <KeyValue dense labelCase="sentence" items={items} />
          {/* F-SA-244 (P8, R2): how many office people were told about this order's changes (each once) — never who read anything. */}
          {model.told?.value && model.told.value.changes.length > 0 && <p className="fw-so-hint">{t('told.aboutChanges', { count: model.told.value.people })}</p>}
          {/* F-SA-265 / F-SA-266: who is told about this order — the thread's followers (the frame's door). */}
          <FollowersDoor />
        </div>
      )}
    </Card>
  )
}
