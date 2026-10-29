import type { Prisma } from '@nexus/factory-db'
import { ConflictError, ValidationError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { layoutOf, layoutProblems, layoutToStore, type TodayLayout } from '@nexus/factory-domain/insights/actions'
import { command, StaleVersionError, type CommandCaller } from '../../core/command'
import { lockLayout, readLayout, writeLayout, type LayoutRow } from './actions-store'
import { officeContextOf } from './viewer'

/**
 * "Arrange Today" (B-W1-52 actions; design home.today popup arrange: show or hide sections and panels, order them,
 * widths, "My main role"; saved on the server per person): GET and PUT /home/today/layout. A person reads and saves only
 * their own layout (the session's person, never an id in the request). Version 0: nothing saved yet (the design's order);
 * the first save creates it, later ones send its version. Rules: factory-domain insights/actions.
 */

const layoutView = (layout: TodayLayout, row: LayoutRow | null) => ({
  layout: { sections: layout.sections.map((section) => ({ ...section })), panels: layout.panels.map((panel) => ({ ...panel })), mainLens: layout.mainLens },
  version: row?.version ?? 0,
  updatedAt: row ? toUtcIso(row.updatedAt) : null,
})

/** GET /home/today/layout: my arrangement of Today, or the design's when I saved none. */
export async function getLayout(caller: CommandCaller) {
  const context = officeContextOf(caller)
  const row = await caller.withClient((db) => readLayout(db, context.actorId))
  return layoutView(layoutOf(row), row)
}

export interface LayoutBody {
  readonly sections: readonly { readonly id: string; readonly hidden: boolean }[]
  readonly panels: readonly { readonly id: string; readonly hidden: boolean; readonly width: string }[]
  readonly mainLens: string | null
  readonly version: number
}

/** PUT /home/today/layout (command insights.saveLayout). */
export async function saveLayout(caller: CommandCaller, body: LayoutBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const problems = layoutProblems(body)
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The layout is not valid.', problems)
  const wanted = layoutToStore(body)
  // Read and compared inside the command (after its receipt), under the layout's row lock.
  const { result } = await command(
    caller,
    { name: 'insights.saveLayout', idempotencyKey, input: body },
    async (tools) => {
      const existing = await lockLayout(tools.tx, context.actorId)
      if ((existing?.version ?? 0) !== body.version) throw new StaleVersionError('TodayLayout', existing?.id ?? context.actorId, existing?.version ?? 0, body.version)
      const stored = {
        sections: wanted.sections.map((section) => ({ ...section })) as Prisma.InputJsonValue,
        panels: wanted.panels.map((panel) => ({ ...panel })) as Prisma.InputJsonValue,
        mainLens: wanted.mainLens,
      }
      const row = await writeLayout(tools.tx, existing, stored, { userId: context.actorId, now: tools.now })
      tools.audit({
        recordType: 'TodayLayout',
        recordId: row.id,
        companyId: null,
        ...(existing ? { before: { sections: existing.sections, panels: existing.panels, mainLens: existing.mainLens } } : {}),
        after: stored,
      })
      return layoutView(layoutOf(row), row)
    },
  ).catch((error: unknown) => {
    if ((error as { code?: unknown } | null)?.code === 'P2002') throw new ConflictError('Your layout was just saved from another window: read it again.')
    throw error
  })
  return result
}
