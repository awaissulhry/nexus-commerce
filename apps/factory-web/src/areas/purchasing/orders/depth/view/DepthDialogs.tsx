'use client'

import { Plus, Trash2 } from 'lucide-react'
import { Banner, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Checkbox, Input, Radio, Select, Spinner } from '@nexus/ui/primitives'
import { DateField, Modal, StepUpModal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { quantity } from '../../../../_shared/buying/model'
import type { PurchaseOrder } from '../../api'
import { MAX_DELIVERIES } from '@nexus/factory-domain/purchasing/po-depth/schedule'
import { OVERRIDE_REASON, SOURCES } from '../api'
import {
  copyableLines,
  DEPTH,
  duplicateDraftHeld,
  heldRequirements,
  kindDraftHeld,
  kindFields,
  overrideDecideHeld,
  overrideReasonHeld,
  rateDraftHeld,
  requirementPhrase,
  scheduleHeld,
  scheduleTotal,
  splitEvenly,
  supplierDateDraftHeld,
  type DepthDialog,
  type OrderDepthActions,
  type OrderDepthModel,
} from '../model'
import { RequirementLaw } from './LinesDepth'
import { useDay, useDepthSay } from './words'

const dateLocale = (locale: string) => (locale === 'it' ? 'it-IT' : 'en-GB')

/**
 * The PO studio's depth dialogs (B-W2b-333): Split into deliveries (the schedule: rows of quantity, day and note, Split
 * evenly, the sum against the line), Back to one delivery, the supplier's day (its first one, or a move with who and why),
 * the rate at order, a line's rolls / certificate / variant, "Send without a valid document?" (which document, which lines,
 * why it matters, the reason; a second person approves), the second person's yes or no (a yes asks a fresh code), taking a
 * request back, and Duplicate or reorder. Each refusal is said inside its dialog in this app's words.
 */
export function DepthDialogs({ order, model, actions }: { order: PurchaseOrder; model: OrderDepthModel; actions?: OrderDepthActions }) {
  const dialog = model.dialog
  const stepUp = model.stepUp?.open ? <DecideStepUp model={model} actions={actions} /> : null
  if (!dialog) return stepUp
  const body = (() => {
    switch (dialog.kind) {
      case 'schedule':
        return <ScheduleDialog order={order} model={model} actions={actions} dialog={dialog} />
      case 'clearSchedule':
        return <ClearScheduleDialog order={order} model={model} actions={actions} dialog={dialog} />
      case 'supplierDate':
        return <SupplierDateDialog order={order} model={model} actions={actions} dialog={dialog} />
      case 'rate':
        return <RateDialog order={order} model={model} actions={actions} dialog={dialog} />
      case 'lineKind':
        return <LineKindDialog order={order} model={model} actions={actions} dialog={dialog} />
      case 'override':
        return <OverrideDialog order={order} model={model} actions={actions} dialog={dialog} />
      case 'decide':
        return <DecideDialog order={order} model={model} actions={actions} dialog={dialog} />
      case 'withdrawOverride':
      case 'withdrawApproval':
        return <WithdrawDialog order={order} model={model} actions={actions} dialog={dialog} />
      case 'duplicate':
        return <DuplicateDialog order={order} model={model} actions={actions} dialog={dialog} />
    }
  })()
  return (
    <>
      {body}
      {stepUp}
    </>
  )
}

type DialogProps<K extends DepthDialog['kind']> = { order: PurchaseOrder; model: OrderDepthModel; actions?: OrderDepthActions; dialog: Extract<DepthDialog, { kind: K }> }

function Footer({ model, actions, label, held, tone, onConfirm }: { model: OrderDepthModel; actions?: OrderDepthActions; label: string; held: string | null; tone?: 'danger'; onConfirm?: () => void }) {
  const tb = useT('buying')
  return (
    <>
      <span className="grow" />
      <Button size="sm" onClick={() => actions?.onDialog?.(null)} heldReason={model.busy ? tb('held.busy') : null}>
        {tb('common.cancel')}
      </Button>
      <Button size="sm" variant="primary" tone={tone} heldReason={model.busy ? tb('held.busy') : held} onClick={onConfirm} aria-keyshortcuts="Meta+Enter Control+Enter">
        {model.busy && <Spinner size={12} />} {label}
      </Button>
    </>
  )
}

/** ⌘↵ confirms a dialog when nothing holds it. */
function onSubmitKey(held: string | null, run?: () => void) {
  return (event: React.KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !held) {
      event.preventDefault()
      run?.()
    }
  }
}

function Problem({ model }: { model: OrderDepthModel }) {
  const say = useDepthSay('buying')
  return model.problem ? <Banner tone="danger" title={say(model.problem) ?? ''} /> : null
}

function ScheduleDialog({ order, model, actions, dialog }: DialogProps<'schedule'>) {
  const t = useT(DEPTH)
  const tb = useT('buying')
  const say = useDepthSay()
  const locale = useLocale()
  const line = model.depth.value?.lines.find((entry) => entry.id === dialog.lineId)
  const poLine = order.lines.find((entry) => entry.id === dialog.lineId)
  if (!line || !poLine) return null
  const held = say(scheduleHeld(line, dialog.rows, model.today))
  const total = scheduleTotal(dialog.rows)
  const unit = tb(`uom.${line.uom}`)
  const set = (rows: typeof dialog.rows) => actions?.onDialog?.({ ...dialog, rows })
  const edit = (index: number, field: 'quantity' | 'needDate' | 'note', value: string) => set(dialog.rows.map((row, at) => (at === index ? { ...row, [field]: value } : row)))
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('scheduleDialog.title', { seq: line.seq, item: `${poLine.item.code} ${poLine.item.name}` })}
      subtitle={t('scheduleDialog.subtitle', { quantity: quantity(line.quantity, locale, 4), unit })}
      size="lg"
      footer={<Footer model={model} actions={actions} label={t('scheduleDialog.save', { count: dialog.rows.length })} held={held} onConfirm={() => actions?.onSaveSchedule?.()} />}
    >
      <div className="fw-by-dialog" onKeyDown={onSubmitKey(held, actions?.onSaveSchedule)}>
        <ul className="fw-by-list">
          <li>{t('scheduleDialog.firstIsNeed')}</li>
          <li>{t('scheduleDialog.supplierSees')}</li>
        </ul>
        <div className="fw-pod-rows" role="group" aria-label={t('scheduleDialog.rowsLabel')}>
          {dialog.rows.map((row, index) => (
            <div key={index} className="fw-pod-row">
              <Field label={t('scheduleDialog.quantity', { n: index + 1 })}>
                <Input size="sm" inputMode="decimal" value={row.quantity} onChange={(event) => edit(index, 'quantity', event.target.value)} aria-describedby="fw-pod-sum" />
              </Field>
              <Field label={t('scheduleDialog.day', { n: index + 1 })}>
                <DateField value={row.needDate} onChange={(value) => edit(index, 'needDate', value)} locale={dateLocale(locale)} />
              </Field>
              <Field label={t('scheduleDialog.note', { n: index + 1 })}>
                <Input size="sm" value={row.note} maxLength={2000} onChange={(event) => edit(index, 'note', event.target.value)} />
              </Field>
              <Button size="sm" variant="quiet" tone="danger" aria-label={t('scheduleDialog.remove', { n: index + 1 })} heldReason={dialog.rows.length <= 2 ? t('schedule.held.two') : null} onClick={() => set(dialog.rows.filter((_, at) => at !== index))}>
                <Trash2 size={14} aria-hidden />
              </Button>
            </div>
          ))}
        </div>
        <div className="fw-by-actions">
          <Button size="sm" heldReason={dialog.rows.length >= MAX_DELIVERIES ? t('schedule.held.many', { count: MAX_DELIVERIES }) : null} onClick={() => set([...dialog.rows, { quantity: '', needDate: dialog.rows[dialog.rows.length - 1]?.needDate ?? line.needDate, note: '' }])}>
            <Plus size={14} aria-hidden /> {t('scheduleDialog.add')}
          </Button>
          <Button size="sm" variant="quiet" onClick={() => set(splitEvenly(line.quantity, dialog.rows.length, dialog.rows[0]?.needDate || line.needDate, 7))}>
            {t('scheduleDialog.even', { count: dialog.rows.length })}
          </Button>
        </div>
        <p id="fw-pod-sum" className={total !== null && total === String(Number(line.quantity)) ? 'fw-by-hint' : 'fw-by-hint fw-by-warning'} role="status">
          {total === null ? t('scheduleDialog.sumUnknown') : t('scheduleDialog.sum', { total: quantity(total, locale, 4), quantity: quantity(line.quantity, locale, 4), unit })}
        </p>
        <Problem model={model} />
      </div>
    </Modal>
  )
}

function ClearScheduleDialog({ model, actions, dialog }: DialogProps<'clearSchedule'>) {
  const t = useT(DEPTH)
  const day = useDay()
  const line = model.depth.value?.lines.find((entry) => entry.id === dialog.lineId)
  if (!line) return null
  return (
    <Modal open onClose={() => actions?.onDialog?.(null)} title={t('clear.title', { seq: line.seq })} size="sm" footer={<Footer model={model} actions={actions} label={t('clear.confirm')} held={null} onConfirm={() => actions?.onClearSchedule?.()} />}>
      <div className="fw-by-dialog">
        <p>{t('clear.body', { count: line.deliveries.length, date: day(line.needDate) })}</p>
        <Problem model={model} />
      </div>
    </Modal>
  )
}

function SupplierDateDialog({ order, model, actions, dialog }: DialogProps<'supplierDate'>) {
  const t = useT(DEPTH)
  const say = useDepthSay()
  const day = useDay()
  const locale = useLocale()
  const draft = dialog.draft
  const line = model.depth.value?.lines.find((entry) => entry.id === draft.lineId)
  const delivery = line?.deliveries.find((entry) => entry.id === draft.deliveryId) ?? null
  const held = say(supplierDateDraftHeld(draft))
  const set = (next: Partial<typeof draft>) => actions?.onDialog?.({ kind: 'supplierDate', draft: { ...draft, ...next } })
  const asked = delivery?.needDate ?? line?.needDate ?? draft.from
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t(draft.mode === 'FIRST' ? 'date.titleFirst' : 'date.titleMove', { seq: line?.seq ?? '', n: delivery?.seq ?? 1 })}
      subtitle={t('date.asked', { date: day(asked), supplier: order.supplier.name })}
      size="md"
      footer={<Footer model={model} actions={actions} label={t(draft.mode === 'FIRST' ? 'date.saveFirst' : 'date.saveMove')} held={held} onConfirm={() => actions?.onSupplierDate?.()} />}
    >
      <div className="fw-by-dialog" onKeyDown={onSubmitKey(held, actions?.onSupplierDate)}>
        <p className="fw-by-hint">{t(draft.mode === 'FIRST' ? 'date.firstHint' : 'date.moveHint', { date: day(draft.from) })}</p>
        <Field label={t('date.day')} required>
          <DateField value={draft.date} onChange={(value) => set({ date: value })} locale={dateLocale(locale)} />
        </Field>
        {draft.date && draft.date > asked && <p className="fw-by-hint fw-by-warning">{t('date.later', { count: Math.round((Date.parse(`${draft.date}T12:00:00Z`) - Date.parse(`${asked}T12:00:00Z`)) / 86_400_000) })}</p>}
        <Field label={t('date.source')}>
          <div className="fw-by-inline" role="radiogroup" aria-label={t('date.source')}>
            {SOURCES.map((source) => (
              <Radio key={source} name="fw-pod-source" checked={draft.source === source} onChange={() => set({ source })} label={t(`date.sourceOf.${source}`)} />
            ))}
          </div>
        </Field>
        {draft.source === 'SUPPLIER' && (
          <Field label={t('date.contact')} hint={t('date.contactHint')}>
            <Input size="sm" value={draft.contact} maxLength={200} onChange={(event) => set({ contact: event.target.value })} />
          </Field>
        )}
        {draft.mode === 'MOVED' && (
          <Field label={t('date.reason')} required hint={t('date.reasonHint')}>
            <Textarea rows={3} maxLength={2000} value={draft.reason} onChange={(event) => set({ reason: event.target.value })} />
          </Field>
        )}
        <Problem model={model} />
      </div>
    </Modal>
  )
}

function RateDialog({ order, model, actions, dialog }: DialogProps<'rate'>) {
  const t = useT(DEPTH)
  const say = useDepthSay()
  const currency = model.depth.value?.currency
  const held = say(rateDraftHeld(dialog.rate))
  return (
    <Modal open onClose={() => actions?.onDialog?.(null)} title={t('rate.title', { number: order.number })} size="sm" footer={<Footer model={model} actions={actions} label={t('rate.save')} held={held} onConfirm={() => actions?.onRate?.()} />}>
      <div className="fw-by-dialog" onKeyDown={onSubmitKey(held, actions?.onRate)}>
        <Field label={t('rate.label', { company: currency?.company ?? '', order: currency?.order ?? order.currency })} required hint={t('rate.hint')}>
          <Input size="sm" inputMode="decimal" value={dialog.rate} onChange={(event) => actions?.onDialog?.({ kind: 'rate', rate: event.target.value })} autoFocus />
        </Field>
        <ul className="fw-by-list">
          <li>{t('rate.frozen')}</li>
          <li>{t('rate.accountant')}</li>
        </ul>
        <Problem model={model} />
      </div>
    </Modal>
  )
}

function LineKindDialog({ order, model, actions, dialog }: DialogProps<'lineKind'>) {
  const t = useT(DEPTH)
  const say = useDepthSay()
  const day = useDay()
  const line = model.kinds.value?.lines.find((entry) => entry.id === dialog.draft.lineId)
  const poLine = order.lines.find((entry) => entry.id === dialog.draft.lineId)
  if (!line || !poLine) return null
  const fields = kindFields(line)
  const draft = dialog.draft
  const held = say(kindDraftHeld(line, draft))
  const set = (next: Partial<typeof draft>) => actions?.onDialog?.({ kind: 'lineKind', draft: { ...draft, ...next } })
  return (
    <Modal open onClose={() => actions?.onDialog?.(null)} title={t('kindDialog.title', { seq: line.seq, item: `${poLine.item.code} ${poLine.item.name}` })} size="md" footer={<Footer model={model} actions={actions} label={t('kindDialog.save')} held={held} onConfirm={() => actions?.onLineKind?.()} />}>
      <div className="fw-by-dialog" onKeyDown={onSubmitKey(held, actions?.onLineKind)}>
        {fields.rolls && (
          <fieldset className="fw-pod-fieldset">
            <legend>{t('kindDialog.rolls')}</legend>
            <Checkbox checked={draft.byRolls} onChange={(event) => set({ byRolls: event.target.checked, count: event.target.checked && !draft.count ? '1' : draft.count })} label={t('kindDialog.byRolls')} />
            {draft.byRolls && (
              <div className="fw-by-fields">
                <Field label={t('kindDialog.count')} required>
                  <Input size="sm" inputMode="numeric" value={draft.count} onChange={(event) => set({ count: event.target.value })} />
                </Field>
                <Field label={t('kindDialog.length')}>
                  <Input size="sm" inputMode="decimal" value={draft.lengthM} onChange={(event) => set({ lengthM: event.target.value })} />
                </Field>
                <Field label={t('kindDialog.width')} hint={line.materialWidthCm ? t('kindDialog.widthHint', { width: line.materialWidthCm.replace(/\.?0+$/, '') }) : undefined}>
                  <Input size="sm" inputMode="decimal" value={draft.widthCm} onChange={(event) => set({ widthCm: event.target.value })} />
                </Field>
              </div>
            )}
            <p className="fw-by-hint">{t('kindDialog.rollsHint')}</p>
          </fieldset>
        )}
        {fields.certificate && (
          <Field label={t('kindDialog.certificate')} hint={line.certificateChoices.length === 0 ? t('kindDialog.noChoices') : t('kindDialog.certificateHint')}>
            <Select size="sm" value={draft.certificateId} onChange={(event) => set({ certificateId: event.target.value })}>
              <option value="">{t('kindDialog.noCertificate')}</option>
              {line.certificate && !line.certificateChoices.some((choice) => choice.id === line.certificate!.id) && (
                <option value={line.certificate.id}>{t('kindDialog.certificateNow', { number: line.certificate.number, standard: line.certificate.standard })}</option>
              )}
              {line.certificateChoices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {t(choice.coverage === 'THIS_SUPPLIER' ? 'kindDialog.choiceThis' : 'kindDialog.choiceAny', { number: choice.number, standard: choice.standard, date: day(choice.validTo) })}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {fields.variant && (
          <Field label={t('kindDialog.variant')} hint={line.keepsVariantsApart ? t('kindDialog.variantApart') : t('kindDialog.variantOneBalance')}>
            <Select size="sm" value={draft.variantCode} onChange={(event) => set({ variantCode: event.target.value })}>
              <option value="">{t('kindDialog.noVariant')}</option>
              {line.variant && !line.variantChoices.some((choice) => choice.code === line.variant!.code) && <option value={line.variant.code}>{line.variant.code}</option>}
              {line.variantChoices.map((choice) => (
                <option key={choice.code} value={choice.code}>
                  {[choice.code, choice.size ? t('kindDialog.size', { size: choice.size }) : null, choice.supplierCode].filter(Boolean).join(' · ')}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Problem model={model} />
      </div>
    </Modal>
  )
}

/** "Send without a valid document?" (design pop:override): which document, which lines, why it matters; the reason; a second person approves. */
function OverrideDialog({ order, model, actions, dialog }: DialogProps<'override'>) {
  const t = useT(DEPTH)
  const say = useDepthSay()
  const held = heldRequirements(model.compliance.value)
  const reasonHeld = say(overrideReasonHeld(dialog.reason))
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('override.title')}
      subtitle={t('override.subtitle', { number: order.number, supplier: order.supplier.name })}
      size="md"
      footer={<Footer model={model} actions={actions} label={t('override.ask')} held={reasonHeld} onConfirm={() => actions?.onAskOverride?.()} />}
    >
      <div className="fw-by-dialog" onKeyDown={onSubmitKey(reasonHeld, actions?.onAskOverride)}>
        <SummaryTable
          label={t('override.whatHolds')}
          stackOnPhone
          columns={[t('override.col.document'), t('override.col.lines'), t('override.col.why')]}
          align={['left', 'left', 'left']}
          rows={held.map((requirement, index) => ({
            id: `${requirement.kind}-${index}`,
            cells: [
              <span key="doc" className="fw-by-cell">
                <span>{say(requirementPhrase(requirement))}</span>
                <span>
                  <RequirementLaw requirement={requirement} />
                </span>
              </span>,
              t('override.lines', { lines: requirement.seqs.join(', '), items: requirement.itemCodes.join(', ') }),
              t(`override.why.${requirement.kind}`),
            ],
          }))}
        />
        <Field label={t('override.reason')} required hint={t('override.reasonHint', { min: OVERRIDE_REASON.min })}>
          <Textarea rows={3} maxLength={OVERRIDE_REASON.max} value={dialog.reason} onChange={(event) => actions?.onDialog?.({ kind: 'override', reason: event.target.value })} autoFocus />
        </Field>
        <ul className="fw-by-list">
          <li>{t('override.second')}</li>
          <li>{t('override.never')}</li>
          <li>{t('override.covers')}</li>
        </ul>
        <Problem model={model} />
      </div>
    </Modal>
  )
}

/** The second person's decision: what holds the order, the asker's reason; Approve (a fresh code) or Refuse (words required). */
function DecideDialog({ order, model, actions, dialog }: DialogProps<'decide'>) {
  const t = useT(DEPTH)
  const say = useDepthSay()
  const compliance = model.compliance.value
  const request = compliance?.request ?? null
  const decideHeld = compliance ? say(overrideDecideHeld(compliance, model.can)) : t('decide.held.none')
  const wordsHeld = dialog.decision === 'REJECTED' && !dialog.words.trim() ? t('decide.held.words') : null
  const held = decideHeld ?? wordsHeld
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('decide.title', { number: order.number })}
      size="md"
      footer={<Footer model={model} actions={actions} label={t(dialog.decision === 'APPROVED' ? 'decide.approve' : 'decide.reject')} tone={dialog.decision === 'REJECTED' ? 'danger' : undefined} held={held} onConfirm={() => actions?.onDecide?.()} />}
    >
      <div className="fw-by-dialog">
        <ul className="fw-by-list">
          {heldRequirements(compliance).map((requirement, index) => (
            <li key={`${requirement.kind}-${index}`}>{say(requirementPhrase(requirement))}</li>
          ))}
        </ul>
        {request && <p>{t('decide.asked', { name: request.askedBy.name ?? '—', reason: request.reason })}</p>}
        <div className="fw-by-inline" role="radiogroup" aria-label={t('decide.choice')}>
          <Radio name="fw-pod-decision" checked={dialog.decision === 'APPROVED'} onChange={() => actions?.onDialog?.({ ...dialog, decision: 'APPROVED' })} label={t('decide.yes')} />
          <Radio name="fw-pod-decision" checked={dialog.decision === 'REJECTED'} onChange={() => actions?.onDialog?.({ ...dialog, decision: 'REJECTED' })} label={t('decide.no')} />
        </div>
        <Field label={t(dialog.decision === 'REJECTED' ? 'decide.wordsNo' : 'decide.wordsYes')} required={dialog.decision === 'REJECTED'}>
          <Textarea rows={3} maxLength={2000} value={dialog.words} onChange={(event) => actions?.onDialog?.({ ...dialog, words: event.target.value })} />
        </Field>
        <p className="fw-by-hint">{t(dialog.decision === 'APPROVED' ? 'decide.yesHint' : 'decide.noHint')}</p>
        <Problem model={model} />
      </div>
    </Modal>
  )
}

function DecideStepUp({ model, actions }: { model: OrderDepthModel; actions?: OrderDepthActions }) {
  const t = useT(DEPTH)
  const step = model.stepUp!
  const key = step.sentence.startsWith(`${DEPTH}:`) ? step.sentence.slice(DEPTH.length + 1) : step.sentence
  return <StepUpModal open title={t('stepUp.title')} sentence={t(key)} busy={step.busy} error={step.problem ? t(step.problem) : null} onSubmit={(code) => actions?.stepUp?.onSubmit?.(code)} onClose={() => actions?.stepUp?.onClose?.()} confirmLabel={t('stepUp.confirm')} />
}

function WithdrawDialog({ model, actions, dialog }: DialogProps<'withdrawOverride' | 'withdrawApproval'>) {
  const t = useT(DEPTH)
  const approval = dialog.kind === 'withdrawApproval'
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t(approval ? 'withdraw.approvalTitle' : 'withdraw.overrideTitle')}
      size="sm"
      footer={<Footer model={model} actions={actions} label={t('withdraw.confirm')} held={null} onConfirm={() => (approval ? actions?.onWithdrawApproval?.() : actions?.onWithdrawOverride?.())} />}
    >
      <div className="fw-by-dialog">
        <p>{t(approval ? 'withdraw.approvalBody' : 'withdraw.overrideBody')}</p>
        {dialog.kind === 'withdrawApproval' && (
          <Field label={t('withdraw.note')}>
            <Textarea rows={2} maxLength={4000} value={dialog.note} onChange={(event) => actions?.onDialog?.({ kind: 'withdrawApproval', note: event.target.value })} />
          </Field>
        )}
        <Problem model={model} />
      </div>
    </Modal>
  )
}

/** Duplicate or reorder (SCM-057): the lines to copy (every line not cancelled by default), one need date or each its own. */
function DuplicateDialog({ order, model, actions, dialog }: DialogProps<'duplicate'>) {
  const t = useT(DEPTH)
  const tb = useT('buying')
  const say = useDepthSay()
  const locale = useLocale()
  const lines = copyableLines(order)
  const draft = dialog.draft
  const held = say(duplicateDraftHeld(draft, model.today))
  const set = (next: Partial<typeof draft>) => actions?.onDialog?.({ kind: 'duplicate', draft: { ...draft, ...next } })
  const reorder = draft.lineIds.length < lines.length
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t(reorder ? 'duplicate.titleReorder' : 'duplicate.title', { number: order.number })}
      subtitle={t('duplicate.subtitle', { supplier: order.supplier.name })}
      size="md"
      footer={<Footer model={model} actions={actions} label={t('duplicate.confirm', { count: draft.lineIds.length })} held={held} onConfirm={() => actions?.onDuplicate?.()} />}
    >
      <div className="fw-by-dialog" onKeyDown={onSubmitKey(held, actions?.onDuplicate)}>
        <div className="fw-by-stack" role="group" aria-label={t('duplicate.lines')}>
          {lines.map((line) => (
            <Checkbox
              key={line.id}
              checked={draft.lineIds.includes(line.id)}
              onChange={(event) => set({ lineIds: event.target.checked ? [...new Set([...draft.lineIds, line.id])] : draft.lineIds.filter((id) => id !== line.id) })}
              label={`${line.seq} · ${line.item.code} ${line.item.name} · ${quantity(line.quantity, locale)} ${tb(`uom.${line.uom}`)}`}
            />
          ))}
        </div>
        <Field label={t('duplicate.needDate')} hint={t('duplicate.needDateHint')}>
          <DateField value={draft.needDate} onChange={(value) => set({ needDate: value })} locale={dateLocale(locale)} clearable clearLabel={tb('common.clear')} />
        </Field>
        <ul className="fw-by-list">
          <li>{t('duplicate.copies')}</li>
          <li>{t('duplicate.prices')}</li>
          <li>{t('duplicate.notCopied')}</li>
        </ul>
        <Problem model={model} />
      </div>
    </Modal>
  )
}
