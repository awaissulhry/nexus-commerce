'use client'

import { useState } from 'react'
import type { ComposerContext, ComposerDraft } from '../../composer/model'
import { Composer } from '../../composer/view/Composer'
import { ThreadMessages } from '../../parts/ThreadMessages'
import { useT } from '../../../i18n/provider'
import { recipientsHeld, type CheckState, type Contact, type Recipient } from '../model'
import { Recipients } from './Recipients'
import { SendCheckDialog } from './SendCheckDialog'

export interface SendCaseModel {
  context: ComposerContext
  draft: ComposerDraft
  to: readonly Recipient[]
  cc: readonly Recipient[]
  subject: string
  contacts: readonly Contact[]
  files?: number
  /** The send check open, in this state. */
  check?: CheckState | null
  outside?: boolean
  sending?: boolean
}

/** SCR-006-send: the reply with To, Cc and Subject, and "Send to <customer>?" (design review only; nothing is sent). */
export function SendCase({ model }: { model: SendCaseModel }) {
  return (
    <ThreadMessages>
      <Case model={model} />
    </ThreadMessages>
  )
}

function Case({ model }: { model: SendCaseModel }) {
  const t = useT('record-thread-send')
  const [draft, setDraft] = useState(model.draft)
  const [lines, setLines] = useState({ to: [...model.to], cc: [...model.cc], subject: model.subject })
  const [check, setCheck] = useState<CheckState | null>(model.check ?? null)
  const [outside, setOutside] = useState(model.outside ?? false)
  const party = model.context.party?.name ?? ''
  const held = recipientsHeld(lines.to, lines.cc, lines.subject)
  return (
    <div className="fw-rt-case fw-rt-column">
      <div className="fw-rt-case-fill" aria-hidden="true" />
      <Composer
        context={model.context}
        draft={draft}
        extraHeld={draft.mode === 'reply' && held ? t(held.key, held.params) : null}
        recipients={<Recipients to={lines.to} cc={lines.cc} subject={lines.subject} contacts={model.contacts} partyName={party} onChange={setLines} />}
        onDraft={(next) => setDraft(next)}
        onSend={() => setCheck({ status: 'checking' })}
      />
      <SendCheckDialog
        model={{ open: check !== null, state: check ?? { status: 'checking' }, partyName: party, to: lines.to, cc: lines.cc, files: model.files ?? 0, outside, sending: model.sending ?? false }}
        actions={{ onBack: () => setCheck(null), onRetry: () => setCheck({ status: 'checking' }), onOutside: setOutside, onConfirm: () => setCheck(null) }}
      />
    </div>
  )
}
