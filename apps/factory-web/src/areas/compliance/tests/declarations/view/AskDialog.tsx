'use client'

import { Banner, Field, MultiSelect, SummaryTable } from '@nexus/ui/components'
import { Button, Checkbox, SegmentedControl, Select, Tag } from '@nexus/ui/primitives'
import { addDays, DECLARATION_LIMITS } from '@nexus/factory-domain/compliance/declarations-asked/rules'
import { DECLARATION_KINDS } from '@nexus/factory-domain/compliance/substances/rules'
import { DateField, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { DEPTH_NAMESPACE } from '../../substances/frame/parts'
import type { AskAnswer, DeclarationKind } from '../api'
import { askFieldProblems, GROUP_TONE, groupWordsKey, sendHeld, sendLabel, type AskDraftState, type DeclarationsCan } from '../model'
import type { AskModel } from '../view-model'

export interface AskActions {
  onAskOpen?: (itemIds: readonly string[], kinds: readonly DeclarationKind[]) => void
  onAskChange?: (draft: AskDraftState) => void
  onAskReview?: () => void
  onAskBack?: () => void
  onAskSend?: () => void
  onAskClose?: () => void
}

const REMINDERS = ['', '3', '7', '14', '30'] as const
const CHANNELS = ['AUTO', 'PORTAL', 'OFFICE'] as const

/**
 * Request declarations (design compliance.tests pop:ts-request, the publish-dialog pattern): the materials and their
 * suppliers, the kinds of declaration, the due day and the reminder cadence, how it goes out; then the review per supplier
 * and kind — what will be sent (a portal task, or an e-mail the office sends by hand), what joins a request that waits, what
 * is skipped and why, in our words — then ONE send and a result per supplier. Nothing reaches a supplier before Send; a
 * supplier's portal is reached only while the Owner switched it on for that party. Fetches nothing.
 */
export function AskDialog({ ask, can, online, actions }: { ask: AskModel; can: DeclarationsCan; online: boolean; actions?: AskActions }) {
  const t = useT(DEPTH_NAMESPACE)
  const q = useT('quality')
  const draft = ask.draft
  const change = (patch: Partial<AskDraftState>) => actions?.onAskChange?.({ ...draft, ...patch })
  const problems = askFieldProblems(draft, ask.today)
  const firstProblem = Object.values(problems)[0] ?? null
  const reviewing = ask.review?.value ?? null
  const label = sendLabel(reviewing)
  const held = sendHeld(reviewing, can, online)
  const footer =
    draft.step === 'form' ? (
      <>
        <Button onClick={() => actions?.onAskClose?.()}>{q('common.close')}</Button>
        <Button variant="primary" heldReason={!can.manage ? t('held.manage') : !online ? t('held.offline') : firstProblem ? t(firstProblem) : null} onClick={() => actions?.onAskReview?.()}>
          {t('ask.review')}
        </Button>
      </>
    ) : draft.step === 'review' ? (
      <>
        <Button onClick={() => actions?.onAskBack?.()}>{t('ask.back')}</Button>
        <Button variant="primary" heldReason={held ? t(held.key, held.params as Record<string, number> | undefined) : ask.review?.value === null ? q('common.loading') : null} onClick={() => actions?.onAskSend?.()}>
          {t(label.key, label.params)}
        </Button>
      </>
    ) : (
      <Button variant="primary" onClick={() => actions?.onAskClose?.()}>
        {t('ask.done')}
      </Button>
    )
  return (
    <Modal open size="lg" title={t('ask.title')} subtitle={t(`ask.step.${draft.step}`)} onClose={() => actions?.onAskClose?.()} footer={footer}>
      {ask.problem && <Banner tone="danger" title={t(ask.problem)} />}
      {draft.step === 'form' && <AskForm ask={ask} problems={problems} onChange={change} />}
      {draft.step === 'review' && (ask.review?.problem ? <Banner tone="danger" title={t('ask.reviewFailed')}>{q(ask.review.problem)}</Banner> : reviewing ? <Review answer={reviewing} done={false} /> : <p className="fw-q-hint" role="status">{q('common.loading')}</p>)}
      {draft.step === 'done' && ask.result && <Review answer={ask.result} done />}
    </Modal>
  )
}

function AskForm({ ask, problems, onChange }: { ask: AskModel; problems: Readonly<Record<string, string>>; onChange: (patch: Partial<AskDraftState>) => void }) {
  const t = useT(DEPTH_NAMESPACE)
  const q = useT('quality')
  const draft = ask.draft
  const options = ask.options.value ?? []
  const chosen = options.filter((option) => draft.itemIds.includes(option.itemId))
  const noSupplier = chosen.filter((option) => option.supplier === null)
  return (
    <div className="fw-q-stack">
      <Field label={t('ask.materials')} hint={t('ask.materialsHint', { max: DECLARATION_LIMITS.materials })} error={problems.materials ? t(problems.materials) : undefined}>
        {ask.options.problem ? (
          <Banner tone="warning" title={t('ask.optionsFailed')}>{q(ask.options.problem)}</Banner>
        ) : (
          <MultiSelect
            searchable
            ariaLabel={t('ask.materials')}
            placeholder={ask.options.value === null ? q('common.loading') : t('ask.materialsPick')}
            searchPlaceholder={t('ask.materialsSearch')}
            options={options.map((option) => ({ value: option.itemId, label: `${option.code} · ${option.name}${option.supplier ? ` — ${option.supplier.code}` : ''}` }))}
            value={[...draft.itemIds]}
            onChange={(next) => onChange({ itemIds: next })}
            width="auto"
          />
        )}
      </Field>
      {noSupplier.length > 0 && <p className="fw-q-hint">{t('ask.noDefaultSupplier', { count: noSupplier.length })}</p>}
      <fieldset className="fw-mt-kinds">
        <legend>{t('ask.kinds')}</legend>
        {DECLARATION_KINDS.filter((kind) => kind !== 'OTHER').map((kind) => (
          <Checkbox
            key={kind}
            checked={draft.kinds.includes(kind)}
            onChange={(event) => onChange({ kinds: event.target.checked ? DECLARATION_KINDS.filter((value) => value === kind || draft.kinds.includes(value)) : draft.kinds.filter((value) => value !== kind) })}
            label={
              <span className="fw-q-cell">
                <span>{t(`kind.${kind}`)}</span>
                <span className="fw-q-hint">{t(`kindWhat.${kind}`)}</span>
              </span>
            }
          />
        ))}
        {problems.kinds && <span className="fw-lab-error" role="alert">{t(problems.kinds)}</span>}
      </fieldset>
      <div className="fw-mt-form">
        <Field label={t('ask.due')} hint={t('ask.dueHint', { days: DECLARATION_LIMITS.dueDays })} error={problems.dueOn ? t(problems.dueOn) : undefined}>
          <DateField value={draft.dueOn} min={ask.today} max={addDays(ask.today, DECLARATION_LIMITS.dueDays)} onChange={(value) => onChange({ dueOn: value })} ariaLabel={t('ask.due')} />
        </Field>
        <Field label={t('ask.reminder')} hint={t('ask.reminderHint')} error={problems.reminderEveryDays ? t(problems.reminderEveryDays) : undefined}>
          <Select value={draft.reminderEveryDays} onChange={(event) => onChange({ reminderEveryDays: event.target.value })} aria-label={t('ask.reminder')}>
            {REMINDERS.map((value) => (
              <option key={value} value={value}>
                {value === '' ? t('ask.reminderNever') : t('ask.reminderEvery', { count: Number(value) })}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label={t('ask.channel')} hint={t(`ask.channelHint.${draft.channel}`)}>
        <SegmentedControl ariaLabel={t('ask.channel')} options={CHANNELS.map((value) => ({ value, label: t(`ask.channelOption.${value}`) }))} value={draft.channel} onChange={(value) => onChange({ channel: value as AskDraftState['channel'] })} wrap />
      </Field>
      <Field label={t('ask.message')} hint={t('ask.messageHint')} error={problems.message ? t(problems.message) : undefined}>
        <Textarea rows={3} value={draft.message} maxLength={DECLARATION_LIMITS.message} onChange={(event) => onChange({ message: event.target.value })} />
      </Field>
    </div>
  )
}

function Review({ answer, done }: { answer: AskAnswer; done: boolean }) {
  const t = useT(DEPTH_NAMESPACE)
  const locale = useLocale()
  return (
    <div className="fw-q-stack">
      <Banner tone={done ? 'success' : answer.counts.send + answer.counts.add === 0 ? 'warning' : 'info'} title={t(done ? 'ask.doneTitle' : 'ask.reviewTitle', { send: answer.counts.send, add: answer.counts.add, skip: answer.counts.skip })}>
        {answer.svhcListVersion && <span>{t('ask.svhcList', { day: formatDate(answer.svhcListVersion.publishedOn, { locale }), count: answer.svhcListVersion.entryCount })}</span>}
      </Banner>
      <SummaryTable
        label={t('ask.reviewTable')}
        stackOnPhone
        columns={[t('ask.col.supplier'), t('ask.col.kind'), t('ask.col.materials'), t('ask.col.outcome')]}
        rows={answer.groups.map((group, index) => ({
          id: `${group.party.id}:${group.kind}:${index}`,
          cells: [
            <span key="s" className="fw-q-cell">
              <span className="fw-q-code">{group.party.code}</span>
              <span className="fw-q-hint">{`${group.party.name} · ${t(group.party.portalOn ? 'ask.portalOn' : 'ask.portalOff')}`}</span>
            </span>,
            t(`kind.${group.kind}`),
            group.materials.map((material) => material.articleLabel).join('; '),
            <span key="o" className="fw-q-cell">
              <Tag tone={GROUP_TONE[group.outcome]}>{t(`ask.outcome.${group.outcome}`)}</Tag>
              <span className="fw-q-hint">{t(done && group.outcome !== 'SKIP' && group.request ? `ask.group.done${group.outcome}` : groupWordsKey(group, answer), { number: group.request?.number ?? '', party: group.party.code })}</span>
            </span>,
          ],
        }))}
      />
    </div>
  )
}
