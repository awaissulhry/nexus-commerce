import type { AmazonTemplateParse } from '../amazon/template-workbook.js'
import type { ChannelSpec } from '../pim/channel-specs/types.js'
import { buildAmazonDraftFields } from './amazon-draft.js'
import { readerMapping, type ReaderMapping } from './decisions.js'
import { amazonFormOf, formLabel } from './form.js'
import { ensureSetForForm, fieldRowOf } from './store.js'

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
  const fields = set.fields.map(fieldRowOf)
  const label = formLabel(form, set.version, set.status)
  const warnings: string[] = []
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
