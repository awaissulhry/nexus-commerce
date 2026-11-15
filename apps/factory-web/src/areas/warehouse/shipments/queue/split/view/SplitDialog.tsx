'use client'

import Link from 'next/link'
import { Banner, Field, SummaryTable } from '@nexus/ui/components'
import { Input, NumberStepper, RadioCard, SegmentedControl, Select } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { dayInstant, DEPTH_NAMESPACES } from '../../shared/depth'
import { DepthDialog, PartRead, useDepthWords } from '../../shared/DepthDialog'
import type { SplitPreview } from '../api'
import { HAND_REASONS, handTotals, splitHeld, type SplitActions, type SplitModel } from '../model'
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
    <WithMessages namespaces={DEPTH_NAMESPACES}>
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
  const totals = handTotals(preview, model.quantities)
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
      goLabel={model.mode === 'rule' ? t('split.goRule', { count: rule?.shipments.length ?? 0 }) : t('split.goHand', { count: totals.moving })}
      onClose={close}
      problem={say(model.problem)}
      done={done}
      size="lg"
    >
      {preview.held && <Banner tone="warning" title={t('split.heldCarried')} />}
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
          <SummaryTable
            label={t('split.lines')}
            columns={[t('split.col.line'), t('split.col.shipBy'), t('split.col.stays'), t('split.col.moves')]}
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
                <span key="s">{line.quantity - Math.min(model.quantities[line.id] ?? 0, line.movable)}</span>,
                line.movable > 0 ? (
                  <NumberStepper key="m" size="sm" min={0} max={line.movable} value={Math.min(model.quantities[line.id] ?? 0, line.movable)} onChange={(next) => actions?.onQuantity?.(line.id, next)} aria-label={t('split.movesOf', { line: line.label, size: line.size })} decrementLabel={t('split.fewer')} incrementLabel={t('split.more')} />
                ) : (
                  <span key="m" className="fw-sh-muted">
                    {t('split.cannotMove')}
                  </span>
                ),
              ],
            }))}
            density="compact"
            stackOnPhone
            align={['left', 'left', 'right', 'right']}
          />
          <p className="fw-sh-hint">{t('split.totals', { moving: totals.moving, staying: totals.staying })}</p>
          <fieldset className="fw-shd-choices fw-shd-choices--grid">
            <legend className="fw-sh-h3">{t('split.reason')}</legend>
            {HAND_REASONS.filter((reason) => preview.reasons.includes(reason)).map((reason) => (
              <RadioCard key={reason} name="split-reason" value={reason} checked={model.reason === reason} selected={model.reason === reason} onChange={() => actions?.onReason?.(reason)} title={t(`splitReason.${reason}`)} />
            ))}
          </fieldset>
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
          <p className="fw-sh-hint">{t('split.shipToNote')}</p>
        </div>
      )}
    </DepthDialog>
  )
}
