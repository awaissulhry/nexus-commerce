import type { AreaUom } from '@nexus/factory-domain/inventory/hides/area'
import { minimumRemnantIn, remnantSizeRefusal, type RemnantRefusal } from '@nexus/factory-domain/inventory/remnants/rules'
import type { DecimalInput } from '@nexus/factory-domain/tax/decimal'
import type { CommandTx } from '../../../core/command'
import { cuttingRulesFor } from '../../production/settings/cutting-rules'

/**
 * The smallest remnant a site keeps (B-W2b-219; SCM-254; B-W2b-100's MINIMUM_REMNANT as the default): ProductionSettings
 * .minimumRemnantArea + minimumRemnantUom of the site (B-W2b-204's columns, set on the Cutting card of Floor rules & codes),
 * read in the office's or the floor's scope (the floor role reads those columns of its own site's row). A piece under it is
 * waste: the pick's return and the cutting table's Hide done refuse it in words (REMNANT_TOO_SMALL).
 */

export interface SiteMinimum {
  readonly area: string
  readonly uom: AreaUom
  /** true: the site's own setting; false: the default every site without floor rules uses. */
  readonly setting: boolean
}

/** The site's smallest remnant. */
export async function minimumRemnantFor(db: Pick<CommandTx, 'productionSettings'>, siteId: string): Promise<SiteMinimum> {
  const { rules, isDefault } = await cuttingRulesFor(db, siteId)
  return { area: rules.minimumRemnant.area, uom: rules.minimumRemnant.uom, setting: !isDefault }
}

/** The site's smallest remnant in a leather's base unit (four places), or null for a unit that is not an area. */
export async function minimumRemnantAt(db: Pick<CommandTx, 'productionSettings'>, siteId: string, baseUom: string): Promise<string | null> {
  const minimum = await minimumRemnantFor(db, siteId)
  return minimumRemnantIn(baseUom, minimum)?.toFixed(4) ?? null
}

/** A piece coming back as a remnant at this site, refused in words when it is under the site's minimum (else null). */
export async function remnantSizeRefusalAt(db: Pick<CommandTx, 'productionSettings'>, siteId: string, facts: { readonly hideCode: string; readonly baseArea: DecimalInput; readonly baseUom: string }): Promise<RemnantRefusal | null> {
  return remnantSizeRefusal(facts, await minimumRemnantFor(db, siteId))
}
