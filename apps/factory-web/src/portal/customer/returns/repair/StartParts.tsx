'use client'

import { Field } from '@nexus/ui/components'
import { Input, RadioCard, Select } from '@nexus/ui/primitives'
import { Textarea } from '../../../../lib/i18n/ds-parts'
import { useScopedT, useT } from '../../../../lib/i18n/provider'
import type { ReturnableItem, ReturnableRead } from '../api'
import { itemFacts } from '../model'
import { REPAIR_KINDS } from './api'
import { LIMITS, NS, OTHER_GARMENT, repairItems, type RepairDraft } from './model'

/**
 * SCR-187 › "Start a return or claim" › Repair or alteration (B-W2b-342; RR1:02; design portal.customer.returns h.act "the
 * same forms as links.claim"): the repair's details — the garment (one of what we delivered, or another one by the serial
 * on its label), a repair or an alteration, what is wrong and the work wanted (no payment data here: an estimate comes
 * first) — and its part of Check and send. Photos are added on the repair's page once it exists (the API takes photos of a
 * repair, not of a draft), as a return's.
 */

export interface RepairStartProps {
  draft: RepairDraft
  read: ReturnableRead
  /** The problems shown at their fields: field → a key (`returns-repair:…`). */
  problems: Readonly<Record<string, string>>
  onDraft?: (patch: Partial<RepairDraft>) => void
}

const name = (item: ReturnableItem, t: (key: string, params?: Record<string, string | number>) => string) => [item.style ? `${item.style.code} ${item.style.name}` : item.description, ...itemFacts(item, t)].join(' · ')

export function RepairStartDetails({ draft, read, problems, onDraft }: RepairStartProps) {
  const r = useT(NS)
  const t = useT('portal-returns')
  const scoped = useScopedT(NS)
  const problem = (field: string) => (problems[field] ? scoped(problems[field]!, { max: field === 'repairSerial' ? LIMITS.serial : field === 'problem' ? LIMITS.problem : LIMITS.workWanted }) : undefined)
  return (
    <div className="fw-pret-dialog">
      <Field label={r('portal.start.garment')} hint={r('portal.start.garmentHint')} error={problem('repairItem')} required>
        <Select value={draft.repairItem} onChange={(event) => onDraft?.({ repairItem: event.target.value })}>
          <option value="">{r('portal.start.garmentPick')}</option>
          {repairItems(read).map((item) => (
            <option key={item.key} value={item.key}>
              {name(item, t)}
            </option>
          ))}
          <option value={OTHER_GARMENT}>{r('portal.start.garmentOther')}</option>
        </Select>
      </Field>
      <div className="fw-pret-fields">
        <Field label={t('start.serial')} hint={draft.repairItem === OTHER_GARMENT ? r('link.item.serialNeeded') : t('start.serialHint')} error={problem('repairSerial')} required={draft.repairItem === OTHER_GARMENT}>
          <Input value={draft.repairSerial} autoComplete="off" spellCheck={false} maxLength={LIMITS.serial + 20} onChange={(event) => onDraft?.({ repairSerial: event.target.value })} />
        </Field>
      </div>
      <fieldset className="fw-pret-choices">
        <legend className="fw-pret-h3">{r('common.kind.question')}</legend>
        {REPAIR_KINDS.map((kind) => (
          <RadioCard key={kind} variant="row" name="fw-pret-repair-kind" value={kind} checked={draft.repairKind === kind} selected={draft.repairKind === kind} onChange={() => onDraft?.({ repairKind: kind })} title={r(`common.kind.${kind}`)} description={r(`common.kind.${kind}Body`)} />
        ))}
      </fieldset>
      <Field label={r('common.problem')} hint={r('common.problemHint')} error={problem('problem')} required={draft.repairKind === 'REPAIR'}>
        <Textarea className="fw-pret-note" limit={LIMITS.problem} value={draft.problem} onChange={(event) => onDraft?.({ problem: event.target.value })} />
      </Field>
      <Field label={r('common.workWanted')} hint={r('common.workWantedHint')} error={problem('workWanted')} required={draft.repairKind === 'ALTERATION'}>
        <Textarea className="fw-pret-note" limit={LIMITS.workWanted} value={draft.workWanted} onChange={(event) => onDraft?.({ workWanted: event.target.value })} />
      </Field>
      <p className="fw-pret-hint">{r('common.noPayment')}</p>
    </div>
  )
}

/** sec:review — the repair's one screen before Send. */
export function RepairStartReview({ draft, read }: Pick<RepairStartProps, 'draft' | 'read'>) {
  const r = useT(NS)
  const t = useT('portal-returns')
  const item = draft.repairItem && draft.repairItem !== OTHER_GARMENT ? (repairItems(read).find((entry) => entry.key === draft.repairItem) ?? null) : null
  return (
    <div className="fw-pret-dialog">
      <h3 className="fw-pret-h3">{r('portal.start.review')}</h3>
      <dl className="fw-pret-facts">
        <dt>{r('portal.start.garment')}</dt>
        <dd>{item ? name(item, t) : r('portal.start.garmentOther')}</dd>
        <dt>{t('start.serial')}</dt>
        <dd>{draft.repairSerial.trim() || '—'}</dd>
        <dt>{r('common.kind.question')}</dt>
        <dd>{r(`common.kind.${draft.repairKind}`)}</dd>
        <dt>{r('common.problem')}</dt>
        <dd className="fw-pret-pre">{draft.problem.trim() || '—'}</dd>
        <dt>{r('common.workWanted')}</dt>
        <dd className="fw-pret-pre">{draft.workWanted.trim() || '—'}</dd>
      </dl>
      <p className="fw-pret-hint">{r('portal.start.photosAfter')}</p>
    </div>
  )
}
