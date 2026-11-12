'use client'

import type { ReactNode } from 'react'
import { ScanLine } from 'lucide-react'
import { Card, Field, KeyValue } from '@nexus/ui/components'
import { Button, Input, Pill, RadioCard } from '@nexus/ui/primitives'
import { formatDate } from '../../../../lib/i18n/format'
import { Textarea } from '../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { ClaimPage } from '../../api'
import { fieldId, type ClaimActions, type ClaimViewModel, type Step } from '../../model'
import { itemFacts, itemTitle } from '../../view/items'
import { useShown } from '../../view/shown'
import { REPAIR_KINDS, type RepairOffer } from './api'
import { OTHER_GARMENT, REPAIR_LIMITS, repairItemOf, repairItems, repairNextKey, repairStageKey } from './model'

/**
 * SCR-197 › Repair or alteration — the repair's own steps on the claim link (B-W2b-342; RR1:01; design links.claim
 * sec:item, sec:details "Repair: the work wanted — no payment data here", sec:review): which garment (an item of the
 * delivery, or another one by the serial on its label, scanned or typed), what you need (a repair or an alteration),
 * what is wrong and the work wanted, the check before the send, and this link's repair requests with where they stand.
 * Words of `returns-repair` (`link.*`, `common.*`); never a price.
 */

interface StepProps {
  page: ClaimPage
  model: ClaimViewModel
  actions?: ClaimActions
}

function GroupError({ id, text }: { id: string; text: string | undefined }) {
  if (!text) return null
  return (
    <p id={`${id}-error`} className="fw-cl-error" role="alert">
      {text}
    </p>
  )
}

/** sec:item — the garment to repair: one item of the delivery, or another garment by its serial. */
export function RepairItemStep({ page, model, actions }: StepProps) {
  const t = useT('link-claim')
  const r = useT('returns-repair')
  const locale = useLocale()
  const { error } = useShown(model, page)
  const repair = model.form.repair
  const id = fieldId('repair.item')
  const problem = error('repair.item')
  const serialId = fieldId('repair.serial')
  return (
    <>
      <fieldset className="fw-cl-fieldset" id={id} aria-describedby={problem ? `${id}-error` : undefined}>
        <legend className="fw-cl-vh">{r('link.item.legend')}</legend>
        <div className="fw-cl-items">
          {repairItems(page).map((item) => (
            <RadioCard
              key={item.key}
              name="fw-cl-repair-item"
              value={item.key}
              checked={repair.itemKey === item.key}
              selected={repair.itemKey === item.key}
              onChange={() => actions?.onRepair?.({ itemKey: item.key })}
              title={itemTitle(item, t)}
              description={itemFacts(item, t, { locale, timeZone: model.timeZone })}
            />
          ))}
          <RadioCard
            name="fw-cl-repair-item"
            value={OTHER_GARMENT}
            checked={repair.itemKey === OTHER_GARMENT}
            selected={repair.itemKey === OTHER_GARMENT}
            onChange={() => actions?.onRepair?.({ itemKey: OTHER_GARMENT })}
            title={r('link.item.other')}
            description={r('link.item.otherBody')}
          />
        </div>
        <GroupError id={id} text={problem} />
      </fieldset>
      <Field label={t('item.serial')} hint={repair.itemKey === OTHER_GARMENT ? r('link.item.serialNeeded') : t('item.serialHint')} error={error('repair.serial')} htmlFor={serialId} required={repair.itemKey === OTHER_GARMENT}>
        <div className="fw-cl-serial">
          <Input id={serialId} value={repair.serial} autoComplete="off" spellCheck={false} maxLength={REPAIR_LIMITS.serial + 20} onChange={(event) => actions?.onRepair?.({ serial: event.target.value })} />
          <Button onClick={() => actions?.onScan?.('repair.serial')}>
            <ScanLine size={16} aria-hidden /> {t('item.scan')}
          </Button>
        </div>
      </Field>
    </>
  )
}

/** sec:details — a repair or an alteration, what is wrong, the work wanted (no payment data here). */
export function RepairDetailsStep({ page, model, actions }: StepProps) {
  const r = useT('returns-repair')
  const { error } = useShown(model, page)
  const repair = model.form.repair
  return (
    <>
      <fieldset className="fw-cl-fieldset">
        <legend className="fw-cl-legend">{r('common.kind.question')}</legend>
        <div className="fw-cl-rows">
          {REPAIR_KINDS.map((kind) => (
            <RadioCard
              key={kind}
              variant="row"
              name="fw-cl-repair-kind"
              value={kind}
              checked={repair.kind === kind}
              selected={repair.kind === kind}
              onChange={() => actions?.onRepair?.({ kind })}
              title={r(`common.kind.${kind}`)}
              description={r(`common.kind.${kind}Body`)}
            />
          ))}
        </div>
      </fieldset>
      <Field label={r('common.problem')} required={repair.kind === 'REPAIR'} hint={r('common.problemHint')} error={error('repair.problem')} htmlFor={fieldId('repair.problem')}>
        <Textarea id={fieldId('repair.problem')} rows={4} limit={REPAIR_LIMITS.problem} value={repair.problem} onChange={(event) => actions?.onRepair?.({ problem: event.target.value })} />
      </Field>
      <Field label={r('common.workWanted')} required={repair.kind === 'ALTERATION'} hint={r('common.workWantedHint')} error={error('repair.workWanted')} htmlFor={fieldId('repair.workWanted')}>
        <Textarea id={fieldId('repair.workWanted')} rows={3} limit={REPAIR_LIMITS.workWanted} value={repair.workWanted} onChange={(event) => actions?.onRepair?.({ workWanted: event.target.value })} />
      </Field>
      <p className="fw-cl-hint">{r('common.noPayment')}</p>
    </>
  )
}

function Summary({ title, step, actions, children }: { title: string; step: Step; actions?: ClaimActions; children: ReactNode }) {
  const t = useT('link-claim')
  return (
    <section className="fw-cl-summary" aria-label={title}>
      <div className="fw-cl-summary-head">
        <h3 className="fw-cl-h3">{title}</h3>
        <Button size="sm" variant="quiet" aria-label={t('review.changeOf', { what: title })} onClick={() => actions?.onStep?.(step)}>
          {t('review.change')}
        </Button>
      </div>
      {children}
    </section>
  )
}

/** sec:review — the repair's part of Check and send: the garment, what you need, what is wrong, the work wanted. */
export function RepairReview({ page, actions, model }: StepProps) {
  const t = useT('link-claim')
  const r = useT('returns-repair')
  const repair = model.form.repair
  const none = t('review.none')
  const item = repairItemOf(page, repair.itemKey)
  return (
    <>
      <Summary title={t('review.item')} step="item" actions={actions}>
        <KeyValue
          labelCase="sentence"
          items={[
            { label: t('review.item'), value: repair.itemKey === OTHER_GARMENT ? r('link.item.other') : itemTitle(item, t) },
            { label: t('item.serial'), value: repair.serial.trim() || none },
          ]}
        />
      </Summary>
      <Summary title={t('review.details')} step="details" actions={actions}>
        <KeyValue
          labelCase="sentence"
          items={[
            { label: r('common.kind.question'), value: r(`common.kind.${repair.kind}`) },
            { label: r('common.problem'), value: <span className="fw-cl-pre">{repair.problem.trim() || none}</span> },
            { label: r('common.workWanted'), value: <span className="fw-cl-pre">{repair.workWanted.trim() || none}</span> },
          ]}
        />
      </Summary>
    </>
  )
}

const tone = (entry: { open: boolean; next: { forYou: boolean } }): 'warning' | 'neutral' | 'info' => (!entry.open ? 'neutral' : entry.next.forYou ? 'warning' : 'info')

/** This link's repair requests: number, kind, where it stands and the next step (our words by code). */
export function RepairsCard({ offer, timeZone, compact = false }: { offer: RepairOffer | null; timeZone?: string; compact?: boolean }) {
  const r = useT('returns-repair')
  const locale = useLocale()
  if (!offer || offer.repairs.length === 0) return null
  return (
    <Card padded className="fw-cl-card">
      <h2 className="fw-cl-h2 fw-cl-small">{r('link.repairs.title', { count: offer.repairs.length })}</h2>
      {compact && <p className="fw-cl-hint">{r('link.repairs.hint')}</p>}
      <ul className="fw-cl-cases">
        {offer.repairs.map((entry) => (
          <li key={entry.id} className="fw-cl-case">
            <div className="fw-cl-case-head">
              <strong className="fw-cl-number">{entry.number}</strong>
              <span>{r(`common.kind.${entry.kind}`)}</span>
              <Pill tone={tone(entry)}>{r(repairStageKey(entry.stage))}</Pill>
            </div>
            <p className="fw-cl-sub">
              {entry.next.forYou ? <strong>{r('common.yourMove')} </strong> : null}
              {r(repairNextKey(entry.next.code))}
            </p>
            <p className="fw-cl-sub">{[r('common.opened', { day: formatDate(entry.opened, { locale, timeZone }) }), entry.garment.style?.name ?? null, entry.garment.serial ? r('common.serial', { serial: entry.garment.serial }) : null].filter(Boolean).join(' · ')}</p>
          </li>
        ))}
      </ul>
    </Card>
  )
}
