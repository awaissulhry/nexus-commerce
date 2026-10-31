import { BulkTargetError, type AnyBulkTarget } from './target'
import { BULK_TARGETS } from './targets'

/** The registry of bulk targets (./target.ts says what a target is; ./targets/index.ts lists the lists'). */

let configured: ReadonlyMap<string, AnyBulkTarget> | undefined
let fromTargets: ReadonlyMap<string, AnyBulkTarget> | undefined

function mapOf(targets: readonly AnyBulkTarget[]): ReadonlyMap<string, AnyBulkTarget> {
  const map = new Map<string, AnyBulkTarget>()
  for (const target of targets) {
    if (map.has(target.listKey)) throw new BulkTargetError(`${target.listKey}: two bulk targets`)
    map.set(target.listKey, target)
  }
  return map
}

/** Tests: the targets to use (undefined: the real ones again). */
export function useBulkTargets(targets: readonly AnyBulkTarget[] | undefined): void {
  configured = targets ? mapOf(targets) : undefined
}

export function processBulkTargets(): ReadonlyMap<string, AnyBulkTarget> {
  if (configured) return configured
  fromTargets ??= mapOf(BULK_TARGETS)
  return fromTargets
}

/** The target of a list key, or undefined (the list is not edited in bulk). */
export function bulkTargetOf(listKey: string): AnyBulkTarget | undefined {
  return processBulkTargets().get(listKey)
}
