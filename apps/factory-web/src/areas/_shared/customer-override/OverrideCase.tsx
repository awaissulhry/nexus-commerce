'use client'

import { useState } from 'react'
import { Gavel, Undo2 } from 'lucide-react'
import { KIND_RULES } from '@nexus/factory-domain/approvals-out/kinds'
import { Card } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import type { OverrideRequest } from './api'
import { DecideDialog, ReverseDialog, type Dialog } from './CustomerOverride'
import { NS, type DecideDraft } from './model'
import './customer-override.css'

/**
 * F-PR-16 (the browser walk) — "Decide for <customer>…" and "Reverse…" as a case of the design review: the act's button and THE
 * dialog the part opens (F-PR-09), with a made-up request. The button opens it, Esc or Cancel closes it and the focus goes back to
 * the button; the draft changes as typed. Nothing is sent from here (the step-up and the API stay with the live part).
 */
export interface OverrideCaseModel {
  readonly request: OverrideRequest
  readonly customer: string
  /** The dialog as it opens (and whether it is open at first). */
  readonly dialog: Dialog
  readonly open: boolean
}

export function OverrideCase({ model }: { model: OverrideCaseModel }) {
  return (
    <WithMessages namespaces={[NS, 'ds-words']}>
      <CaseState model={model} />
    </WithMessages>
  )
}

function CaseState({ model }: { model: OverrideCaseModel }) {
  const t = useT(NS)
  const locale = useLocale()
  const [open, setOpen] = useState(model.open)
  const [dialog, setDialog] = useState<Dialog>(model.dialog)
  const close = () => setOpen(false)
  return (
    // Where the part is mounted (a round's Approval tab, a gate, a new date): the request it acts on, then the act.
    <Card padded>
      <p className="fw-cov-text">{`${KIND_RULES[model.request.kind].name[locale]} · ${model.request.record.words[locale]}`}</p>
      <p className="fw-cov-hint">{model.request.question}</p>
      <Button size="sm" onClick={() => setOpen(true)}>
        {dialog.act === 'decide' ? <Gavel size={13} aria-hidden /> : <Undo2 size={13} aria-hidden />} {dialog.act === 'decide' ? t('act.decide', { customer: model.customer }) : t('act.reverse')}
      </Button>
      {open && dialog.act === 'decide' && (
        <DecideDialog
          request={model.request}
          customer={model.customer}
          dialog={dialog}
          busy={false}
          onDraft={(patch: Partial<DecideDraft>) => setDialog((current) => (current.act === 'decide' ? { ...current, draft: { ...current.draft, ...patch } } : current))}
          onSend={() => undefined}
          onClose={close}
        />
      )}
      {open && dialog.act === 'reverse' && (
        <ReverseDialog
          request={model.request}
          customer={model.customer}
          dialog={dialog}
          busy={false}
          onReason={(reason) => setDialog((current) => (current.act === 'reverse' ? { ...current, reason } : current))}
          onSend={() => undefined}
          onClose={close}
        />
      )}
    </Card>
  )
}
