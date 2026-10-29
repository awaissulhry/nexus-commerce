import { diffBoms, type BomDiff, type BomSnapshot } from '../../product/bom/diff'
import { diffRoutings, type RoutingDiff } from '../../product/routing/diff'
import type { StepData } from '../../product/routing/rules'

/**
 * The frozen specification against today's master (B-W1-38; MES-005, PRD-192; design 02 "Frozen spec" › "Compare with
 * the current master"), pure: what changed in the style since the work order froze its revision. Today's master is the
 * style's RELEASED revision now (none when it was withdrawn). A released revision never changes, so the difference is
 * always between two revisions: the BOM (./product/bom/diff), the routing (./product/routing/diff) and the garment
 * label template. A different specification is a new work order (or, W2b, a change request): nothing here changes one.
 */

export interface RevisionRef {
  readonly id: string
  readonly revision: number
  readonly status: string
}

export interface LabelRef {
  readonly id: string
  readonly code: string
  readonly revision: number
  readonly status: string
}

/** One revision's specification, as the comparison reads it. */
export interface SpecSnapshot {
  readonly revision: RevisionRef
  readonly label: LabelRef | null
  readonly bom: BomSnapshot
  readonly steps: readonly StepData[]
}

export interface SpecComparison {
  readonly sameRevision: boolean
  /** The style has no released revision today. */
  readonly noMaster: boolean
  readonly bom: BomDiff | null
  readonly routing: RoutingDiff | null
  readonly label: { readonly from: LabelRef | null; readonly to: LabelRef | null; readonly changed: boolean }
  /** What changed, a sentence per part (empty: nothing). */
  readonly summary: readonly string[]
}

const count = (n: number, what: string): string => `${n} ${what}${n === 1 ? '' : 's'}`

function bomWords(diff: BomDiff): string | null {
  const parts = [
    diff.added.length > 0 ? `${count(diff.added.length, 'line')} added` : null,
    diff.removed.length > 0 ? `${count(diff.removed.length, 'line')} removed` : null,
    diff.changed.length > 0 ? `${count(diff.changed.length, 'line')} changed` : null,
    diff.revision.some((change) => change.field === 'plannedHideYieldPct') ? 'planned hide yield changed' : null,
  ].filter((part): part is string => part !== null)
  return parts.length > 0 ? `BOM: ${parts.join(', ')}.` : null
}

function routingWords(diff: RoutingDiff): string | null {
  const parts = [
    diff.added.length > 0 ? `${count(diff.added.length, 'step')} added` : null,
    diff.removed.length > 0 ? `${count(diff.removed.length, 'step')} removed` : null,
    diff.changed.length > 0 ? `${count(diff.changed.length, 'step')} changed` : null,
    diff.minutes.from !== diff.minutes.to ? `standard minutes ${diff.minutes.from} → ${diff.minutes.to} per garment` : null,
  ].filter((part): part is string => part !== null)
  return parts.length > 0 ? `Routing: ${parts.join(', ')}.` : null
}

const labelName = (label: LabelRef | null): string => (label ? `${label.code} v${label.revision}` : 'none')

/** The frozen specification against the style's released revision today (null: none). */
export function compareSpec(frozen: SpecSnapshot, master: SpecSnapshot | null): SpecComparison {
  if (!master) {
    return {
      sameRevision: false,
      noMaster: true,
      bom: null,
      routing: null,
      label: { from: frozen.label, to: null, changed: false },
      summary: [`The style has no released revision today; the work order keeps revision ${frozen.revision.revision}.`],
    }
  }
  const sameRevision = frozen.revision.id === master.revision.id
  const bom = diffBoms(frozen.bom, master.bom)
  const routing = diffRoutings(frozen.steps, master.steps)
  const labelChanged = (frozen.label?.id ?? null) !== (master.label?.id ?? null)
  const summary = sameRevision
    ? [`Revision ${frozen.revision.revision} is still the style's released revision: nothing changed.`]
    : [
        `The style's released revision is now ${master.revision.revision}; the work order keeps revision ${frozen.revision.revision}.`,
        ...[bomWords(bom), routingWords(routing), labelChanged ? `Garment label template: ${labelName(frozen.label)} → ${labelName(master.label)}.` : null].filter(
          (line): line is string => line !== null,
        ),
      ]
  if (!sameRevision && summary.length === 1) summary.push('Its BOM, routing and label template are the same.')
  return { sameRevision, noMaster: false, bom, routing, label: { from: frozen.label, to: master.label, changed: labelChanged }, summary }
}
