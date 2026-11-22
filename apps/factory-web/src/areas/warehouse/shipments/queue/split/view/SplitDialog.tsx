'use client'

import Link from 'next/link'
import { Banner, Field, SummaryTable } from '@nexus/ui/components'
import { Input, NumberStepper, RadioCard, SegmentedControl, Select } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { dayInstant } from '../../shared/depth'
import { DepthDialog, PartRead } from '../../shared/DepthDialog'
// F-OS-302: Warehouse's words and the lane's (`order-shipments`: door.split.*) — into several, the delivery address, ship complete.
import { DOOR_NAMESPACES, useDoorWords as useDepthWords } from '../../shared/door-words'
import type { SplitPreview } from '../api'
import { HAND_REASONS, handTotals, splitHeld, type SplitActions, type SplitModel } from '../model'
import { cappedGroups, groupsOf, INTO_MAX, roomOf } from '../model' // F-OS-302
import '../../../shipments.css'
import '../../shared/depth.css'

/**
 * SCR-593 — Split a shipment (B-W2b-386, LOG-005; the record's ⋯ "Split…"): by hand — how many garments of each line move
 * onto a new DRAFT of the same order (only garments not in a carton and without a serial can move; something stays), why,
 * and its carrier or service when that is the reason — or by the promise date (garments promised for different days leave
 * apart: the rule's proposal, one new shipment a day). The holds in force go with the new shipments. Done names each new
 * shipment with its link.
 */
export function SplitDialog({ model, actions }: { model: SplitModel; actions?: SplitActions }) {
  return (
    <WithMessages namespaces={DOOR_NAMESPACES}>
      <Split model={model} actions={actions} />
    </WithMessages>
  )
}

function Split({ model, actions }: { model: SplitModel; actions?: SplitActions }) {
  const { t, say } = useDepthWords()
  const locale = useLocale()
  const close = () => actions?.onClose?.()
  if (model.preview.state !== 'ready') {
    return (
      <DepthDialog title={t('split.title')} held={t('split.held.reading')} onGo={() => undefined} goLabel={t('split.go')} onClose={close} problem={null}>
        <PartRead problem={model.preview.state === 'error' ? model.preview.problem : null} onRetry={actions?.onRetry} label={t('split.title')} />
      </DepthDialog>
    )
  }
  const preview: SplitPreview = model.preview.value
  const rule = preview.rules.find((entry) => entry.rule === 'PROMISE_DATE') ?? null
  // F-OS-302 (B-OS-010): the new shipments' garments (new shipment 1 first), each line never giving more than can move.
  const groups = groupsOf(model)
  const capped = cappedGroups(preview, groups)
  const totals = handTotals(preview, groups[0]!, groups.slice(1))
  const several = groups.length > 1
  const day = (value: string | null) => (value ? formatDate(dayInstant(value), { locale }) : t('split.noDate'))
  const done = model.made ? (
    <div className="fw-shd-stack" role="status">
      <p>{t('split.done', { count: model.made.length, number: preview.number })}</p>
      <ul className="fw-sh-list">
        {model.made.map((made) => (
          <li key={made.id}>
            <Link className="fw-sh-link" href={`${model.prefix}/warehouse/shipments/${made.id}`}>
              {made.number}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  ) : undefined
  return (
    <DepthDialog
      title={t('split.titleOf', { number: preview.number })}
      held={say(splitHeld(model, preview))}
      onGo={() => actions?.onSplit?.()}
      goLabel={model.mode === 'rule' ? t('split.goRule', { count: rule?.shipments.length ?? 0 }) : several ? t('door.split.goInto', { count: groups.length + 1 }) : t('split.goHand', { count: totals.moving })}
      onClose={close}
      problem={say(model.problem)}
      done={done}
      size="lg"
    >
      {preview.held && <Banner tone="warning" title={t('split.heldCarried')} />}
      {/* F-OS-302 (X1-B3): the customer wants it all in one delivery — said, never a block. */}
      {model.shipComplete && <Banner tone="warning" title={t('door.split.shipComplete')} />}
      <SegmentedControl
        ariaLabel={t('split.how')}
        size="sm"
        value={model.mode}
        onChange={(value: string) => actions?.onMode?.(value === 'rule' ? 'rule' : 'hand')}
        options={[
          { value: 'hand', label: t('split.byHand') },
          { value: 'rule', label: t('split.byRule') },
        ]}
      />
      {model.mode === 'rule' ? (
        rule && rule.shipments.length > 0 ? (
          <div className="fw-shd-stack">
            <p className="fw-sh-hint">{t('split.ruleBody', { day: day(rule.stays) })}</p>
            <ul className="fw-sh-list">
              {rule.shipments.map((entry) => (
                <li key={entry.shipBy}>{t('split.ruleLine', { day: day(entry.shipBy), count: entry.garments })}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="fw-sh-hint">{t('split.refusal.ONE_DAY')}</p>
        )
      ) : (
        <div className="fw-shd-stack">
          <p className="fw-sh-hint">{t('split.handBody')}</p>
          {/* F-OS-302 (B-OS-010): into several shipments in one go (all or nothing). */}
          <Field label={t('door.split.into')} hint={t('door.split.intoHint', { max: INTO_MAX - 1 })}>
            <NumberStepper size="sm" min={2} max={INTO_MAX} value={groups.length + 1} onChange={(next) => actions?.onInto?.(next)} aria-label={t('door.split.into')} decrementLabel={t('split.fewer')} incrementLabel={t('split.more')} />
          </Field>
          <SummaryTable
            label={t('split.lines')}
            columns={[t('split.col.line'), t('split.col.shipBy'), t('split.col.stays'), ...(several ? groups.map((_, index) => t('door.split.col.new', { n: index + 1 })) : [t('split.col.moves')])]}
            rows={preview.lines.map((line) => ({
              id: line.id,
              cells: [
                <span key="l" className="fw-sh-cell">
                  <span>
                    {line.label} · {line.size}
                  </span>
                  <span className="fw-sh-cell-sub">{t('split.lineFacts', { quantity: line.quantity, packed: line.packed, serials: line.serials })}</span>
                </span>,
                <span key="d">{day(line.shipBy)}</span>,
                <span key="s">{line.quantity - capped.reduce((sum, group) => sum + (group[line.id] ?? 0), 0)}</span>,
                ...groups.map((_, index) =>
                  line.movable > 0 ? (
                    <NumberStepper
                      key={`m${index}`}
                      size="sm"
                      min={0}
                      max={roomOf(line, capped, index)}
                      value={capped[index]?.[line.id] ?? 0}
                      onChange={(next) => (index === 0 && actions?.onQuantity ? actions.onQuantity(line.id, next) : actions?.onGroupQuantity?.(index, line.id, next))}
                      aria-label={several ? t('door.split.movesTo', { line: line.label, size: line.size, n: index + 1 }) : t('split.movesOf', { line: line.label, size: line.size })}
                      decrementLabel={t('split.fewer')}
                      incrementLabel={t('split.more')}
                    />
                  ) : (
                    <span key={`m${index}`} className="fw-sh-muted">
                      {t('split.cannotMove')}
                    </span>
                  ),
                ),
              ],
            }))}
            density="compact"
            stackOnPhone
            align={['left', 'left', 'right', ...groups.map(() => 'right' as const)]}
          />
          <p className="fw-sh-hint">{t('split.totals', { moving: totals.moving, staying: totals.staying })}</p>
          <fieldset className="fw-shd-choices fw-shd-choices--grid">
            <legend className="fw-sh-h3">{t('split.reason')}</legend>
            {HAND_REASONS.filter((reason) => preview.reasons.includes(reason) && (reason !== 'SHIP_TO' || model.shipToOffered)).map((reason) => (
              <RadioCard key={reason} name="split-reason" value={reason} checked={model.reason === reason} selected={model.reason === reason} onChange={() => actions?.onReason?.(reason)} title={reason === 'SHIP_TO' ? t('door.split.reasonShipTo') : t(`splitReason.${reason}`)} />
            ))}
          </fieldset>
          {/* F-OS-302 (X1-B4): another delivery address — one of the customer's approved ones (this shipment's own left out). */}
          {model.reason === 'SHIP_TO' && <ShipToPart model={model} actions={actions} />}
          {model.reason === 'CARRIER' && (
            <div className="fw-shd-fields">
              <Field label={t('split.transportBy')}>
                <Select size="sm" value={model.transportBy} onChange={(event) => actions?.onDelivery?.({ transportBy: event.target.value as SplitModel['transportBy'] })}>
                  <option value="CARRIER">{t('split.transport.CARRIER')}</option>
                  <option value="SENDER">{t('split.transport.SENDER')}</option>
                  <option value="RECIPIENT">{t('split.transport.RECIPIENT')}</option>
                </Select>
              </Field>
              {model.transportBy === 'CARRIER' && (
                <Field label={t('split.carrierCode')} required hint={t('split.carrierHint')}>
                  <Input size="sm" value={model.carrierCode} onChange={(event) => actions?.onDelivery?.({ carrierCode: event.target.value })} />
                </Field>
              )}
            </div>
          )}
          {model.reason === 'SERVICE' && (
            <Field label={t('split.serviceCode')} required>
              <Input size="sm" value={model.serviceCode} onChange={(event) => actions?.onDelivery?.({ serviceCode: event.target.value })} />
            </Field>
          )}
          {model.shipToOffered ? <p className="fw-sh-hint">{t('door.split.onlyOwn')}</p> : <p className="fw-sh-hint">{t('split.shipToNote')}</p>}
        </div>
      )}
    </DepthDialog>
  )
}

// ── F-OS-302 (X1-B4): the delivery address of the new shipments, from the customer's approved addresses ──
function ShipToPart({ model, actions }: { model: SplitModel; actions?: SplitActions }) {
  const { t } = useDepthWords()
  const addresses = model.addresses ?? null
  if (!addresses || addresses.state === 'loading') return <p className="fw-sh-hint">{t('door.split.addressesReading')}</p>
  if (addresses.state === 'error') return <PartRead problem={addresses.problem} onRetry={actions?.onRetryAddresses} label={t('door.split.address')} />
  if (addresses.value.length === 0) return <p className="fw-sh-hint">{t('door.split.noAddress')}</p>
  return (
    <Field label={t('door.split.address')} required>
      <Select size="sm" value={model.shipToAddressId ?? ''} onChange={(event) => actions?.onShipTo?.(event.target.value)}>
        <option value="">{t('door.split.pickAddressOption')}</option>
        {addresses.value.map((address) => (
          <option key={address.id} value={address.id}>
            {address.label}
          </option>
        ))}
      </Select>
    </Field>
  )
}
// ── end F-OS-302 ──
