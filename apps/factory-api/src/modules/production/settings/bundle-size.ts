import { standardBundleSizeOf } from '@nexus/factory-domain/production/bundles/rules'
import type { CommandTx } from '../../../core/command'

/**
 * The site's standard bundle size (MES-065; ProductionSettings.standardBundleSize: 10 for a site without floor rules),
 * for the bundles step (B-W1-41): what a make or a proposal uses when it names no size. Office or floor scope, inside a
 * command or on a request's client. The floor role reads only some columns of the row (never the legal basis), so the
 * read names its one column.
 */
export async function standardBundleSizeFor(db: Pick<CommandTx, 'productionSettings'>, siteId: string): Promise<number> {
  return standardBundleSizeOf(await db.productionSettings.findUnique({ where: { id: siteId }, select: { standardBundleSize: true } }))
}
