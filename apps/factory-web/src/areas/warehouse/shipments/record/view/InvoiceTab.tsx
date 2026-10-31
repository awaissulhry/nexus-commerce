'use client'

import Link from 'next/link'
import { Euro, Receipt } from 'lucide-react'
import { Card, KeyValue } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { Shipment } from '../../api'
import { freightFacts, freightHeld, money } from '../../daily-model'
import { hasLeft } from '../../model'
import type { ShipmentRecordActions, ShipmentRecordModel } from '../record-model'

const STATE_TONE = { byHand: 'info', byRule: 'neutral', open: 'warning' } as const

/**
 * Invoice (design sh-invoice; its W2a part LOG-105: "freight line by rule"): the freight charged to the customer — the
 * one price a shipment carries, drawn only with the price grain (without it the API sends no amount and the page says so,
 * never 0) — typed by hand or the site's rule (set when the goods leave), why the rule gives what it gives, and Change
 * freight (shipping.freight.manage, until the shipment is cancelled); then where the invoice is made: Finance bills the
 * DDT's goods and this freight line together.
 */
export function InvoiceTab({ shipment, model, actions }: { shipment: Shipment; model: ShipmentRecordModel; actions?: ShipmentRecordActions }) {
  const t = useT('shipments')
  const locale = useLocale()
  const facts = freightFacts(shipment.freight, shipment, model.can)
  const held = freightHeld(shipment, model.can)
  const liveDdt = model.ddts.value?.find((row) => row.status === 'LIVE') ?? null
  const amount = facts.shown ? (facts.charge === null ? t('charge.notDecided') : money(facts.charge, facts.currency, locale)) : t('charge.hidden')
  return (
    <div className="fw-sh-cards">
      <Card padded>
        <div className="fw-sh-stack">
          <div className="fw-sh-card-head">
            <h2 className="fw-sh-h2">
              <Euro size={16} aria-hidden /> {t('charge.cardTitle')}
            </h2>
            <Tag tone={STATE_TONE[facts.state]}>{t(`charge.state.${facts.state}`)}</Tag>
          </div>
          <p className="fw-sh-amount" aria-live="polite">
            {amount}
          </p>
          <KeyValue
            labelCase="sentence"
            items={[
              { label: t('charge.rule'), value: facts.shown ? (facts.byRule === null ? t('charge.ruleNone') : money(facts.byRule, facts.currency, locale)) : t('charge.hidden') },
              { label: t('charge.why'), value: t(facts.basis.key, facts.basis.params) },
              { label: t('charge.currency'), value: facts.currency },
            ]}
          />
          <p className="fw-sh-hint">{facts.state === 'open' ? t('charge.whenLeaves') : hasLeft(shipment.status) ? t('charge.afterLeft') : t('charge.beforeLeft')}</p>
          {!facts.shown && <p className="fw-sh-hint">{t('charge.hiddenNote')}</p>}
          <div className="fw-sh-card-foot">
            <span className="fw-sh-inline">
              {(model.can.freight || model.can.price) && (
                <Button size="sm" heldReason={held ? t(held.key, held.params) : model.busy ? t('held.busy') : null} onClick={() => actions?.onDialog?.({ kind: 'freight' })}>
                  {t('charge.change')}
                </Button>
              )}
            </span>
          </div>
        </div>
      </Card>
      <Card padded>
        <div className="fw-sh-stack">
          <h2 className="fw-sh-h2">
            <Receipt size={16} aria-hidden /> {t('invoice.title')}
          </h2>
          <p className="fw-sh-hint">{liveDdt ? t('invoice.fromDdt', { number: liveDdt.number }) : shipment.ddtRequired ? t('invoice.noDdt') : t('invoice.noDdtNeeded')}</p>
          <p className="fw-sh-hint">{t('invoice.freightLine')}</p>
          {model.can.viewInvoices && (
            <span className="fw-sh-inline">
              <Button size="sm" asChild>
                <Link href={`${model.prefix}/finance/invoices`}>{t('invoice.open')}</Link>
              </Button>
            </span>
          )}
        </div>
      </Card>
    </div>
  )
}
