'use client'

import { useId, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import { Input } from '../primitives/Input'

/**
 * ConfirmPhraseField — "type this exactly to confirm": the typed confirmation of a step that cannot be undone the same
 * way (delete a listing, end it, remove a SKU). Extracted from `ActionConfirm` (sheet publish parity, 2026-10-04) so
 * the Publish window, the selling dialogs and `ActionConfirm` ask in one way.
 *
 * - **Exact match only.** No trimming, no case folding: the phrase is a SKU, an item number or a count, and "sku-1" is
 *   another product. `phraseMatches` is the one rule; a caller arms its button with it.
 * - **The state is visible and announced politely.** Under the field: "Capital letters and spaces count." → "Keep
 *   typing." → "Does not match …" → "Matches." The line is the field's description (`aria-describedby`) and a polite
 *   live region; its text changes only when the state does, so a screen reader hears each state once, not each key.
 * - Controlled: the caller holds the text (and clears it when what is being confirmed changes).
 *
 * Layout comes from `.nds-field-w` (label, control, hint in a column); the hint is `.nds-field-hint` (`--nds-text-muted`,
 * 7:1 in both themes). Requires `styles/components.css`.
 */

/** The one rule: the typed text equals the phrase, character for character. An empty phrase never matches. */
export function phraseMatches(typed: string, phrase: string): boolean {
  return phrase !== '' && typed === phrase
}

export type PhraseMatchState = 'empty' | 'partial' | 'mismatch' | 'match'

/** Where the typing stands: nothing yet, a correct start, a mistake, or the exact phrase. */
export function phraseMatchState(typed: string, phrase: string): PhraseMatchState {
  if (typed === '') return 'empty'
  if (phraseMatches(typed, phrase)) return 'match'
  return phrase.startsWith(typed) ? 'partial' : 'mismatch'
}

export const PHRASE_STATE_TEXT: Readonly<Record<PhraseMatchState, string>> = {
  empty: 'Capital letters and spaces count.',
  partial: 'Keep typing.',
  mismatch: 'Does not match. Capital letters and spaces count.',
  match: 'Matches.',
}

export interface ConfirmPhraseFieldProps {
  /** The exact text to type: a SKU, an item number, a count. */
  phrase: string
  value: string
  onChange: (value: string) => void
  /** The label. Default: "Type <phrase> exactly to confirm", with the phrase in bold. */
  label?: ReactNode
  /** The input's id. Default: generated. */
  id?: string
  className?: string
  disabled?: boolean
  autoFocus?: boolean
}

export function ConfirmPhraseField({ phrase, value, onChange, label, id, className, disabled, autoFocus }: ConfirmPhraseFieldProps) {
  const auto = useId()
  const inputId = id ?? `${auto}-input`
  const stateId = `${auto}-state`
  const state = phraseMatchState(value, phrase)
  return (
    <div className={['nds-field-w', className].filter(Boolean).join(' ')}>
      <label htmlFor={inputId}>{label ?? <>Type <strong className="nds-confirm-h">{phrase}</strong> exactly to confirm</>}</label>
      <Input id={inputId} value={value} onChange={e => onChange(e.target.value)} disabled={disabled} autoFocus={autoFocus}
        aria-describedby={stateId} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} />
      <span id={stateId} className="nds-field-hint" aria-live="polite" data-state={state}>
        {state === 'match' && <Check size={12} strokeWidth={2.5} aria-hidden="true" className="nds-confirm-phrase-ok" />}
        {PHRASE_STATE_TEXT[state]}
      </span>
    </div>
  )
}
