'use client'

import { RadioCard } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { CR, said } from '../model'
import type { ExtraOutcome } from '@nexus/factory-domain/order-apply/rules'

type Words = { readonly it: string; readonly en: string }

/** One extra piece: its order line and the API's words ("Extra pieces: 4 M already cut"). */
export interface ExtraPiece {
  readonly key: string
  readonly line: number
  readonly words: Words
}

/** One outcome: its words (the API's, factory-domain CHANGE_WORDS) and why this reader may not pick it (null: may). */
export interface ExtraChoice {
  readonly outcome: ExtraOutcome
  readonly words: Words
  readonly held: Words | null
}

export interface ExtraPiecesProps {
  /** The radio group's name (unique on the page). */
  readonly name: string
  readonly pieces: readonly ExtraPiece[]
  readonly outcomes: readonly ExtraChoice[]
  /** The outcome picked (or, once done, the one recorded); null: none. */
  readonly chosen: ExtraOutcome | null
  /** The change was made: the outcome recorded is said, nothing is picked any more. */
  readonly done?: boolean
  readonly onChoose?: ((outcome: ExtraOutcome) => void) | undefined
}

/**
 * F-SA-241 (sales page plan R1; lead picks Round 4; 14-change-flow §2.1; review R-6) — "Extra pieces": a decrease meets pieces already
 * cut (a cut piece is never un-cut), each figure per size, and ONE choice before the change — Keep and charge the customer (a priced
 * change) · Keep as leftover for <customer> (a private-label garment never goes to another customer) · Scrap (the scrap's own approval).
 * None is picked for the reader (Round 4); an outcome this reader may not choose (charging without the price grain) stays in the list,
 * focusable, with why — never hidden. Once done it says the outcome recorded.
 *
 * F-OP-107 (order page B2): one part for every door — the review window (its apply plan), the order page's edit strip, Close remaining
 * lines and Cancel (their previews) — on plain props `{pieces, outcomes, chosen, onChoose}`; it brings its own words (approvals).
 */
export function ExtraPieces(props: ExtraPiecesProps) {
  if (props.pieces.length === 0) return null
  return (
    <WithMessages namespaces={['approvals']}>
      <Picker {...props} />
    </WithMessages>
  )
}

function Picker({ name, pieces, outcomes, chosen, done = false, onChoose }: ExtraPiecesProps) {
  const t = useT('approvals')
  const locale = useLocale()
  const chosenWords = chosen ? outcomes.find((option) => option.outcome === chosen)?.words : null
  return (
    <fieldset className="fw-apv-extra" aria-describedby={`${name}-hint`}>
      <legend className="fw-apv-h">{t(`${CR}.extra.title`)}</legend>
      <ul className="fw-apv-list">
        {pieces.map((piece) => (
          <li key={piece.key}>{t(`${CR}.extra.piece`, { line: piece.line, words: said(piece.words, locale) })}</li>
        ))}
      </ul>
      <p className="fw-apv-hint" id={`${name}-hint`}>
        {done ? (chosenWords ? t(`${CR}.extra.chosen`, { outcome: said(chosenWords, locale) }) : t(`${CR}.extra.noneChosen`)) : t(`${CR}.extra.pick`)}
      </p>
      {!done && (
        <div className="fw-apv-extra-options" role="radiogroup" aria-label={t(`${CR}.extra.pick`)}>
          {outcomes.map((option) => (
            <RadioCard
              key={option.outcome}
              name={name}
              value={option.outcome}
              checked={chosen === option.outcome}
              selected={chosen === option.outcome}
              aria-disabled={option.held ? true : undefined}
              onChange={() => {
                if (!option.held) onChoose?.(option.outcome)
              }}
              title={said(option.words, locale)}
              description={option.held ? said(option.held, locale) : t(`${CR}.extra.outcome.${option.outcome}`)}
            />
          ))}
        </div>
      )}
    </fieldset>
  )
}
