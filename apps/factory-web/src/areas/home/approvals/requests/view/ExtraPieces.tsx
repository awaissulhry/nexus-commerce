'use client'

import { RadioCard } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { ApplyPlan } from '../api'
import { CR, outcomeHeld, said, type ApplyChoices } from '../model'
import type { ExtraOutcome } from '@nexus/factory-domain/order-apply/rules'

/**
 * F-SA-241 (sales page plan R1; lead picks Round 4; 14-change-flow §2.1; review R-6) — "Extra pieces" in the review window: a decrease
 * meets pieces already cut (a cut piece is never un-cut), each figure per size, and ONE required choice before Accept — Keep and charge
 * the customer (the priced change the Accept makes) · Keep as leftover for <customer> (recorded on the work-order change; a
 * private-label garment never goes to another customer) · Scrap (the scrap's own approval). None is picked for the reader (Round 4);
 * an outcome this reader may not choose (charging without the price grain) stays in the list, focusable, with why — never hidden.
 * After Accept it says the outcome recorded. The words of each outcome are the API's (factory-domain order-apply CHANGE_WORDS).
 */
export function ExtraPieces({ plan, choices, accepted, onChoose }: { plan: ApplyPlan; choices: ApplyChoices; accepted: boolean; onChoose?: ((outcome: ExtraOutcome) => void) | undefined }) {
  const t = useT('approvals')
  const locale = useLocale()
  const extra = plan.extra
  if (extra.total === 0) return null
  const name = `fw-apv-extra-${plan.request.id}`
  const chosen = accepted ? extra.chosen : choices.extraOutcome
  const chosenWords = chosen ? extra.outcomes.find((option) => option.outcome === chosen)?.words : null
  return (
    <fieldset className="fw-apv-extra" aria-describedby={`${name}-hint`}>
      <legend className="fw-apv-h">{t(`${CR}.extra.title`)}</legend>
      <ul className="fw-apv-list">
        {extra.pieces.map((piece) => (
          <li key={`${piece.lineId}:${piece.size}`}>{t(`${CR}.extra.piece`, { line: piece.seq, words: said(piece.words, locale) })}</li>
        ))}
      </ul>
      <p className="fw-apv-hint" id={`${name}-hint`}>
        {accepted ? (chosenWords ? t(`${CR}.extra.chosen`, { outcome: said(chosenWords, locale) }) : t(`${CR}.extra.noneChosen`)) : t(`${CR}.extra.pick`)}
      </p>
      {!accepted && (
        <div className="fw-apv-extra-options" role="radiogroup" aria-label={t(`${CR}.extra.pick`)}>
          {extra.outcomes.map((option) => {
            const held = outcomeHeld(option)
            return (
              <RadioCard
                key={option.outcome}
                name={name}
                value={option.outcome}
                checked={choices.extraOutcome === option.outcome}
                selected={choices.extraOutcome === option.outcome}
                aria-disabled={held ? true : undefined}
                onChange={() => {
                  if (!held) onChoose?.(option.outcome)
                }}
                title={said(option.words, locale)}
                description={held ? said(held, locale) : t(`${CR}.extra.outcome.${option.outcome}`)}
              />
            )
          })}
        </div>
      )}
    </fieldset>
  )
}
