'use client'

import { Scale } from 'lucide-react'
import { Banner, Card, KeyValue } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import type { CaseRecord } from '../../api'
import { actionHeld, coverDraftOf, liablePhrase, personPhrase, remediesPhrase } from '../../model'
import { useWords } from '../../parts'
import { WarrantyLines } from '../../view/WarrantyLines'
import type { ServiceRecordActions, ServiceRecordModel } from '../view-model'

/**
 * Warranty check (design case.warranty, read-only facts + one decision; SAL-368): which guarantee applies, said in words — the
 * legal 2-year guarantee of conformity for a consumer we sold to (with the first-year presumption) or the factory's own on
 * top, each with its end and the days left; the ship date and the delivery day; the remedies of the cover the facts point to
 * and who answers to whom. Then the decision: covered, partly or not covered under a guarantee, and why — Decide… (held for
 * a role without sales.service.decide, with why). The cause code and its cover are Later (not drawn).
 */
export function WarrantyTab({ model, record, actions }: { model: ServiceRecordModel; record: CaseRecord; actions?: ServiceRecordActions }) {
  const { t, say, day, when } = useWords()
  const offline = model.live === 'offline'
  const check = record.warranty.check
  const decided = record.warranty.decided
  const held = say(actionHeld(record, 'decideCover', offline, model.can))
  const shipment = record.garment.serial?.shipment ?? null
  const decide = () => actions?.onDialog?.({ kind: 'decide', draft: coverDraftOf(record), busy: false, notice: null })

  return (
    <div className="fw-svc-two">
      <div className="fw-svc-stack">
        <Card padded>
          <section className="fw-svc-stack" aria-labelledby="svc-check">
            <h2 id="svc-check" className="fw-svc-h2">
              {t('warranty.title')}
            </h2>
            <p className="fw-svc-hint">{t('warranty.intro')}</p>
            <WarrantyLines check={check} label={t('warranty.title')} />
          </section>
        </Card>
        <Card padded>
          <section className="fw-svc-stack" aria-labelledby="svc-facts">
            <h2 id="svc-facts" className="fw-svc-h2">
              {t('warranty.facts')}
            </h2>
            <KeyValue
              items={[
                { label: t('warranty.shipDate'), value: shipment ? t('garment.shippedOn', { number: shipment.number, date: day(shipment.day) }) : '—' },
                { label: t('form.deliveredOn'), value: day(check.deliveredOn) },
                { label: t('form.legalEnds'), value: day(check.legal.endsOn) },
                { label: t('form.factoryEnds'), value: day(check.factory.endsOn) },
                { label: t('warranty.suggested'), value: check.suggested ? t(`coverName.${check.suggested}`) : t('warranty.cannotTell') },
                { label: t('warranty.remedies'), value: say(remediesPhrase(decided?.cover ?? check.suggested)) },
                { label: t('warranty.liable'), value: say(liablePhrase(check)) },
              ]}
            />
            <p className="fw-svc-hint">{t('warranty.lawyer')}</p>
          </section>
        </Card>
      </div>

      <div className="fw-svc-stack">
        <Card padded>
          <section className="fw-svc-stack" aria-labelledby="svc-decision">
            <h2 id="svc-decision" className="fw-svc-h2">
              {t('warranty.decision')}
            </h2>
            {decided ? (
              <>
                <span className="fw-svc-row">
                  <Tag tone={decided.decision === 'NOT_COVERED' ? 'neutral' : 'success'}>{t(`decision.${decided.decision}`)}</Tag>
                  <span>{t(`coverName.${decided.cover}`)}</span>
                </span>
                <p className="fw-svc-text">{decided.note}</p>
                <p className="fw-svc-hint">{t('warranty.decidedBy', { name: say(personPhrase(record.people, decided.byId, model.me)) ?? '', when: when(decided.at) })}</p>
              </>
            ) : (
              <p className="fw-svc-hint">{record.kind === 'WARRANTY' ? t('warranty.notDecidedClaim') : t('warranty.notDecided')}</p>
            )}
            {record.kind === 'WARRANTY' && !decided && record.status !== 'CLOSED' && <Banner tone="info" title={t('warranty.resolveNeedsCover')} />}
            <span className="fw-svc-actions">
              <Button size="sm" variant={decided ? 'secondary' : 'primary'} heldReason={held} onClick={decide}>
                <Scale size={14} aria-hidden /> {decided ? t('warranty.decideAgain') : t('warranty.decide')}
              </Button>
            </span>
          </section>
        </Card>
      </div>
    </div>
  )
}
