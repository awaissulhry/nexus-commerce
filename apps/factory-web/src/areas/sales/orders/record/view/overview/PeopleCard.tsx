'use client'

import Link from 'next/link'
import { Card } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { useT } from '../../../../../../lib/i18n/provider'
import type { Order } from '../../../api'
import { readOnlyOnPage } from '../../../model' // F-OO-131: Read-only sees no moves (the band's own rule)
import { useRecordFrame } from '../../../../../_shared/record-frame/RecordFrame' // F-OP-104: the owner door
import { peopleViewOf, placeWords } from '../../overview/people'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { PartState } from '../OrderRecordView' // F-OO-131: a failed read says so (never an empty card)
// ---- F-SA-233: People (the production lane's SupervisorFact in place) ----
import { SupervisorFact } from '../../../../../_shared/production-supervisor/view/SupervisorFact'
import { NOTES_NS, openHeld as noteHeld } from '../../../../../production/_shared/notes/model'
import { FollowersDoor } from '../Discuss' // F-SA-266
import './people.css' // F-OO-131: the card's own rows

/**
 * F-OO-100 (order overview lane: one file per card) — moved out of OverviewTab.tsx unchanged.
 *
 * O3 People (P3): the supervisor (SupervisorFact: Change… with production.brand.manage, Ask with threads.post), the customer's backup,
 * who answers the customer (the order thread's owner: there is no other sales owner), where it is made — places only (site · line ·
 * team, or an outside workshop). No operator, no team member, no per-person output (Statuto art. 4). The people part needs
 * workorders.view (its names stay inside this record); without it: held in words, never "Not set".
 *
 * F-OO-131 (10-design §3; review F15): one aligned list — the label on the left, the value, one door on the right — Supervisor,
 * Backup (a link: it is set for the whole customer, on its page), Answers the customer, Where it is made; "Followers ›" in the
 * head. "Made by" went to Order facts (F-OO-209) and "Told about changes" to the foot of Requests & changes (F-OO-205): one place
 * per fact. Read-only sees no moves; a failed read says so with Try again.
 */
export function PeopleCard({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const notes = useT(NOTES_NS)
  const frame = useRecordFrame() // F-OP-104: "Answers the customer · Change…" is the conversation's owner door
  const customer = order.party?.legalName ?? ''
  const view = peopleViewOf(model.production)
  if (view.status === 'failed') return <PartState problem={view.problem} label={t('overview.people.title')} onRetry={() => actions?.onRetryProduction?.()} />
  // F-OO-131: Read-only (no acting right on the page) sees the facts and the links, never a door.
  const readOnly = readOnlyOnPage(model.can, { assignSupervisor: model.people?.mayAssign, qualityHold: model.workOrderActs?.can.qualityHold })
  const askWait = model.people ? noteHeld(model.people.mayNote, 1) : null
  return (
    <Card padded className="fw-so-people">
      <div className="fw-so-card-head">
        <h2 className="fw-so-h2">{t('overview.people.title')}</h2>
        {/* F-SA-265 / F-SA-266: who is told about this order — the thread's followers (the frame's door); F-OO-131: in the head. */}
        <FollowersDoor />
      </div>
      {view.status === 'loading' ? (
        <Skeleton height={44} />
      ) : view.status === 'withheld' ? (
        <p className="fw-so-hint">{t('overview.people.held')}</p>
      ) : (
        <ul className="fw-so-people-list">
          <li className="fw-so-ov-row">
            <span className="fw-so-people-label">{t('people.supervisor')}</span>
            <span className="fw-so-people-wide">
              <SupervisorFact
                fact={view.people.supervisor ? { kind: 'person', name: view.people.supervisor.name, active: view.people.supervisor.active, from: view.people.supervisor.from, me: view.people.supervisor.me, muted: false } : { kind: 'notSet' }}
                can={!!model.people?.mayAssign}
                onChange={() => actions?.people?.onAssign?.()}
                ask={model.people && !readOnly ? { label: notes('open.askFact'), held: askWait ? notes(askWait.key, askWait.params) : null, onAsk: () => actions?.people?.onAsk?.() } : undefined}
              />
            </span>
          </li>
          {/* F-OP-104: the backup is the customer's own setting (for every order of it): read here, changed on its page. */}
          <li className="fw-so-ov-row">
            <span className="fw-so-people-label">{t('overview.people.backup')}</span>
            <span className="fw-so-stack-tight">
              <span>{view.people.backup ? `${view.people.backup.name} · ${t('doors.backupFor', { customer })}` : '—'}</span>
              <Link className="fw-so-link fw-so-cell-sub" href={`${model.prefix}/sales/customers/${encodeURIComponent(order.partyId)}`}>
                {t('doors.backupElsewhere', { customer })}
              </Link>
            </span>
          </li>
          {/* F-OP-104: who answers the customer is the order conversation's owner — its own dialog, opened from here (the frame's door). */}
          <li className="fw-so-ov-row">
            <span className="fw-so-people-label">{t('overview.people.answers')}</span>
            <span>{view.people.answersCustomer?.name ?? '—'}</span>
            {!readOnly && (
              <span className="fw-so-ov-doors">
                <Button size="sm" variant="quiet" heldReason={frame?.openDoor ? null : t('waiting.noThread')} onClick={() => frame?.openDoor?.('owner')}>
                  {t('doors.change')}
                </Button>
              </span>
            )}
          </li>
          <li className="fw-so-ov-row">
            <span className="fw-so-people-label">{t('overview.people.where')}</span>
            <span>{view.people.places.length > 0 ? view.people.places.map(placeWords).join(' · ') : t('overview.people.notPlanned')}</span>
          </li>
        </ul>
      )}
    </Card>
  )
}
