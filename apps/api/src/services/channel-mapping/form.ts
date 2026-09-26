import { createHash } from 'node:crypto'
import { amazonChannelKey, type MappingForm } from '@nexus/shared/channel-mapping'
import type { AmazonTemplateParse } from '../amazon/template-workbook.js'

/**
 * CHMAP — what FORM a channel file is: channel · marketplace · kind · key (the product types or categories it is
 * made for), plus the template's own id and version and a fingerprint of its ordered channel keys. Pure.
 */

export const keyFingerprint = (channelKeys: readonly string[]) => createHash('sha256').update(channelKeys.join('\n')).digest('hex')

/** The form of an Amazon template (current or old flat file). `marketplace` is the file's own when it states one. */
export function amazonFormOf(parsed: AmazonTemplateParse, marketplace: string): MappingForm {
  const meta = parsed.meta
  const types = meta.templateProductTypes?.length ? meta.templateProductTypes : meta.productTypes
  const channelKeys = parsed.headers.map(amazonChannelKey)
  return {
    channel: 'AMAZON',
    marketplace: (meta.marketplace ?? marketplace).toUpperCase(),
    formKind: meta.grammar === 'legacy' ? 'AMAZON_FLAT_FILE' : 'AMAZON_TEMPLATE',
    formKey: [...new Set(types.map(t => t.toUpperCase()))].sort().join('+') || 'UNKNOWN',
    templateIdentifier: meta.templateIdentifier ?? null,
    templateVersion: meta.templateVersion ?? null,
    language: meta.contentLanguageTag ?? null,
    layout: { sheet: meta.sheet, labelRow: meta.attrRow > 1 ? meta.attrRow - 1 : null, keyRow: meta.attrRow, dataRow: meta.dataStartRow },
    keyFingerprint: keyFingerprint(channelKeys),
  }
}

/** The form of our eBay workbook: its categories and its (normalised) columns. */
export function ebayFormOf(input: { marketplace: string; sheet: string; categories: readonly string[]; channelKeys: readonly string[] }): MappingForm {
  return {
    channel: 'EBAY',
    marketplace: input.marketplace.toUpperCase(),
    formKind: 'EBAY_WORKBOOK',
    formKey: [...new Set(input.categories.filter(Boolean))].sort().join('+') || 'UNKNOWN',
    templateIdentifier: null,
    templateVersion: null,
    language: null,
    layout: { sheet: input.sheet, labelRow: null, keyRow: 1, dataRow: 2 },
    keyFingerprint: keyFingerprint(input.channelKeys),
  }
}

/**
 * NCF (`docs/studies/native-channel-files.md` §3) — the form of Shopify's product CSV for ONE store: marketplace
 * `GLOBAL`, form key = the store's account (its metafield columns are its own), and the normalised column keys
 * (classic and current header names key alike, `shopify-draft.ts`).
 */
export function shopifyFormOf(input: { accountId: string; channelKeys: readonly string[] }): MappingForm {
  return {
    channel: 'SHOPIFY',
    marketplace: 'GLOBAL',
    formKind: 'SHOPIFY_PRODUCT_CSV',
    formKey: input.accountId,
    templateIdentifier: null,
    templateVersion: null,
    language: null,
    layout: { sheet: 'CSV', labelRow: null, keyRow: 1, dataRow: 2 },
    keyFingerprint: keyFingerprint(input.channelKeys),
  }
}

const CHANNEL_NAME: Record<string, string> = { AMAZON: 'Amazon', EBAY: 'eBay', SHOPIFY: 'Shopify' }
export const formLabel = (form: Pick<MappingForm, 'channel' | 'marketplace' | 'formKey'>, version?: number, status?: string) =>
  `${CHANNEL_NAME[form.channel] ?? form.channel} ${form.channel === 'SHOPIFY' ? '· product CSV' : `${form.marketplace} · ${form.formKey}`}${version ? ` · v${version}` : ''}${status ? ` (${status.toLowerCase()})` : ''}`
