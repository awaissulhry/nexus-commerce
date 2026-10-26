/**
 * Meta step 35 (2026-10-25) — set-meta-instagram-product-tags on the write allow-list (meta-calls.ts writeRules):
 *
 *   igmedia.productTags   POST /<media id>/product_tags   updated_tags        (CT-155: add a tag, or move one already there)
 *   iguser.productAppeal  POST /<ig user id>/product_appeal  appeal_reason + product_id  (CT-158)
 *
 * The object is confirmed by the gateway before anything goes (gateway.ts metaOwnerProblem → metaInstagramOwnerProblem, step
 * 26's): a media of the business's CHOSEN Instagram account (Meta's owner, else its username), or that account itself; every
 * product id inside the body is checked by the catalog read rule (gateway.ts metaBodyIdsProblem kind `productitem`, step
 * 25's: an item of a catalog this business may read). Both go with the system user's token, as step 13's reads of the same
 * edges do (ig-media/product_tags.md and ig-user/product_appeal.md: a Business Manager admin role on the Shop's portfolio,
 * catalog_management, instagram_basic, instagram_shopping_tag_products, ads_read / ads_management — no Page token).
 * A carousel slide is tagged through its own id: Meta's SDK (igmedia.py create_product_tag) also takes `child_index` on the
 * album, which Nexus never sends (a wrong index would tag another slide, publicly and for good): LIVE-PROBES CT35-07.
 * Neither has a Meta check (validate_only) or a DELETE (CT-156: Meta documents no tag removal; an appeal cannot be withdrawn).
 * The tag list is judged by the leaf meta-instagram-tags.ts (Q9: the same judge a new post's product_tags will use).
 *
 * Import rule (lane C4): only types from meta-calls.ts, the leaf text patterns and the leaf tag judge.
 */
import type { MetaWriteBodyId, MetaWriteRule } from './meta-calls.js'
import { META_NAME_TEXT } from './meta-write-text.js'
import { META_IG_APPEAL_REASON_MAX, metaIgProductTagIds, metaIgProductTagsProblem } from './meta-instagram-tags.js'

type Params = ReadonlyMap<string, string>
const META_ID = /^[1-9]\d{0,24}$/
const chars = (v: string) => [...v].length

/**
 * A tag list as the gateway sees it: the media's type is the tool's to read, so the shape decides — tags with x / y are an
 * image's (Meta: at most 20), tags without are a video's or a Reel's (at most 30, a Reel's limit). Mixed lists are refused.
 */
export function metaUpdatedTagsProblem(value: string): string | null {
  let first: unknown
  try { first = (JSON.parse(value) as unknown[])?.[0] } catch { first = undefined }
  const placed = !!first && typeof first === 'object' && 'x' in (first as Record<string, unknown>)
  return metaIgProductTagsProblem(value, placed ? 'image' : 'reel')
}

const productIds = (key: string) => (params: Params): MetaWriteBodyId[] => metaIgProductTagIds(params.get(key)).map((id) => ({ id, kind: 'productitem' as const }))

export const META_INSTAGRAM_TAG_WRITE_RULES: readonly MetaWriteRule[] = [
  {
    name: 'igmedia.productTags', method: 'POST', path: /^[1-9]\d{0,24}\/product_tags$/, kinds: ['igmedia'],
    required: ['updated_tags'], optional: [], edgeCall: true, budget: false, maxBody: 12_000,
    values: (params) => metaUpdatedTagsProblem(params.get('updated_tags') ?? ''),
    ids: productIds('updated_tags'),
  },
  {
    name: 'iguser.productAppeal', method: 'POST', path: /^[1-9]\d{0,24}\/product_appeal$/, kinds: ['iguser'],
    required: ['appeal_reason', 'product_id'], optional: [], edgeCall: true, budget: false, maxBody: 4 * META_IG_APPEAL_REASON_MAX + 200,
    text: { appeal_reason: META_NAME_TEXT },
    values: (params) => {
      const reason = params.get('appeal_reason') ?? ''
      if (reason !== reason.trim() || !reason || chars(reason) > META_IG_APPEAL_REASON_MAX) return `appeal_reason is 1 to ${META_IG_APPEAL_REASON_MAX} characters of text, with no space at either end`
      return META_ID.test(params.get('product_id') ?? '') ? null : 'product_id is a catalog product\'s Meta id (digits only)'
    },
    ids: (params) => (META_ID.test(params.get('product_id') ?? '') ? [{ id: params.get('product_id')!, kind: 'productitem' }] : []),
  },
]
