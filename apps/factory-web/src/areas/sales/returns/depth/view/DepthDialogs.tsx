'use client'

import { useId } from 'react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Button, Checkbox, Input, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { garmentOf, minorText } from '../../model'
import type { RmaModel } from '../../view-model'
import { Money, say, useDayWords, useWords } from '../../view/parts'
import { approverWords, checkWords, creditDraftProblems, policyProblems } from '../model'
import type { DepthDialog, RmaDepthActions, RmaDepthModel } from '../view-model'

/**
 * The dialogs of the W2b parts of a return (B-W2b-352): Credit without return (the line's value, the credit asked — empty
 * is what its pieces are worth —, why, and whether it is done at once or waits for a yes from whom: the approval engine's
 * own rules are the limit), Bind the return policy (the live policy of the channel, the deadline it sets, the consumer's
 * withdrawal where it applies, a reason when a line is outside its window) and Split the rest. Each primary button is held
 * with its reason; the API's refusals in our words. Money only with the price grain.
 */
export function DepthDialogs({ model, depthModel, actions }: { model: RmaModel; depthModel: RmaDepthModel; actions?: RmaDepthActions }) {
  const dialog = depthModel.dialog
  if (!dialog) return null
  switch (dialog.kind) {
    case 'credit':
      return <CreditDialog model={model} depthModel={depthModel} dialog={dialog} actions={actions} />
    case 'policy':
      return <PolicyDialog model={model} depthModel={depthModel} dialog={dialog} actions={actions} />
    case 'split':
      return <SplitDialog model={model} depthModel={depthModel} dialog={dialog} actions={actions} />
  }
}

function Footer({ held, busy, label, actions }: { held: string | null; busy: boolean; label: string; actions?: RmaDepthActions }) {
  const t = useWords()
  return (
    <>
      <span className="grow" />
      <Button size="sm" onClick={() => actions?.onDepthDialog?.(null)}>
        {t('quality:common.cancel')}
      </Button>
      <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onDepthSubmit?.()}>
        {busy ? <Spinner size={12} /> : null} {label}
      </Button>
    </>
  )
}

function CreditDialog({ model, depthModel, dialog, actions }: { model: RmaModel; depthModel: RmaDepthModel; dialog: Extract<DepthDialog, { kind: 'credit' }>; actions?: RmaDepthActions }) {
  const t = useWords()
  const ids = { amount: useId(), note: useId() }
  const line = model.rma.lines.find((entry) => entry.id === dialog.draft.lineId)
  const depthLine = depthModel.depth.value?.lines.find((entry) => entry.id === dialog.draft.lineId)
  const preview = dialog.preview
  const problems = creditDraftProblems(dialog.draft, preview)
  const held = depthModel.busy ? t('quality:common.working') : !preview ? t('quality:common.loading') : problems[0] ? say(t, problems[0]) : null
  const set = (patch: Partial<typeof dialog.draft>) => actions?.onDepthDialog?.({ ...dialog, draft: { ...dialog.draft, ...patch } })
  const approval = preview?.approval
  return (
    <Modal
      open
      onClose={() => actions?.onDepthDialog?.(null)}
      title={t('depth:credit.dialog.title', { seq: line?.seq ?? '—' })}
      size="md"
      footer={<Footer held={held} busy={depthModel.busy} label={approval?.needed ? t('depth:credit.dialog.ask') : t('depth:credit.dialog.submit')} actions={actions} />}
    >
      <div className="fw-q-stack">
        {depthModel.problem && <Banner tone="danger" title={say(t, depthModel.problem)} />}
        <p className="fw-q-hint">{t('depth:credit.dialog.body')}</p>
        <KeyValue
          columns={2}
          items={[
            { label: t('line.col.garment'), value: line ? garmentOf(line) || line.description : '—' },
            { label: t('depth:credit.dialog.pieces'), value: <span className="fw-q-num">{preview?.pieces ?? line?.quantity ?? '—'}</span> },
            { label: t('depth:credit.col.value'), value: <Money minor={preview?.value ?? depthLine?.value ?? null} currency={preview?.currency ?? depthLine?.currency ?? null} /> },
            { label: t('depth:credit.dialog.credit'), value: dialog.previewing ? <Spinner size={12} /> : <Money minor={preview?.creditAmount ?? null} currency={preview?.currency ?? null} /> },
          ]}
        />
        <Field label={t('depth:credit.dialog.amount')} hint={t('depth:credit.dialog.amountHint', { value: minorText(preview?.value ?? depthLine?.value ?? null) || '—' })} htmlFor={ids.amount}>
          <Input id={ids.amount} inputMode="decimal" value={dialog.draft.amount} placeholder={minorText(preview?.value ?? depthLine?.value ?? null)} onChange={(event) => set({ amount: event.target.value })} />
        </Field>
        <Field label={t('depth:credit.dialog.note')} hint={t('depth:credit.dialog.noteHint')} htmlFor={ids.note}>
          <Textarea id={ids.note} rows={2} value={dialog.draft.note} onChange={(event) => set({ note: event.target.value })} />
        </Field>
        {approval &&
          (approval.needed ? (
            <Banner tone={approval.nobodyElse ? 'danger' : 'info'} title={approval.nobodyElse ? t('depth:credit.problem.nobodyElse') : t('depth:credit.dialog.needsYes')}>
              {!approval.nobodyElse && say(t, approverWords(approval, model.people))}
            </Banner>
          ) : (
            <p className="fw-q-hint">{t('depth:credit.dialog.atOnce')}</p>
          ))}
        <p className="fw-q-hint">{t('depth:credit.dialog.effect')}</p>
      </div>
    </Modal>
  )
}

function PolicyDialog({ model, depthModel, dialog, actions }: { model: RmaModel; depthModel: RmaDepthModel; dialog: Extract<DepthDialog, { kind: 'policy' }>; actions?: RmaDepthActions }) {
  const t = useWords()
  const dayWords = useDayWords()
  const ids = { reason: useId(), withdrawal: useId() }
  const check = dialog.check
  const problems = policyProblems(check, dialog.draft)
  const held = depthModel.busy ? t('quality:common.working') : problems[0] ? say(t, problems[0]) : null
  const set = (patch: Partial<typeof dialog.draft>) => actions?.onDepthDialog?.({ ...dialog, draft: { ...dialog.draft, ...patch } })
  const consumer = check?.channel === 'CONSUMER_DISTANCE'
  return (
    <Modal open onClose={() => actions?.onDepthDialog?.(null)} title={t('depth:policy.dialog.title', { number: model.rma.number })} size="md" footer={<Footer held={held} busy={depthModel.busy} label={t('depth:policy.dialog.submit')} actions={actions} />}>
      <div className="fw-q-stack">
        {depthModel.problem && <Banner tone="danger" title={say(t, depthModel.problem)} />}
        <p className="fw-q-hint">{t('depth:policy.dialog.body')}</p>
        {!check ? (
          <p className="fw-q-loading" role="status">
            <Spinner size={12} /> {t('depth:policy.problem.checking')}
          </p>
        ) : (
          <ul className="fw-q-lines">
            {checkWords(check).map((words) => (
              <li key={words.key}>{say(t, words, dayWords)}</li>
            ))}
          </ul>
        )}
        {consumer && (
          <Checkbox id={ids.withdrawal} checked={dialog.draft.withdrawal} onChange={(event) => set({ withdrawal: event.target.checked })} label={t('depth:policy.dialog.withdrawal')} />
        )}
        {check?.outsideWindow && (
          <Field label={t('depth:policy.dialog.reason')} required hint={t('depth:policy.dialog.reasonHint')} htmlFor={ids.reason}>
            <Textarea id={ids.reason} rows={2} value={dialog.draft.reason} onChange={(event) => set({ reason: event.target.value })} />
          </Field>
        )}
      </div>
    </Modal>
  )
}

function SplitDialog({ model, depthModel, dialog, actions }: { model: RmaModel; depthModel: RmaDepthModel; dialog: Extract<DepthDialog, { kind: 'split' }>; actions?: RmaDepthActions }) {
  const t = useWords()
  const line = model.rma.lines.find((entry) => entry.id === dialog.lineId)
  const held = depthModel.busy ? t('quality:common.working') : !line ? t('quality:common.loading') : null
  return (
    <Modal open onClose={() => actions?.onDepthDialog?.(null)} title={t('depth:split.title', { seq: line?.seq ?? '—' })} size="sm" footer={<Footer held={held} busy={depthModel.busy} label={t('depth:split.submit')} actions={actions} />}>
      <div className="fw-q-stack">
        {depthModel.problem && <Banner tone="danger" title={say(t, depthModel.problem)} />}
        {line && <p>{t('depth:split.body', { seq: line.seq, kept: line.receivedQuantity, rest: line.quantity - line.receivedQuantity })}</p>}
        <p className="fw-q-hint">{t('depth:split.hint')}</p>
      </div>
    </Modal>
  )
}
