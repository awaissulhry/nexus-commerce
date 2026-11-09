'use client'

import { useId } from 'react'
import { Field } from '@nexus/ui/components'
import { Textarea } from '../../../lib/i18n/ds-parts'
import { useT } from '../../../lib/i18n/provider'
import { offersNote, RENEW_NOTE_MAX, type LinkRenew } from './model'
import '../links.css'

/**
 * B-W2b-F17: the reader's optional note with "Ask for a new link", inside a dead link's EndState (its body, above the
 * button): where no renewer makes a new link, it reaches the person who made the link, with the record. Kept in memory
 * only; shown until the ask is answered. Needs the `link-frame` catalogue (the frame's dead states and the files page
 * load it).
 */
export function RenewNote({ renew }: { renew: LinkRenew | null | undefined }) {
  const f = useT('link-frame')
  const id = useId()
  if (!renew || !offersNote(renew)) return null
  return (
    <div className="fw-link-renew-note">
      <Field label={f('ask.noteLabel')} hint={f('ask.noteHint')} htmlFor={id}>
        <Textarea id={id} rows={2} limit={RENEW_NOTE_MAX} value={renew.note ?? ''} onChange={(event) => renew.setNote?.(event.target.value)} />
      </Field>
    </div>
  )
}
