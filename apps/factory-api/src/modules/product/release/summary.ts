import { can } from '@nexus/factory-domain/core/permissions'
import type { SummaryQuery, SummaryView } from '@nexus/factory-domain/product/release/contracts'
import { releaseGate } from '@nexus/factory-domain/product/release/gate'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { contextOf, REVISION_COLUMNS, STYLE_COLUMNS } from '../bom/store'
import { loadGate, readScopeRow } from './facts'
import { todayNow } from './gate'

/**
 * The styles list's completeness column and the side panel's compact check (B-W2b-231; PRD-232; design products.styles
 * `styles.grid` "Release blockers (count; completeness % W2b)" and the side panel "Release check, compact: '3 things before
 * release' with the first one linked"): for up to 25 styles the reader may see (product.styles.view over each style's
 * company; the others are left out), the newest DRAFT revision checked now, else the RELEASED one with the score stored at its
 * release. Counts and item words only: a finding's detail is the Release modal's (product.bom.view).
 */
export async function releaseSummary(caller: CommandCaller, query: SummaryQuery): Promise<SummaryView> {
  const actor = actorOf(contextOf(caller))
  const today = todayNow()
  return caller.withClient(async (client) => {
    const styles = (await client.style.findMany({ where: { id: { in: [...query.styleIds] } }, select: STYLE_COLUMNS })).filter((style) => can(actor, PRODUCT_STYLES_VIEW, { companyId: style.companyId }))
    const byId = new Map(styles.map((style) => [style.id, style]))
    const rows: SummaryView['styles'] = []
    for (const styleId of query.styleIds) {
      const style = byId.get(styleId)
      if (!style) continue
      const revisions = await client.styleRevision.findMany({ where: { styleId, status: { in: ['DRAFT', 'RELEASED'] } }, select: REVISION_COLUMNS, orderBy: { revision: 'desc' } })
      const draft = revisions.find((revision) => revision.status === 'DRAFT')
      const released = revisions.find((revision) => revision.status === 'RELEASED')
      if (draft) {
        const gate = releaseGate((await loadGate(client, style, draft, { today, actor: null })).facts)
        const open = gate.items.filter((item) => item.state === 'BLOCKED' || item.state === 'WARNING')
        const first = open.find((item) => item.state === 'BLOCKED') ?? open[0]
        rows.push({
          styleId,
          code: style.code,
          revision: { id: draft.id, revision: draft.revision, status: draft.status },
          checked: true,
          completenessPct: gate.completenessPct,
          blockers: gate.blockers.length,
          warnings: gate.warnings.length,
          first: first ? { code: first.code, state: first.state, message: first.message, fix: first.fix } : null,
          open: open.length,
        })
      } else if (released) {
        rows.push({
          styleId,
          code: style.code,
          revision: { id: released.id, revision: released.revision, status: released.status },
          checked: false,
          completenessPct: (await readScopeRow(client, released.id)).completenessPct,
          blockers: 0,
          warnings: 0,
          first: null,
          open: 0,
        })
      } else {
        rows.push({ styleId, code: style.code, revision: null, checked: false, completenessPct: null, blockers: 0, warnings: 0, first: null, open: 0 })
      }
    }
    return { date: today, styles: rows }
  })
}
