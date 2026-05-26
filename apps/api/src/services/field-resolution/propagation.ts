// FL.4.1 — Propagation planner (pure).
//
// When a linked field is edited on one coordinate, planPropagation computes
// the bounded fan-out: for every OTHER member of the link group, what value
// it should receive and whether that needs translation. Pure + deterministic
// so the diff the operator confirms (FL.4.3) is unit-testable with no DB / AI.
//
// Rules:
//   - the edited coordinate itself is excluded (it's the source)
//   - translatePolicy NONE     → skip (leave member as-is)
//   - translatePolicy VERBATIM → copy the edited value verbatim
//   - translatePolicy TRANSLATE:
//        same language as source → verbatim
//        different language       → translate (proposedValue filled by the
//                                   execution step; null in the plan)
//   - `unchanged` flags members whose current value already equals the
//     proposed value, so the diff UI can leave them unchecked.

export type TranslatePolicy = 'TRANSLATE' | 'VERBATIM' | 'NONE'

export interface PropagationMember {
  channel: string
  marketplace: string
  variantId?: string
  /** Member's current value, for the diff. */
  currentValue?: string | null
  /** Member market language, for translate decisions. */
  language?: string | null
}

export type PropagationAction = 'verbatim' | 'translate' | 'skip'

export interface PropagationEntry {
  channel: string
  marketplace: string
  variantId?: string
  currentValue: string | null
  /** Proposed value; null when it still needs translation. */
  proposedValue: string | null
  action: PropagationAction
  language: string | null
  /** current === proposed (no-op) — UI leaves it unchecked. */
  unchanged: boolean
}

export interface PlanInput {
  editedValue: string
  sourceChannel: string
  sourceMarketplace: string
  sourceVariantId?: string
  sourceLanguage?: string | null
  translatePolicy: TranslatePolicy
  members: PropagationMember[]
}

function isSameCoordinate(
  m: PropagationMember,
  channel: string,
  marketplace: string,
  variantId?: string,
): boolean {
  return (
    m.channel === channel &&
    m.marketplace === marketplace &&
    (m.variantId ?? undefined) === (variantId ?? undefined)
  )
}

export function planPropagation(input: PlanInput): PropagationEntry[] {
  const {
    editedValue,
    sourceChannel,
    sourceMarketplace,
    sourceVariantId,
    sourceLanguage,
    translatePolicy,
    members,
  } = input

  return members
    .filter(
      (m) => !isSameCoordinate(m, sourceChannel, sourceMarketplace, sourceVariantId),
    )
    .map((m): PropagationEntry => {
      const sameLanguage =
        !m.language ||
        !sourceLanguage ||
        m.language.toLowerCase() === sourceLanguage.toLowerCase()

      let action: PropagationAction
      if (translatePolicy === 'NONE') action = 'skip'
      else if (translatePolicy === 'VERBATIM' || sameLanguage) action = 'verbatim'
      else action = 'translate'

      const proposedValue =
        action === 'verbatim'
          ? editedValue
          : action === 'skip'
            ? (m.currentValue ?? null)
            : null // translate → filled by execution

      const current = m.currentValue ?? null
      const unchanged = action !== 'translate' && current === proposedValue

      return {
        channel: m.channel,
        marketplace: m.marketplace,
        variantId: m.variantId,
        currentValue: current,
        proposedValue,
        action,
        language: m.language ?? null,
        unchanged,
      }
    })
}

/** Members that still need a translation call (cross-language TRANSLATE).
 *  The execution step batches these through the AI translate path. */
export function entriesNeedingTranslation(entries: PropagationEntry[]): PropagationEntry[] {
  return entries.filter((e) => e.action === 'translate')
}
