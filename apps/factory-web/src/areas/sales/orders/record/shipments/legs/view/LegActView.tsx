'use client'

import type { ReactElement } from 'react'
import Link from 'next/link'
import { Banner, Field } from '@nexus/ui/components'
import { Input, RadioCard } from '@nexus/ui/primitives'
import type { OrderWarningKind } from '@nexus/factory-domain/sales/warnings/kinds'
import { useT } from '../../../../../../../lib/i18n/provider'
import { PartReading } from '../../../../../../../lib/record-sections/Kit'
import { WindowShell } from '../../../../../../../lib/window-shell/view/WindowShell'
import type { Leg } from '../api'
import { SEND_ON_MAX, sendOnActKey, sendOnHeld, sendOnLines, type LegAct, type SendOnForm } from '../model'
import '../legs.css'

/**
 * owb-ss3 (design plan § 7; ship.js `arrive`, `sendOn`; settles L2, L5) — the ONE window of the warehouse leg, drawn with the ONE window
 * frame (lib/window-shell): **It arrived at the warehouse** (one line + Confirm) or **Send on to the customer** (carrier and tracking,
 * both optional; the yellow line "No label from the customer yet" while the customer sent none; after a 409 the yellow line of the
 * payment that is due, in words and with no amount, and the act says "Send it anyway"). With several shipments that fit, the person picks
 * one first. The order's Shipments tab, the Warehouse shipment record and Our warehouses all open it. Draws its model; fetches nothing.
 */

export interface LegChoice {
  readonly shipmentId: string
  readonly number: string | null
  readonly pieces: number | null
  readonly place: string
}

export interface LegActViewModel {
  readonly open: boolean
  readonly act: LegAct
  readonly state: 'reading' | 'failed' | 'none' | 'ready'
  /** Why it could not be read (a `shipments` word). */
  readonly readProblem: string | null
  readonly choices: readonly LegChoice[]
  readonly picked: string | null
  readonly leg: Leg | null
  /** The picked shipment's home in Warehouse (DDT, pack, labels stay there). */
  readonly href: string | null
  readonly form: SendOnForm
  readonly warnings: readonly OrderWarningKind[] | null
  readonly busy: boolean
  /** A refused act, in the Warehouse's words (`shipments`: problem.write.*), with the API's sentence. */
  readonly writeProblem: { readonly key: string; readonly detail: string | null } | null
}

export interface LegActViewActions {
  readonly onClose: () => void
  readonly onPick?: (shipmentId: string) => void
  readonly onForm?: (form: SendOnForm) => void
  readonly onAct?: () => void
  readonly onRetry?: () => void
}

/** The design index draws the window without a host: Cancel / Close then does nothing. */
const NO_ACTIONS: LegActViewActions = Object.freeze({ onClose: () => undefined })

export function LegActView({ model, actions = NO_ACTIONS }: { model: LegActViewModel; actions?: LegActViewActions }): ReactElement {
  const t = useT('ship-ways')
  const s = useT('shipments')
  const arrived = model.act === 'ARRIVED'
  const choice = model.choices.find((entry) => entry.shipmentId === model.picked) ?? null
  const ready = model.state === 'ready' && model.leg !== null
  const sendHeld = sendOnHeld(model.form, model.busy)
  const held = !ready ? t('leg.held.nothing') : arrived ? (model.busy ? t('leg.held.busy') : null) : sendHeld ? t(sendHeld.key, sendHeld.params) : null
  const title = arrived ? t('leg.arrived.title') : t('leg.sendOn.title')
  const subtitle = choice ? [choice.number, choice.place].filter(Boolean).join(' · ') : undefined
  const act = model.state === 'ready' ? { words: arrived ? t('leg.arrived.act') : t(sendOnActKey(model.warnings)), onAct: () => actions.onAct?.(), held, busy: model.busy } : null
  return (
    <WindowShell open={model.open} onClose={actions.onClose} title={title} subtitle={subtitle} act={act} size="md">
      <div className="fw-leg">
        {model.state === 'reading' ? <PartReading rows={2} /> : null}
        {model.state === 'failed' ? <Banner tone="danger" title={t('leg.readFailed')}>{model.readProblem ? s(model.readProblem) : null}</Banner> : null}
        {model.state === 'none' ? <p className="fw-leg-line">{arrived ? t('leg.none.arrived') : t('leg.none.sendOn')}</p> : null}
        {model.state === 'ready' && model.choices.length > 1 ? (
          <fieldset className="fw-leg-pick">
            <legend className="fw-leg-legend">{t('leg.pick')}</legend>
            {model.choices.map((entry) => (
              <RadioCard
                key={entry.shipmentId}
                variant="row"
                name="fw-leg-pick"
                checked={entry.shipmentId === model.picked}
                selected={entry.shipmentId === model.picked}
                onChange={() => actions.onPick?.(entry.shipmentId)}
                title={entry.number ?? t('leg.aShipment')}
                description={[entry.place, entry.pieces !== null ? t('leg.pieces', { count: entry.pieces }) : null].filter(Boolean).join(' · ')}
              />
            ))}
          </fieldset>
        ) : null}
        {ready && model.leg && arrived ? <p className="fw-leg-line">{t('leg.arrived.line', { place: model.leg.warehouse.name })}</p> : null}
        {ready && model.leg && !arrived ? (
          <>
            <p className="fw-leg-line">{t('leg.sendOn.line', { place: model.leg.warehouse.name })}</p>
            {sendOnLines(model.leg, model.warnings).map((line) => (
              <Banner key={line.key} tone="warning" title={t(line.key, line.params)}>
                {line.key === 'leg.noLabel' ? t('leg.noLabelWhy') : t('leg.warningWhy')}
              </Banner>
            ))}
            <div className="fw-leg-fields">
              <Field label={t('leg.sendOn.carrier')} hint={t('leg.sendOn.optional')}>
                <Input size="sm" maxLength={SEND_ON_MAX} value={model.form.carrier} onChange={(event) => actions.onForm?.({ ...model.form, carrier: event.target.value })} autoComplete="off" />
              </Field>
              <Field label={t('leg.sendOn.tracking')} hint={t('leg.sendOn.optional')}>
                <Input size="sm" maxLength={SEND_ON_MAX} value={model.form.trackingNumber} onChange={(event) => actions.onForm?.({ ...model.form, trackingNumber: event.target.value })} autoComplete="off" />
              </Field>
            </div>
            <p className="fw-leg-hint">{t('leg.sendOn.ddt')}</p>
          </>
        ) : null}
        {model.writeProblem ? (
          <Banner tone="danger" title={s(model.writeProblem.key)}>
            {model.writeProblem.detail}
          </Banner>
        ) : null}
        {model.href ? (
          <p className="fw-leg-hint">
            <Link className="fw-leg-link" href={model.href}>
              {t('leg.openInWarehouse', { number: choice?.number ?? '' })}
            </Link>
          </p>
        ) : null}
      </div>
    </WindowShell>
  )
}
