'use client'

import { useState } from 'react'
import { ThreadMessages } from '../../parts/ThreadMessages'
import type { ComposerContext, ComposerDraft, SwitchNote } from '../model'
import { Composer } from './Composer'
import { LeaveConfirm } from '../../popups/view/Confirms'

export interface ComposerCaseModel {
  context: ComposerContext
  draft: ComposerDraft
  notes?: readonly SwitchNote[]
  extraHeld?: string | null
  sending?: boolean
  now?: string
  /** The "Leave with unsent text?" question open. */
  leaving?: boolean
}

/** SCR-006-composer: the composer at the foot of the thread's column; typing, switching and the keys work (design review only). */
export function ComposerCase({ model }: { model: ComposerCaseModel }) {
  const [draft, setDraft] = useState(model.draft)
  const [notes, setNotes] = useState<readonly SwitchNote[]>(model.notes ?? [])
  const [leaving, setLeaving] = useState(model.leaving ?? false)
  return (
    <ThreadMessages>
      <div className="fw-rt-case fw-rt-column is-composer-case">
        <div className="fw-rt-case-fill" aria-hidden="true" />
        <Composer
          context={model.context}
          draft={draft}
          notes={notes}
          extraHeld={model.extraHeld}
          sending={model.sending}
          now={model.now}
          onDraft={(next, nextNotes) => {
            setDraft(next)
            setNotes(nextNotes)
          }}
          onSend={() => setDraft({ ...draft, body: '' })}
          onReopen={() => undefined}
          onMakeCustomer={() => undefined}
        />
        {leaving && <LeaveConfirm onStay={() => setLeaving(false)} onDiscard={() => setLeaving(false)} />}
      </div>
    </ThreadMessages>
  )
}
