'use client'

import { useId } from 'react'
import { BellRing } from 'lucide-react'
import { Checkbox, Tooltip } from '@nexus/ui/primitives'
import { useT } from '../../../i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { FOLLOW_UP_DAYS } from '../model'
import { HELPERS_NS } from './MentionInput'
import '../helpers.css'

/** B-TH-289: the tick beside the box on a message to the customer, and why it is held when it is. */
export interface FollowUpModel {
  /** Ticked: the follow-up is set when the message has gone. */
  readonly on: boolean
  /** Why it cannot be ticked (a key of record-thread-helpers and its values: no right to reminders, offline), or null. */
  readonly held: { readonly key: string; readonly params?: Readonly<Record<string, string | number>> } | null
  /** Whom the answer must come from ("Only an answer from Brand Alpha stops it"). */
  readonly party: string
}

/**
 * "Remind me in 3 days if no answer" (B-TH-289, T8-F05 on B-TH-096): a tick in the composer's helpers on a reply by e-mail or in the
 * portal. On Send the office container sets the person's own reminder on the message that went; the API stops it by itself when the
 * customer answers (their mail or portal post) or the conversation closes, and brings it back to Today otherwise. Office only.
 */
export function FollowUpTick({ model, onChange }: { model: FollowUpModel; onChange?: (on: boolean) => void }) {
  return (
    <WithMessages namespaces={[HELPERS_NS]}>
      <Tick model={model} onChange={onChange} />
    </WithMessages>
  )
}

function Tick({ model, onChange }: { model: FollowUpModel; onChange?: ((on: boolean) => void) | undefined }) {
  const t = useT(HELPERS_NS)
  const hintId = useId()
  const hint = model.held ? t(model.held.key, model.held.params) : t('followUp.hint', { party: model.party })
  return (
    <Tooltip label={hint} portal>
      <span className="fw-rtm-followup">
        <BellRing size={13} aria-hidden />
        <Checkbox label={t('followUp.label', { days: FOLLOW_UP_DAYS })} checked={model.on && !model.held} disabled={model.held !== null} onChange={(event) => onChange?.(event.target.checked)} aria-describedby={hintId} />
        <span id={hintId} className="nds-vh">
          {hint}
        </span>
      </span>
    </Tooltip>
  )
}
