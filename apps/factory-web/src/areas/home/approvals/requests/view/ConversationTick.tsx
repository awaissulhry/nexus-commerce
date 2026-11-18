'use client'

import { Checkbox } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { CR, tellHeld, tickOn, type TellTick } from '../model'

/**
 * F-SA-242 (sales page plan P8; 14-change-flow §4.2) — the tick "Also write it in the order's conversation", ONE part for the review
 * window (the words the customer reads) and the office's own Amend review: on by default when words are typed, held with why ("Type
 * the words first" / "No way to reach <customer>: add a contact"), never automatic. Ticked, the same words go as our message on the
 * order's thread after the answer (the thread's own send; the composer untouched). Its words are the approvals catalogue's.
 */
export function ConversationTick({ id, tick, words, customer, onTick }: { id: string; tick: Pick<TellTick, 'chosen' | 'reach'>; words: string; customer: string; onTick?: ((on: boolean) => void) | undefined }) {
  return (
    <WithMessages namespaces={['approvals']}>
      <Tick id={id} tick={tick} words={words} customer={customer} onTick={onTick} />
    </WithMessages>
  )
}

function Tick({ id, tick, words, customer, onTick }: { id: string; tick: Pick<TellTick, 'chosen' | 'reach'>; words: string; customer: string; onTick?: ((on: boolean) => void) | undefined }) {
  const t = useT('approvals')
  const held = tellHeld(tick, words)
  const on = tickOn(tick, words) && held === null
  return (
    <div className="fw-apv-tags">
      <Checkbox
        label={t(`${CR}.tell.tick`)}
        checked={on}
        aria-disabled={held ? true : undefined}
        aria-describedby={held ? `fw-apv-tick-${id}` : undefined}
        onChange={(event) => {
          // Held, not disabled: focusable, it says why and does not change.
          if (!held) onTick?.(event.target.checked)
        }}
      />
      {held && (
        <span className="fw-apv-sub" id={`fw-apv-tick-${id}`}>
          {t(held, { customer })}
        </span>
      )}
    </div>
  )
}
