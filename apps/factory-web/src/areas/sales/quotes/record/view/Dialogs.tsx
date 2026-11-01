'use client'

import { useEffect, useState } from 'react'
import { Field } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import type { QuoteDetail } from '../../api'
import { decideHeld, pendingRequest } from '../../model'
import type { QuoteDialog, QuoteRecordActions, QuoteRecordViewModel } from '../record-model'

const MAX = 500

/** A reason or note as typed: required ones need 3 characters; any at most 500. */
const textHeld = (text: string, required: boolean): string | null => {
  const length = text.trim().length
  if (required && length < 3) return 'dialog.held.reason'
  if (length > MAX) return 'dialog.held.long'
  return null
}

interface DialogSpec {
  title: string
  body: string
  field?: { label: string; hint?: string; required: boolean }
  go: string
  tone: 'primary' | 'danger'
  run: (text: string) => Promise<boolean> | undefined
  held?: string | null
}

/**
 * The record's small dialogs (design `quotes.askApproval`, `quotes.decide`, `quotes.makeVersion`, `quotes.cancel`): one
 * question each, its consequence in words, and one button that says what it does. ⌘↵ runs it; Esc closes and keeps the
 * record as it was. A reject and a cancel after sending need a reason.
 */
export function QuoteDialogs({ quote, model, actions }: { quote: QuoteDetail; model: QuoteRecordViewModel; actions?: QuoteRecordActions }) {
  const t = useT('sales')
  const [text, setText] = useState('')
  useEffect(() => setText(''), [model.dialog])
  if (!model.dialog) return null
  const close = () => actions?.onDialog?.(null)
  const broken = quote.approval.rules.filter((rule) => rule.broken).map((rule) => t(`reason.${rule.reason}`)).join(' · ')
  const request = pendingRequest(quote)
  const decide = decideHeld(quote, model.me, model.can, model.grains)
  const next = quote.currentRevision + 1
  const specs: Record<QuoteDialog, DialogSpec> = {
    ask: { title: t('dialog.ask.title'), body: t('dialog.ask.body', { reasons: broken }), field: { label: t('dialog.ask.note'), hint: t('dialog.ask.noteHint'), required: false }, go: t('dialog.ask.go'), tone: 'primary', run: (value) => actions?.onAsk?.(value) },
    withdraw: { title: t('dialog.withdraw.title'), body: t('dialog.withdraw.body'), field: { label: t('dialog.reason'), required: false }, go: t('dialog.withdraw.go'), tone: 'primary', run: (value) => actions?.onWithdraw?.(value) },
    approve: {
      title: t('dialog.approve.title', { number: quote.number }),
      body: t('dialog.approve.body', { reasons: request ? request.reasons.map((reason) => t(`reason.${reason}`)).join(' · ') : broken }),
      field: { label: t('dialog.approve.note'), required: false },
      go: t('action.approve'),
      tone: 'primary',
      run: (value) => actions?.onApprove?.(value),
      held: decide ? t(decide) : null,
    },
    reject: { title: t('dialog.reject.title'), body: t('dialog.reject.body'), field: { label: t('dialog.reason'), hint: t('dialog.reject.hint'), required: true }, go: t('action.reject'), tone: 'danger', run: (value) => actions?.onReject?.(value), held: decide ? t(decide) : null },
    cancel: {
      title: t('dialog.cancel.title', { number: quote.number }),
      body: t(quote.current.status === 'SENT' ? 'dialog.cancel.bodySent' : 'dialog.cancel.body'),
      field: { label: t('dialog.reason'), required: quote.current.status === 'SENT' },
      go: t('dialog.cancel.go'),
      tone: 'danger',
      run: (value) => actions?.onCancelQuote?.(value),
    },
    revise: { title: t('dialog.revise.title', { next }), body: t('dialog.revise.body', { revision: quote.currentRevision, next }), field: { label: t('dialog.revise.note'), hint: t('dialog.revise.noteHint'), required: false }, go: t('dialog.revise.go', { next }), tone: 'primary', run: (value) => actions?.onRevise?.(value) },
    newLink: { title: t('dialog.newLink.title'), body: t('dialog.newLink.body', { email: quote.contact?.email ?? '—' }), go: t('dialog.newLink.go'), tone: 'primary', run: () => actions?.onNewLink?.() },
    reopen: { title: t('dialog.reopen.title'), body: t('dialog.reopen.body'), field: { label: t('dialog.reason'), required: false }, go: t('dialog.reopen.go'), tone: 'primary', run: (value) => actions?.onWithdraw?.(value) },
  }
  const spec = specs[model.dialog]
  const typed = spec.field ? textHeld(text, spec.field.required) : null
  const held = spec.held ?? (typed ? t(typed) : null) ?? (model.busy ? t('held.busy') : null)
  const go = () => {
    if (held) return
    void spec.run(text)?.then((done) => done && close())
  }
  return (
    <Modal
      open
      onClose={close}
      title={spec.title}
      size="md"
      footer={
        <>
          <Button onClick={close}>{t('common.back')}</Button>
          <Button variant={spec.tone} heldReason={held} onClick={go} aria-keyshortcuts="Meta+Enter Control+Enter">
            {spec.go}
          </Button>
        </>
      }
    >
      <div
        className="fw-q-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            go()
          }
        }}
      >
        <p className="fw-q-hint">{spec.body}</p>
        {spec.field && (
          <Field label={spec.field.label} hint={spec.field.hint} required={spec.field.required}>
            <Textarea value={text} onChange={(event) => setText(event.target.value)} rows={3} maxLength={MAX} />
          </Field>
        )}
      </div>
    </Modal>
  )
}
