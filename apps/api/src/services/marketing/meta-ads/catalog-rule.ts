/**
 * Meta step 18 review A4 — the ONE rule for a catalog or a product set a change of THIS business names (a promoted object's
 * product_catalog_id / product_set_id): the catalog must be owned by, or a client catalog of, the business portfolio of
 * the business's chosen ad account, AND that portfolio must not be another Nexus business's too (nexus_meta_links_taken
 * PORTFOLIO, step 10's migration 20261021r10: two businesses whose ad accounts sit in one portfolio never name each other's
 * catalogs). A product set counts as its catalog. The same rule as step 12's catalog reads; the tool asks it before the
 * preview, and the gateway asks it again before it sends anything (gateway.ts metaBodyIdsProblem).
 *
 * Checked 2026-10-21: reference/ad-account `business` (the portfolio of an ad account), business/owned_product_catalogs and
 * business/client_product_catalogs (Meta's SDK business.py get_owned_product_catalogs / get_client_product_catalogs),
 * product-set `product_catalog` (productset.py). Reads only, through the gateway.
 */
import { metaObjectId } from '../../cx/connectors/meta/discovery.js'
import { MetaReadError } from './errors.js'
import { metaReadAll, metaReadOne } from './read-client.js'
import { takenIds } from './taken.js'

export interface CatalogRuleTarget { connectionId: string; adAccountId: string }

const idIn = (body: unknown, key: string): string | null => {
  const inner = body && typeof body === 'object' ? (body as Record<string, unknown>)[key] : null
  return metaObjectId(inner && typeof inner === 'object' ? (inner as Record<string, unknown>).id : null)
}

/** Why this catalog / product set may not be named by a change of the chosen ad account, in words; null when it may. */
export async function metaCatalogProblem(target: CatalogRuleTarget, ids: { catalogId?: string | null; productSetId?: string | null }): Promise<string | null> {
  if (!ids.catalogId && !ids.productSetId) return null
  try {
    const account = await metaReadOne({ connectionId: target.connectionId }, { operation: 'catalogRule.portfolio', path: `act_${target.adAccountId}`, query: { fields: 'business{id}' } })
    const portfolio = idIn(account.body, 'business')
    if (!portfolio) return 'The chosen ad account names no business portfolio, so Nexus cannot confirm whose catalog this is: no catalog is sent.'
    if ((await takenIds('PORTFOLIO', [portfolio])).has(portfolio)) {
      return 'Another business in Nexus uses an ad account of this Meta business portfolio, so its catalogs may be that business\'s: Nexus names no catalog of it here.'
    }
    let catalogId = ids.catalogId ?? null
    if (ids.productSetId) {
      const set = await metaReadOne({ connectionId: target.connectionId }, { operation: 'catalogRule.productSet', path: ids.productSetId, query: { fields: 'id,product_catalog{id}' } })
      const ofSet = idIn(set.body, 'product_catalog')
      if (!ofSet) return `Meta does not say which catalog product set ${ids.productSetId} is in, so it is not sent.`
      if (catalogId && catalogId !== ofSet) return `Product set ${ids.productSetId} is not in catalog ${catalogId}.`
      catalogId = ofSet
    }
    const catalogs = new Set<string>()
    for (const edge of ['owned_product_catalogs', 'client_product_catalogs']) {
      await metaReadAll({ connectionId: target.connectionId }, { operation: `catalogRule.${edge}`, path: `${portfolio}/${edge}`, query: { fields: 'id', limit: 100 }, maxPages: 10 }, (rows) => {
        for (const row of rows) { const id = metaObjectId(row.id); if (id) catalogs.add(id) }
      })
    }
    return catalogs.has(catalogId!) ? null : `Catalog ${catalogId} is not one the chosen ad account's business portfolio owns or was given, so it is not sent.`
  } catch (err) {
    // Round 2 — a lookup that fails (Meta's refusal, a lost connection, the database) never lets a catalog through: the
    // change is refused in words, here and at the gateway, and nothing is sent.
    if (err instanceof MetaReadError) return `Nexus could not confirm the catalog (${err.message}), so it is not sent.`
    return `Nexus could not confirm the catalog (${err instanceof Error ? err.message : String(err)}), so it is not sent.`
  }
}
