import type { AmazonTemplateParse } from '../amazon/template-workbook.js'
import type { ChannelSpec } from '../pim/channel-specs/types.js'
import { amazonChannelKey, type MappingTransform } from '@nexus/shared/channel-mapping'
import { buildAmazonDraftFields, dictionaryTransform } from './amazon-draft.js'
import { readerMapping, type ReaderMapping } from './decisions.js'
import { amazonFormOf, formLabel } from './form.js'
import { ensureSetForForm, fieldRowOf, getSet, learnSpellings } from './store.js'

/**
 * CHMAP M2 — the mapping version an Amazon file is read with (host side: it reads and may write the mapping
 * tables). A new template version gets a DRAFT made by the rules, with the Owner's earlier decisions laid over it.
 */
export interface ImportMappingInfo { setId: string; version: number; status: string; label: string; created: boolean }

export async function amazonImportMapping(parsed: AmazonTemplateParse, specs: ReadonlyMap<string, ChannelSpec>, ctx: { marketplace: string; primaryLanguage: string; marketLanguages: string[] }):
  Promise<{ mapping: ReaderMapping; info: ImportMappingInfo; warnings: string[] }> {
  const form = amazonFormOf(parsed, ctx.marketplace)
  const productTypes = form.formKey.split('+').filter(t => t && t !== 'UNKNOWN')
  const build = () => buildAmazonDraftFields(parsed, new Map(specs), { ...ctx, productTypes })
  const { set, created } = await ensureSetForForm(form, build)
  let fields = set.fields.map(fieldRowOf)
  const label = formLabel(form, set.version, set.status)
  const warnings: string[] = []
  if (!created && set.status === 'DRAFT') {
    // A draft learns this file's spellings (labels it had not seen yet), so writing back reproduces them.
    const learned = new Map<string, Extract<MappingTransform, { op: 'dictionary' }>>()
    for (const header of parsed.headers) { const t = dictionaryTransform(parsed, header); if (t && (t.prefer || t.write)) learned.set(amazonChannelKey(header), t) }
    const changed = learned.size ? await learnSpellings(set.id, learned) : []
    if (changed.length) fields = (await getSet(set.id)).fields
  }
  if (created) warnings.push(`${label}: the first file of this form${form.templateVersion ? ` (template ${form.templateVersion})` : ''}. Nexus made a new mapping version from its rules; review it on the Mapping page.`)
  else {
    // A rule row records what the rule decided when the version was made. The rule (or the channel schema behind
    // it) can change later: the reader follows the current rule, and the version says so until it is renewed.
    const fresh = new Map(build().map(r => [r.channelKey, r]))
    const stale = fields.filter(f => {
      const now = fresh.get(f.channelKey)
      return f.decidedBy === 'rule' && now && (now.state !== f.state || now.targetKind !== f.targetKind || now.targetKey !== f.targetKey)
    }).map(f => f.channelKey)
    if (stale.length) warnings.push(`${label}: the rules for ${stale.length} column${stale.length === 1 ? '' : 's'} changed since this version was made (${stale.slice(0, 3).join(', ')}${stale.length > 3 ? ', …' : ''}). The current rules were used; make a new version on the Mapping page to record them.`)
  }
  return { mapping: readerMapping(set, label, fields), info: { setId: set.id, version: set.version, status: set.status, label, created }, warnings }
}

/**
 * The Owner uploads a template once (Mapping page): Nexus keeps its bytes (`AmazonTemplateVault`, the export base)
 * and finds or makes its mapping version. Nothing else is read from the file; its data rows are not imported.
 */
export async function registerAmazonTemplate(bytes: Buffer, filename: string) {
  const [{ detectAmazonTemplate }, { captureTemplateToVault }, { loadAmazonSpec }, { amazonProductTypes }, { normalizeLanguage }, { marketLanguages }, { default: prisma }] = await Promise.all([
    import('../amazon/template-workbook.js'), import('../amazon/template-vault.service.js'), import('../pim/channel-specs/index.js'),
    import('../pim/catalog-amazon-workbook.js'), import('../pim/content-language.js'), import('../pim/market-languages.js'), import('../../db.js'),
  ])
  const parsed = await detectAmazonTemplate(bytes, { strict: true })
  if (!parsed) throw new Error('This is not an Amazon template. Upload the file you downloaded from Seller Central.')
  if (parsed.meta.grammar !== 'v2' || !parsed.meta.templateIdentifier) throw new Error('Upload a current Amazon template (it names its template id); old flat files cannot be written back.')
  const marketplace = parsed.meta.marketplace
  if (!marketplace) throw new Error('The template does not name its marketplace')
  const market = await prisma.marketplace.findFirst({ where: { channel: 'AMAZON', code: marketplace }, select: { language: true, languages: true } })
  if (!market?.language) throw new Error(`Configure the Amazon ${marketplace} marketplace language first`)
  const specs = new Map<string, ChannelSpec>()
  for (const type of new Set([...amazonProductTypes(parsed), ...(parsed.meta.templateProductTypes ?? [])])) { try { specs.set(type, await loadAmazonSpec(marketplace, type)) } catch { /* the draft says which schema to refresh */ } }
  const languages = marketLanguages('AMAZON', marketplace, [{ channel: 'AMAZON', code: marketplace, language: market.language, languages: market.languages ?? [] }])
  const primaryLanguage = normalizeLanguage(languages[0] ?? market.language)
  await captureTemplateToVault(prisma as never, bytes, parsed.meta, filename)
  const { info, warnings } = await amazonImportMapping(parsed, specs, { marketplace, primaryLanguage, marketLanguages: [...new Set([primaryLanguage, ...languages.map(normalizeLanguage)])] })
  return { ...info, templateVersion: parsed.meta.templateVersion ?? null, warnings }
}
