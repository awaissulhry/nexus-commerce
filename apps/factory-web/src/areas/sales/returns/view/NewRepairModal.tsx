'use client'

import { useEffect, useId } from 'react'
import Link from 'next/link'
import { ScanLine } from 'lucide-react'
import { Banner, Combobox, DateField, Field, Modal } from '@nexus/ui/components'
import { Button, Checkbox, Input, SegmentedControl, Spinner, Textarea } from '@nexus/ui/primitives'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import { newRepairProblems, previewProblemWords, repairHref } from '../model'
import { REPAIR_KINDS, type RepairKind } from '../api'
import type { NewRepairActions, NewRepairModel } from '../view-model'
import { RepairStagePill, say, useDayWords, useWords } from './parts'

/**
 * New repair (design sales.returns/pop:returns.newRepair; band, `n`, an RMA line decided Repair "Make repair order"): the
 * garment's serial (scanned or typed: our serial finds its style, size, colour and when it was made, and its other
 * repairs), the customer, the problem in the customer's words, repair or alteration, and whether the garment came with
 * the customer (then it starts received, with the customer's DDT). From an RMA line the garment, customer and site are
 * the line's. Create repair order (⌘↵) is held with the first thing missing.
 */
export function NewRepairModal({ model, prefix, actions }: { model: NewRepairModel; prefix: string; actions?: NewRepairActions }) {
  const t = useWords()
  const locale = useLocale()
  const dayWords = useDayWords()
  const draft = model.draft
  const ids = { serial: useId(), customer: useId(), problem: useId(), ddt: useId(), ddtDate: useId(), note: useId() }
  const problems = newRepairProblems(draft)
  const apiProblems = model.preview ? previewProblemWords(model.preview.problems, 'repair') : []
  const held = model.busy ? t('quality:common.working') : problems[0] ? say(t, problems[0]) : (model.showProblems || model.fromLine) && apiProblems[0] ? say(t, apiProblems[0]) : null
  const preview = model.preview

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        actions?.onNewRepairSubmit?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions])

  const customers = model.customers.items
  return (
    <Modal
      open
      onClose={() => actions?.onNewRepairClose?.()}
      title={t('newRepair.title')}
      subtitle={model.fromLine ? t('newRepair.fromLine', { number: model.fromLine.returnNumber, seq: model.fromLine.seq }) : t('newRepair.sub')}
      size="lg"
      footer={
        <>
          <span className="fw-q-hint">{t('newRepair.foot')}</span>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onNewRepairClose?.()}>
            {t('quality:common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onNewRepairSubmit?.()} aria-keyshortcuts="Meta+Enter">
            {model.busy ? <Spinner size={12} /> : null} {t('newRepair.submit')}
          </Button>
        </>
      }
    >
      <form
        className="fw-q-stack"
        onSubmit={(event) => {
          event.preventDefault()
          actions?.onNewRepairSubmit?.()
        }}
      >
        {model.problem && <Banner tone="danger" title={say(t, model.problem)} />}
        <SegmentedControl
          ariaLabel={t('newRepair.kind')}
          value={draft.kind}
          onChange={(kind) => actions?.onNewRepairDraft?.({ kind: kind as RepairKind })}
          options={REPAIR_KINDS.map((kind) => ({ value: kind, label: t(`kind.${kind}`) }))}
        />
        {model.fromLine ? (
          <Banner tone="info" title={t('newRepair.lineGarment', { garment: model.fromLine.garment || '—' })}>
            {t('newRepair.lineBody')}
          </Banner>
        ) : (
          <div className="fw-q-form-two">
            <Field label={t('newRepair.serial')} hint={t('newRepair.serialHint')} htmlFor={ids.serial}>
              <span className="fw-q-actions">
                <Input
                  id={ids.serial}
                  value={draft.serial}
                  leadingIcon={<ScanLine size={14} aria-hidden />}
                  onChange={(event) => actions?.onNewRepairDraft?.({ serial: event.target.value })}
                  onBlur={() => draft.serial.trim() && actions?.onNewRepairLookUp?.()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      actions?.onNewRepairLookUp?.()
                    }
                  }}
                  autoComplete="off"
                />
                <Button size="sm" heldReason={draft.serial.trim() ? (model.previewing ? t('quality:common.working') : null) : t('newRepair.lookUpHeld')} onClick={() => actions?.onNewRepairLookUp?.()}>
                  {model.previewing ? <Spinner size={12} /> : null} {t('newRepair.lookUp')}
                </Button>
              </span>
            </Field>
            <Field label={<span id={`${ids.customer}-label`}>{t('newRepair.customer')}</span>} required error={model.showProblems && !draft.partyId ? t('newRepair.problem.customer') : model.customers.problem ? t(model.customers.problem) : undefined} htmlFor={ids.customer}>
              {customers ? (
                <Combobox
                  options={customers.map((party) => ({ value: party.id, label: `${party.code} · ${party.tradeName ?? party.legalName}` }))}
                  value={draft.partyId}
                  onChange={(value) => actions?.onNewRepairDraft?.({ partyId: value })}
                  placeholder={t('newReturn.customerSearch')}
                  labelledBy={`${ids.customer}-label`}
                />
              ) : (
                <Input id={ids.customer} disabled readOnly value="" placeholder={t('newReturn.customerNoList')} />
              )}
            </Field>
          </div>
        )}

        {preview?.garment && (
          <Banner tone={preview.garment.forThisCustomer ? 'info' : 'warning'} title={t(preview.garment.forThisCustomer ? 'newRepair.garmentFound' : 'newRepair.garmentOther')}>
            {t('newRepair.garmentFacts', { day: dayWords(preview.garment.madeOn), workOrder: preview.garment.workOrderNumber, batch: preview.garment.batchNumber ?? '—' })}
          </Banner>
        )}
        {preview && !preview.garment && draft.serial.trim() !== '' && !model.fromLine && <Banner tone="warning" title={t('newRepair.notOurs')} />}
        {preview?.draft?.safetyCheckRequired && <p className="fw-q-hint">{t('newRepair.safetyNeeded')}</p>}
        {preview && preview.history.length > 0 && (
          <Banner tone="warning" title={t('newRepair.history', { count: preview.history.length })}>
            <ul className="fw-q-lines">
              {preview.history.slice(0, 5).map((other) => (
                <li key={other.id}>
                  <Link className="fw-q-link" href={repairHref(prefix, other.id)} target="_blank">
                    {other.number}
                  </Link>{' '}
                  <RepairStagePill stage={other.stage} />
                </li>
              ))}
            </ul>
          </Banner>
        )}

        <Field label={t('newRepair.problemLabel')} required={!model.fromLine} error={model.showProblems && !model.fromLine && !draft.problem.trim() ? t('newRepair.problem.problem') : undefined} hint={model.fromLine ? t('newRepair.problemFromLine') : t('newRepair.problemHint')} htmlFor={ids.problem}>
          <Textarea id={ids.problem} rows={3} value={draft.problem} onChange={(event) => actions?.onNewRepairDraft?.({ problem: event.target.value })} />
        </Field>

        {!model.fromLine && (
          <>
            <Checkbox checked={draft.received} onChange={(event) => actions?.onNewRepairDraft?.({ received: event.target.checked })} label={t('newRepair.received')} />
            {draft.received && (
              <div className="fw-q-form-two">
                <Field label={t('newRepair.ddt')} hint={t('newRepair.ddtHint')} htmlFor={ids.ddt}>
                  <Input id={ids.ddt} value={draft.inboundDdtNumber} onChange={(event) => actions?.onNewRepairDraft?.({ inboundDdtNumber: event.target.value })} />
                </Field>
                <Field label={t('newRepair.ddtDate')} htmlFor={ids.ddtDate}>
                  <DateField id={ids.ddtDate} value={draft.inboundDdtDate} onChange={(value) => actions?.onNewRepairDraft?.({ inboundDdtDate: value })} locale={INTL_LOCALE[locale]} max={model.today} ariaLabel={t('newRepair.ddtDate')} placeholder={t('newRepair.none')} clearLabel={t('newRepair.none')} />
                </Field>
              </div>
            )}
          </>
        )}

        {model.showProblems && apiProblems.length > 0 && (
          <Banner tone="warning" title={t('newReturn.fix')}>
            <ul className="fw-q-lines">
              {apiProblems.map((words) => (
                <li key={words.key}>{say(t, words)}</li>
              ))}
            </ul>
          </Banner>
        )}
        <Field label={t('newReturn.note')} hint={t('newReturn.noteHint')} htmlFor={ids.note}>
          <Textarea id={ids.note} rows={2} value={draft.internalNote} onChange={(event) => actions?.onNewRepairDraft?.({ internalNote: event.target.value })} />
        </Field>
      </form>
    </Modal>
  )
}
