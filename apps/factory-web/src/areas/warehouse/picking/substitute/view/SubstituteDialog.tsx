'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { ArrowLeftRight, Undo2 } from 'lucide-react'
import { Banner, EmptyState, Field, KeyValue } from '@nexus/ui/components'
import { Button, Input, Pill, RadioCard, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { quantity, type Phrase } from '../../../../_shared/stock/model'
import type { SubstituteChoice, SubstituteOptions } from '../api'
import { approvalWords, askHeld, certificateWords, choiceHeld, lotHeld, ruleWords, STATUS_TONE, SUB_NAMESPACE, withdrawHeld, type SubCan } from '../model'
import type { SubstituteActions, SubstituteDialogModel } from '../use-substitute'
import '../../../../_shared/stock/stock.css'
import '../substitute.css'

/**
 * B-W2b-320 — "Use a substitute" (design warehouse.picking pop:pk-sub, MES-139; opened on a short line of a pick list, and by
 * the work order's Materials › Substitute…): the BOM line (picked first when the material has several), what it still needs
 * and what nothing covers, the substitutes already standing (Withdraw with the reason), then the choices — each alternate of
 * the line (first choice first) and another lot of the line's own material — each with its rule, the certificate check,
 * who says yes and how much at most; a held choice says why. For the chosen one: the lot (a lot without a valid chromium VI
 * test, in quarantine or on hold is said and cannot be named), how much and why. "Ask for approval" sends the request to the
 * approver the rule names; nobody approves their own request (the yes is another person's, in Home › Approvals).
 */

/** The words of `warehouse-lots-counts`; a unit code (PCS, M, FT2) is said in the reader's words (`ld.uom.*`), also inside a phrase. */
export function useSubWords() {
  const t = useT(SUB_NAMESPACE)
  return useMemo(() => {
    const unit = (uom: string) => {
      const words = t(`ld.uom.${uom}`)
      return words === `ld.uom.${uom}` ? uom : words
    }
    return { t, unit, say: (words: Phrase | null | undefined) => (words ? t(words.key, words.params && typeof words.params.uom === 'string' ? { ...words.params, uom: unit(words.params.uom) } : words.params) : null) }
  }, [t])
}

export function SubstituteDialog({ model, can, prefix, timeZone, actions }: { model: SubstituteDialogModel; can: SubCan; prefix: string; timeZone: string; actions?: SubstituteActions }) {
  const { t, say } = useSubWords()
  const options = model.options?.value ?? null
  const choice = options && model.draft && model.draft.choice !== null ? (options.choices[model.draft.choice] ?? null) : null
  const held = options && model.draft ? say(askHeld(options, model.draft, can, model.busy)) : null
  const asks = choice?.approval.asks ?? false
  const ask = () => {
    if (!held) actions?.onAsk?.()
  }
  const number = options?.workOrder.number ?? model.target.number ?? ''
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={t('sb.title', { number })}
      subtitle={options ? t('sb.subtitle', { seq: options.line.seq, code: options.line.material.code, name: options.line.material.name }) : undefined}
      size="lg"
      footer={
        <>
          <span className="fw-st-sub">{t('sb.foot')}</span>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onClose?.()}>
            {model.done ? t('sb.close') : t('sb.cancel')}
          </Button>
          {options && model.draft && !model.done && (
            <Button size="sm" variant="primary" heldReason={held} onClick={ask} aria-keyshortcuts="Meta+Enter Control+Enter">
              {model.busy ? <Spinner size={12} /> : <ArrowLeftRight size={13} aria-hidden />} {asks || choice?.needsPerson ? t('sb.ask') : t('sb.record')}
            </Button>
          )}
        </>
      }
    >
      <div
        className="fw-sub"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            ask()
          }
        }}
      >
        {model.problem && <Banner tone="danger" title={say(model.problem) ?? ''} />}
        <Lines model={model} actions={actions} />
        {model.options && !options && (
          model.options.problem ? (
            <EmptyState
              title={t('sb.readFailed')}
              description={t('sb.tryAgain')}
              action={
                <Button size="sm" onClick={() => actions?.onRetry?.()}>
                  {t('sb.retry')}
                </Button>
              }
            />
          ) : (
            <p className="fw-st-sub" role="status">
              <Spinner size={12} /> {t('sb.reading')}
            </p>
          )
        )}
        {options && <LineFacts options={options} />}
        {options && <Standing options={options} model={model} can={can} timeZone={timeZone} actions={actions} />}
        {options && model.done && <Done model={model} options={options} prefix={prefix} actions={actions} />}
        {options && model.draft && !model.done && <Choices options={options} model={model} actions={actions} />}
      </div>
    </Modal>
  )
}

/** The BOM line, picked first when the material (or the work order) has several. */
function Lines({ model, actions }: { model: SubstituteDialogModel; actions?: SubstituteActions }) {
  const { t, unit } = useSubWords()
  const locale = useLocale()
  const lines = model.lines
  if (!lines) return null
  if (!lines.value) {
    return lines.problem ? (
      <EmptyState title={t('sb.linesFailed')} description={t('sb.tryAgain')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('sb.retry')}</Button>} />
    ) : (
      <p className="fw-st-sub" role="status">
        <Spinner size={12} /> {t('sb.reading')}
      </p>
    )
  }
  if (lines.value.length === 0) return <EmptyState title={t('sb.noLines')} description={t('sb.noLinesBody')} />
  if (lines.value.length === 1 && model.bomLineId) return null
  return (
    <div className="fw-sub-form" role="radiogroup" aria-label={t('sb.whichLine')}>
      <p className="fw-sub-h3 wide">{t('sb.whichLine')}</p>
      {lines.value.map((line) => (
        <RadioCard
          key={line.bomLineId}
          name="substitute-line"
          value={line.bomLineId}
          checked={model.bomLineId === line.bomLineId}
          selected={model.bomLineId === line.bomLineId}
          onChange={() => actions?.onPickLine?.(line.bomLineId)}
          title={t('sb.lineTitle', { seq: line.seq, code: [line.itemCode, line.colourCode].filter(Boolean).join(' '), placement: line.placement ?? '—' })}
          description={line.toIssue > 0 ? t('sb.lineOpen', { quantity: quantity(line.toIssue, locale), uom: unit(line.baseUom) }) : t('sb.lineDone')}
        />
      ))}
    </div>
  )
}

function LineFacts({ options }: { options: SubstituteOptions }) {
  const { t, unit } = useSubWords()
  const locale = useLocale()
  const line = options.line
  const q = (value: string) => `${quantity(value, locale)} ${unit(line.material.baseUom)}`
  return (
    <KeyValue
      dense
      columns={3}
      labelCase="sentence"
      items={[
        { label: t('sb.fact.planned'), value: q(line.planned) },
        { label: t('sb.fact.issued'), value: q(line.issued) },
        { label: t('sb.fact.toIssue'), value: q(line.toIssue) },
        { label: t('sb.fact.short'), value: line.ownShort ? <b>{q(line.short)}</b> : t('sb.fact.notShort') },
        { label: t('sb.fact.standing'), value: Number(line.standing) > 0 ? q(line.standing) : '—' },
        { label: t('sb.fact.open'), value: q(line.open) },
      ]}
    />
  )
}

/** The substitutes standing on the line (asked, approved, issued): their state, Withdraw while they wait or are approved. */
function Standing({ options, model, can, timeZone, actions }: { options: SubstituteOptions; model: SubstituteDialogModel; can: SubCan; timeZone: string; actions?: SubstituteActions }) {
  const { t, say, unit } = useSubWords()
  const locale = useLocale()
  if (options.substitutions.length === 0) return null
  return (
    <section className="fw-sub-list" aria-label={t('sb.standingTitle')}>
      <h3 className="fw-sub-h3">{t('sb.standingTitle')}</h3>
      <ul>
        {options.substitutions.map((sub) => {
          const wait = say(withdrawHeld(sub, can))
          return (
            <li key={sub.id}>
              <Pill tone={STATUS_TONE[sub.status]}>{t(`sb.status.${sub.status}`)}</Pill> <b>{[sub.substitute.item.code, sub.substitute.colour?.code].filter(Boolean).join(' ')}</b>
              {sub.substitute.lot ? ` · ${t('sb.lotCode', { code: sub.substitute.lot.code })}` : ''} · {`${quantity(sub.quantity, locale)} ${unit(sub.uom)}`}{' '}
              <span className="fw-st-sub">{t('sb.askedOn', { date: formatDate(sub.createdAt, { locale, timeZone }), by: t(`sb.asked.${sub.asked}`) })}</span>{' '}
              {model.withdraw?.substitution.id === sub.id ? (
                <span className="fw-sub-withdraw">
                  <Field label={t('sb.withdrawReason')} required>
                    <Textarea value={model.withdraw.reason} maxLength={500} rows={2} onChange={(event) => actions?.onWithdrawReason?.(event.target.value)} />
                  </Field>
                  <span className="fw-sub-buttons">
                    <Button size="sm" onClick={() => actions?.onWithdraw?.(null)}>
                      {t('sb.cancel')}
                    </Button>
                    <Button size="sm" variant="danger-outline" heldReason={model.withdraw.reason.trim() ? (model.busy ? t('sb.busy') : null) : t('sb.withdrawWhy')} onClick={() => actions?.onConfirmWithdraw?.()}>
                      <Undo2 size={13} aria-hidden /> {t('sb.withdraw')}
                    </Button>
                  </span>
                </span>
              ) : (
                <Button size="sm" variant="quiet" heldReason={wait} onClick={() => actions?.onWithdraw?.(sub)}>
                  {t('sb.withdraw')}
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function choiceTitle(choice: SubstituteChoice, t: (key: string, params?: Record<string, string | number>) => string): string {
  return choice.alternate ? t('sb.choice.alternate', { priority: choice.alternate.priority, code: choice.item.code, name: choice.item.name }) : t('sb.choice.own', { code: choice.item.code })
}

function Choices({ options, model, actions }: { options: SubstituteOptions; model: SubstituteDialogModel; actions?: SubstituteActions }) {
  const { t, say, unit } = useSubWords()
  const locale = useLocale()
  const draft = model.draft!
  const choice = draft.choice !== null ? (options.choices[draft.choice] ?? null) : null
  if (options.choices.length === 0) return <EmptyState title={t('sb.noChoices')} description={t('sb.noChoicesBody')} />
  const lots = choice?.stock.lots.filter((lot) => lot.lot) ?? []
  const warned = lots.filter((lot) => !lot.usable)
  return (
    <>
      <div className="fw-sub-form" role="radiogroup" aria-label={t('sb.choicesLabel')}>
        <p className="fw-sub-h3 wide">{t('sb.choicesLabel')}</p>
        {options.choices.map((entry, index) => {
          const wait = choiceHeld(entry)
          const cert = certificateWords(entry)
          return (
            <RadioCard
              key={`${entry.kind}-${entry.alternate?.id ?? 'own'}`}
              name="substitute-choice"
              value={String(index)}
              checked={draft.choice === index}
              selected={draft.choice === index}
              disabled={wait !== null}
              onChange={() => actions?.onPickChoice?.(index)}
              title={
                <span>
                  {choiceTitle(entry, t)} {entry.item.isPpeComponent && <Tag tone="info">{t('sb.ppe')}</Tag>}
                </span>
              }
              description={
                <span className="fw-st-cell">
                  <span>{[say(ruleWords(entry)), cert ? say(cert) : null].filter(Boolean).join(' · ')}</span>
                  <span>{[say(approvalWords(entry)), entry.max !== null ? t('sb.max', { max: quantity(entry.max, locale), uom: unit(entry.item.baseUom) }) : null].filter(Boolean).join(' · ')}</span>
                  {wait && <span className="fw-st-warning">{say(wait)}</span>}
                </span>
              }
            />
          )
        })}
      </div>
      {choice && (
        <div className="fw-sub-form">
          <Field label={t('sb.lotLabel')} required={choice.kind === 'OWN_MATERIAL'} hint={choice.kind === 'OWN_MATERIAL' ? t('sb.lotOwnHint') : t('sb.lotAnyHint')}>
            <Select value={draft.lotId ?? ''} onChange={(event) => actions?.onDraft?.({ lotId: event.target.value || null })}>
              <option value="">{choice.kind === 'OWN_MATERIAL' ? t('sb.pickLot') : t('sb.anyLot')}</option>
              {lots.map((lot) => (
                <option key={lot.lot!.id} value={lot.lot!.id} disabled={!lot.usable}>
                  {t('sb.lotOption', { code: lot.lot!.code, colour: lot.colour?.code ?? '—', quantity: quantity(lot.onHand, locale), uom: unit(choice.item.baseUom), places: lot.places.join(', ') })}
                  {lot.usable ? '' : ` · ${t('sb.notUsable')}`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('sb.quantity', { uom: unit(choice.item.baseUom) })} required hint={choice.max !== null ? t('sb.max', { max: quantity(choice.max, locale), uom: unit(choice.item.baseUom) }) : t('sb.noMax')}>
            <Input value={draft.quantity} inputMode="decimal" maxLength={14} onChange={(event) => actions?.onDraft?.({ quantity: event.target.value })} />
          </Field>
          {warned.length > 0 && (
            <ul className="fw-sub-list wide" aria-label={t('sb.warnings')}>
              {warned.map((lot) => (
                <li key={lot.lot!.id} className="fw-st-warning">
                  {say(lotHeld(lot))}
                </li>
              ))}
            </ul>
          )}
          <Field label={t('sb.reason')} required className="wide" hint={t('sb.reasonHint')}>
            <Textarea value={draft.reason} maxLength={1000} rows={2} onChange={(event) => actions?.onDraft?.({ reason: event.target.value })} />
          </Field>
          <Field label={t('sb.note')} className="wide">
            <Textarea value={draft.note} maxLength={2000} rows={2} onChange={(event) => actions?.onDraft?.({ note: event.target.value })} />
          </Field>
          {choice.approval.asks && choice.approval.approver && <p className="fw-st-sub wide">{t('sb.route', { name: choice.approval.approver.name })}</p>}
        </div>
      )}
    </>
  )
}

/** The request sent: waiting for the approver's yes (Home › Approvals), or approved at once (the BOM allows it). */
function Done({ model, options, prefix, actions }: { model: SubstituteDialogModel; options: SubstituteOptions; prefix: string; actions?: SubstituteActions }) {
  const { t } = useSubWords()
  const done = model.done!
  const choice = options.choices.find((entry) => entry.item.id === done.substitution.substitute.item.id)
  return (
    <Banner
      tone={done.approvedAtOnce ? 'success' : 'info'}
      title={done.approvedAtOnce ? t('sb.done.atOnce') : done.approval.asked ? t('sb.done.asked', { name: choice?.approval.approver?.name ?? t('sb.done.theApprover') }) : t('sb.done.saved')}
      action={
        <Button size="sm" onClick={() => actions?.onAnother?.()}>
          {t('sb.another')}
        </Button>
      }
    >
      <span className="fw-st-cell">
        <span>{done.approvedAtOnce ? t('sb.done.atOnceBody') : t('sb.done.askedBody')}</span>
        {done.approval.taskId && (
          <Link className="fw-st-link" href={`${prefix}${recordAddress({ type: 'ApprovalTask', id: done.approval.taskId }, OFFICE_PAGES)}`}>
            {t('sb.done.openApprovals')}
          </Link>
        )}
      </span>
    </Banner>
  )
}
