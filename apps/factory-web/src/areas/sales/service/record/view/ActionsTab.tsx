'use client'

import { CircleDollarSign, Repeat2, Undo2, Wrench } from 'lucide-react'
import { Card } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import type { CaseRecord } from '../../api'
import { actionHeld, emptyReturnDraft, repairDraftOf, type ReturnDraft } from '../../model'
import { useWords } from '../../parts'
import type { ServiceRecordActions, ServiceRecordModel } from '../view-model'

/**
 * Actions (design case.actions "One button each, with what it creates"; "Each result links back to the case"): a repair, a
 * return of the goods, a remake, a credit — each ONE command of the API that opens W2a's repair or RMA (the remake asked on it,
 * the credit decided on it) for the case's customer and garment and links it here. No amount on the case: the credit's and
 * the repair's numbers live on their own records with their grains. Each button is held before the click with why (no
 * customer, no right, closed, offline). An exchange and a visit are Later (not drawn).
 */
export function ActionsTab({ model, record, actions }: { model: ServiceRecordModel; record: CaseRecord; actions?: ServiceRecordActions }) {
  const { t, say } = useWords()
  const offline = model.live === 'offline'
  const repairHeld = say(actionHeld(record, 'makeRepair', offline, model.can))
  const returnHeld = say(actionHeld(record, 'makeReturn', offline, model.can))
  const garment = record.garmentSerial ?? record.garmentBatch ?? record.serial ?? record.batchNumber ?? null
  const customer = record.party ? `${record.party.code} · ${record.party.legalName}` : null
  const openReturn = (purpose: ReturnDraft['purpose']) => actions?.onDialog?.({ kind: 'return', draft: emptyReturnDraft(purpose), reasons: { items: null, problem: null }, busy: false, notice: null })
  const cards = [
    { id: 'repair', icon: <Wrench size={16} aria-hidden />, held: repairHeld, onClick: () => actions?.onDialog?.({ kind: 'repair', draft: repairDraftOf(record), busy: false, notice: null }) },
    { id: 'RETURN', icon: <Undo2 size={16} aria-hidden />, held: returnHeld, onClick: () => openReturn('RETURN') },
    { id: 'REMAKE', icon: <Repeat2 size={16} aria-hidden />, held: returnHeld, onClick: () => openReturn('REMAKE') },
    { id: 'CREDIT', icon: <CircleDollarSign size={16} aria-hidden />, held: returnHeld, onClick: () => openReturn('CREDIT') },
  ] as const

  return (
    <div className="fw-svc-stack">
      <p className="fw-svc-hint">{customer ? t('actions.intro', { customer, garment: garment ?? t('actions.noGarment') }) : t('actions.introNoCustomer')}</p>
      <div className="fw-svc-cards">
        {cards.map((card) => (
          <Card padded key={card.id}>
            <section className="fw-svc-card-body" aria-labelledby={`svc-action-${card.id}`}>
              <h2 id={`svc-action-${card.id}`} className="fw-svc-h2">
                <span className="fw-svc-row">
                  {card.icon} {t(`actions.${card.id}.title`)}
                </span>
              </h2>
              <p className="fw-svc-hint">{t(`actions.${card.id}.creates`)}</p>
              <span className="fw-svc-actions">
                <Button size="sm" variant="secondary" heldReason={card.held} onClick={card.onClick}>
                  {t(`actions.${card.id}.button`)}
                </Button>
              </span>
            </section>
          </Card>
        ))}
      </div>
      <p className="fw-svc-hint">{t('actions.later')}</p>
    </div>
  )
}
