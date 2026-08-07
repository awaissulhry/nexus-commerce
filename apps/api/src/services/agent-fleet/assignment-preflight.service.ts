/**
 * NAF.SB.AS.3 — "what will it actually look at?", answered honestly.
 *
 * The study's first draft of this section claimed the counters were free
 * because they "already exist in the observation payload". That was wrong,
 * and the critique caught it: those counters are produced INSIDE `build()`,
 * which runs a sixty-day scan of search terms. There is no way to ask a
 * builder what it would narrow without running it.
 *
 * So this splits into two halves that are honest about their cost:
 *
 *  - **static()** — no scans, no model, no writes. Which evidence this worker
 *    reads, which of it honours the target, what is withheld or stays
 *    account-wide, and the resolved spend ceiling. Safe to render on every
 *    keystroke of the create drawer.
 *
 *  - **measure()** — operator-triggered, and the UI says what it costs before
 *    it runs. Builds the real evidence THROUGH THE SHARED CACHE and reports
 *    what survives. It calls no model and creates no run row: `preview: true`
 *    on `executeCharter` does both of those, and this is deliberately not
 *    that. It may refresh a cached observation row, which is exactly what a
 *    real run does and is shared by every subsequent reader.
 */
import { resolveCharter } from './charter-registry.js'
import { getFleetState } from './fleet-state.service.js'
import {
  getObservation,
  narrowKindsFor,
  observationLabel,
  observationNarrowNotes,
  observationItemCount,
} from './observation-builder.js'
import {
  narrowKindFor,
  resolveAssignmentScope,
  type AssignmentTarget,
} from './assignment-scope.js'

export interface PreflightFeed {
  key: string
  label: string
  /** Does this feed actually honour the chosen target kind? */
  honoured: boolean
  /** Plain sentences: what survives, what is held back, what stays wide. */
  notes: string[]
}

export interface StaticPreflight {
  ok: boolean
  /** Set when this (worker, target) pair cannot be honoured at all. */
  refusal?: string
  worker: { key: string; name: string; autonomyLevel: string; autonomyCap: string }
  /** One line, the whole answer, for the default state of the panel. */
  headline: string
  feeds: PreflightFeed[]
  /** Resolved, not theoretical: this worker's daily budget, and the fleet's. */
  ceilingUSD: number
  fleetCeilingUSD: number
  /** True when the fleet is halted — the run would stop before spending. */
  fleetHalted: boolean
}

export async function staticPreflight(
  charterKey: string,
  target: AssignmentTarget | null,
): Promise<StaticPreflight | null> {
  const charter = await resolveCharter(charterKey)
  if (!charter) return null
  const fleet = await getFleetState()

  const base = {
    worker: {
      key: charter.key,
      name: charter.name,
      autonomyLevel: charter.autonomyLevel,
      autonomyCap: charter.autonomyCap,
    },
    ceilingUSD: charter.dailyBudgetUSD,
    fleetCeilingUSD: fleet.dailyCeilingUSD,
    fleetHalted: fleet.halted,
  }

  if (!target) {
    return {
      ...base,
      ok: true,
      headline: 'It will look at your whole account, the way it does on a normal run.',
      feeds: charter.observationKeys.map((k) => ({
        key: k,
        label: observationLabel(k),
        honoured: true,
        notes: [],
      })),
    }
  }

  const need = narrowKindFor(target.kind)
  const feeds: PreflightFeed[] = charter.observationKeys.map((k) => ({
    key: k,
    label: observationLabel(k),
    honoured: narrowKindsFor(k).includes(need),
    notes: observationNarrowNotes(k, need),
  }))

  const unhonoured = feeds.filter((f) => !f.honoured)
  if (unhonoured.length) {
    return {
      ...base,
      ok: false,
      refusal: `${charter.name} reads ${unhonoured
        .map((f) => f.label)
        .join(' and ')}, which cannot be narrowed to a ${target.kind.toLowerCase()}. It is refused rather than reading your whole account while claiming to be scoped.`,
      headline: 'This worker cannot be pointed at that.',
      feeds,
    }
  }

  const where = target.labels?.length ? target.labels.join(', ') : target.ids.join(', ')
  return {
    ...base,
    ok: true,
    headline: `It will look at ${where} only — nothing else in your account.`,
    feeds,
  }
}

export interface MeasuredFeed {
  key: string
  label: string
  /** How many things it will actually read, after narrowing. */
  items: number
  /** The builder's own plain-language caveats, with the real numbers in them. */
  caveats: string[]
  dataVintage: string
  /** True when this came from the shared cache — a second look costs nothing. */
  cached: boolean
}

export interface MeasuredPreflight {
  ok: boolean
  error?: string
  feeds: MeasuredFeed[]
  totalItems: number
}

/**
 * The measured half. Expensive on first call (it builds real evidence), free
 * afterwards for six hours because the row is shared with every other reader.
 *
 * Refuses exactly where a run would refuse, so the operator never gets a
 * cheerful preview of something that would then stop.
 */
export async function measurePreflight(
  charterKey: string,
  target: AssignmentTarget | null,
): Promise<MeasuredPreflight> {
  const charter = await resolveCharter(charterKey)
  if (!charter) return { ok: false, error: 'unknown worker', feeds: [], totalItems: 0 }

  let narrow
  let marketplace: string | undefined
  if (target) {
    const resolved = await resolveAssignmentScope(charter, target)
    if (resolved.error) {
      return { ok: false, error: resolved.error, feeds: [], totalItems: 0 }
    }
    narrow = resolved.narrow
    marketplace = resolved.marketplace
  }

  const feeds: MeasuredFeed[] = []
  for (const key of charter.observationKeys) {
    const obs = await getObservation(key, { marketplace }, narrow)
    const payload = obs.payload as { caveats?: string[] } | null
    feeds.push({
      key,
      label: observationLabel(key),
      items: observationItemCount(key, obs.payload),
      caveats: Array.isArray(payload?.caveats) ? payload!.caveats! : [],
      dataVintage: obs.dataVintage.toISOString(),
      cached: obs.cached,
    })
  }

  return {
    ok: true,
    feeds,
    totalItems: feeds.reduce((s, f) => s + f.items, 0),
  }
}
