import type { CompareRoutingQuery, RoutingDiffView } from '@nexus/factory-domain/product/routing/contracts'
import { diffRoutings } from '@nexus/factory-domain/product/routing/diff'
import type { StepData } from '@nexus/factory-domain/product/routing/rules'
import type { CommandCaller } from '../../../core/command'
import { findRevision } from '../bom/store'
import { readSteps, readStyleFor } from './store'

/** What changed from one revision's routing to another's (both of this style; a read, so no command()). */
export async function compareRoutings(caller: CommandCaller, styleId: string, query: CompareRoutingQuery): Promise<RoutingDiffView> {
  await readStyleFor(caller, styleId)
  return caller.withClient(async (client) => {
    const from = await findRevision(client, styleId, query.from)
    const to = await findRevision(client, styleId, query.to)
    const diff = diffRoutings(await readSteps(client, from.id), await readSteps(client, to.id))
    const ref = (step: StepData) => ({ stepId: step.id, seq: step.seq, operationId: step.operationId, code: step.code, standardMinutes: step.standardMinutes })
    const revisionRef = (row: typeof from) => ({ id: row.id, revision: row.revision, status: row.status })
    return {
      from: revisionRef(from),
      to: revisionRef(to),
      added: diff.added.map(ref),
      removed: diff.removed.map(ref),
      changed: diff.changed.map((change) => ({ from: ref(change.from), to: ref(change.to), fields: [...change.fields] })),
      unchanged: diff.unchanged,
      minutes: { ...diff.minutes },
    }
  })
}
