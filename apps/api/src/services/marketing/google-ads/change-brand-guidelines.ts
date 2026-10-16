/**
 * Google Ads (2026-10-16, programme 2 G14b leftovers) — brand guidelines turned ON for an EXISTING Performance Max
 * campaign: CampaignService.EnablePMaxBrandGuidelines. Pure: request + the live campaign (and the assets named) → ONE
 * account call, or a refusal in words.
 *
 * Checked 2026-10-16 with curl in Google's v25 reference and the v25 discovery document
 * (googleads.googleapis.com/$discovery/rest?version=v25):
 *   Campaign.brand_guidelines_enabled  "Immutable … To enable Brand Guidelines on a campaign after it has been created, use
 *                     the CampaignService.EnablePMaxBrandGuidelines method … It is not possible to disable Brand Guidelines
 *                     for an existing campaign. Incompatible with Travel Goals."
 *   POST v25/customers/{customerId}/campaigns:enablePMaxBrandGuidelines  EnablePMaxBrandGuidelinesRequest {operations[]
 *                     EnableOperation} — "A maximum of 10 enable operations"; NO validate_only (Google cannot check it first).
 *   EnableOperation   campaign (Required), auto_populate_brand_assets (Required: "If true, top-performing brand assets will be
 *                     automatically populated. If false, the brand_assets field is required"), brand_assets
 *                     BrandCampaignAssets {business_name_asset (Required), logo_asset[] (Required: square logos),
 *                     landscape_logo_asset[]} — "A business_name and at least one logo_asset are required", final_uri_domain,
 *                     main_color / accent_color (hex, each required with the other), font_family ("Open Sans", "Roboto",
 *                     "Roboto Slab", "Montserrat", "Poppins", "Lato", "Oswald", or "Playfair Display").
 *   EnablePMaxBrandGuidelinesResponse  results[] EnablementResult {campaign, enablement_error (google.rpc.Status)}: an
 *                     answer of HTTP 200 may still carry Google's refusal per campaign (account-client.ts reads it).
 *   performance-max/create-campaign  with brand guidelines the campaign holds exactly one BUSINESS_NAME and one to five
 *                     logos (LOGO and LANDSCAPE_LOGO together) as CampaignAssets.
 *
 * It cannot be undone (Google has no way to turn brand guidelines off again): the tool's reversibility is 'none'. It moves
 * no money (no bid, budget or reach changes): no SPENDS MONEY line; the brand's assets are the campaign's from then on.
 */
import { changeLines, plural, type GoogleChangeDraft } from './change-draft.js'
import { imageProblem, type ImageFieldType } from './change-assets-all.js'
import { BRAND_FONTS, ownLinks } from './change-pmax.js'
import type { PmaxAsset, PmaxCampaignLive } from './live-pmax.js'
import type { PreparedImage } from './asset-images.js'

export const ENABLE_BRAND_GUIDELINES_PATH = 'campaigns:enablePMaxBrandGuidelines' as const
const HEX = /^#[0-9A-Fa-f]{6}$/
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i
const MAX_LOGOS = 5

export interface BrandGuidelinesRequest {
  campaignId: string
  /** Google picks the campaign's top-performing brand assets (else Nexus names them, from the request or the asset groups). */
  autoPopulate?: boolean
  businessNameAssetId?: string
  logoAssetIds?: string[]
  landscapeLogoAssetIds?: string[]
  mainColor?: string
  accentColor?: string
  font?: string
  finalUriDomain?: string
}

export interface BrandGuidelinesRecord {
  campaignId: string
  brandGuidelines: boolean
  autoPopulate?: boolean
  businessNameAssetId?: string | null
  logoAssetIds?: string[]
  landscapeLogoAssetIds?: string[]
}

const byId = (a: string, b: string) => (a.length - b.length) || a.localeCompare(b)
const unique = (xs: string[]) => [...new Set(xs)].sort(byId)

/** The account call that turns brand guidelines on, or why it is not sent. */
export function brandGuidelinesDraft(customer: string, r: BrandGuidelinesRequest, camp: PmaxCampaignLive | null, named: PmaxAsset[]): GoogleChangeDraft | { refusal: string } {
  if (!camp) return { refusal: `Campaign ${r.campaignId} is not in this account (or it is removed).` }
  if (camp.type !== 'PERFORMANCE_MAX') return { refusal: `"${camp.name}" is a ${camp.type ?? 'campaign'} campaign: brand guidelines are for Performance Max campaigns.` }
  if (camp.brandGuidelines) return { refusal: `"${camp.name}" has brand guidelines on already (its business name and logos are the campaign's: set-google-pmax brandAssets).` }
  if (camp.notRead.length) return { refusal: `Parts of "${camp.name}" could not be read (${camp.notRead.map((n) => n.part).join(', ')}): Nexus does not change what it cannot read.` }
  const problems: string[] = []
  // What the campaign's asset groups hold today (with brand guidelines off, the brand's assets are each asset group's).
  const links = camp.assetGroups.flatMap((g) => ownLinks(g.assets))
  const inGroups = (field: string) => unique(links.filter((l) => l.fieldType === field).map((l) => l.assetId))
  const names = inGroups('BUSINESS_NAME')
  const logos = inGroups('LOGO')
  const wide = inGroups('LANDSCAPE_LOGO')
  if (!names.length || !logos.length) {
    return { refusal: `"${camp.name}" has ${!names.length ? 'no business name' : ''}${!names.length && !logos.length ? ' and ' : ''}${!logos.length ? 'no square logo' : ''} in its asset groups: brand guidelines need a business name and at least one square logo. Add them with set-google-pmax (assetGroups[].addAssets: adBusinessName, a LOGO image), then ask again.` }
  }
  const asset = (id: string) => named.find((a) => a.assetId === id)
  const op: Record<string, unknown> = { campaign: `${customer}/campaigns/${camp.campaignId}`, autoPopulateBrandAssets: r.autoPopulate === true }
  let chosen: { name: string | null; logos: string[]; wide: string[] } = { name: null, logos: [], wide: [] }
  if (r.autoPopulate) {
    if (r.businessNameAssetId || r.logoAssetIds?.length || r.landscapeLogoAssetIds?.length) problems.push('with autoPopulate Google picks the brand assets: name none')
  } else {
    const name = r.businessNameAssetId?.trim() || (names.length === 1 ? names[0] : null)
    if (!name) problems.push(`its asset groups hold ${names.length} business names (assets ${names.join(', ')}): name one (businessNameAssetId), or let Google pick (autoPopulate)`)
    const square = r.logoAssetIds?.length ? unique(r.logoAssetIds.map((x) => x.trim())) : logos.slice(0, MAX_LOGOS)
    const landscape = r.landscapeLogoAssetIds !== undefined ? unique(r.landscapeLogoAssetIds.map((x) => x.trim())) : wide.slice(0, Math.max(0, MAX_LOGOS - square.length))
    if (!square.length) problems.push('brand guidelines need at least one square logo (logoAssetIds)')
    if (square.length + landscape.length > MAX_LOGOS) problems.push(`${square.length + landscape.length} logos: brand guidelines take at most ${MAX_LOGOS} (square and landscape together)`)
    // An asset named that the asset groups do not hold: it must be in the account, of the right type and shape.
    const check = (id: string, field: 'BUSINESS_NAME' | 'LOGO' | 'LANDSCAPE_LOGO') => {
      if (!/^\d{1,20}$/.test(id)) { problems.push(`asset "${id}" is not a Google id`); return }
      if ((field === 'BUSINESS_NAME' ? names : field === 'LOGO' ? logos : wide).includes(id)) return
      const a = asset(id)
      if (!a) { problems.push(`asset ${id} is not in this account`); return }
      if (field === 'BUSINESS_NAME') {
        if (a.type !== 'TEXT') problems.push(`asset ${id} is ${a.type ?? 'of another type'}: a business name is a text asset`)
        else if ((a.text ?? '').length > 25) problems.push(`asset ${id} ("${(a.text ?? '').slice(0, 30)}") is longer than the 25 characters of a business name`)
        return
      }
      if (a.type !== 'IMAGE') { problems.push(`asset ${id} is ${a.type ?? 'of another type'}: a logo is an image asset`); return }
      if (a.width && a.height && a.mimeType) {
        const p = imageProblem(`asset ${id}`, field as ImageFieldType, { mimeType: a.mimeType as PreparedImage['mimeType'], width: a.width, height: a.height })
        if (p) problems.push(p)
      }
    }
    if (name) check(name, 'BUSINESS_NAME')
    for (const id of square) check(id, 'LOGO')
    for (const id of landscape) check(id, 'LANDSCAPE_LOGO')
    chosen = { name, logos: square, wide: landscape }
    op.brandAssets = {
      ...(name ? { businessNameAsset: `${customer}/assets/${name}` } : {}),
      logoAsset: square.map((id) => `${customer}/assets/${id}`),
      ...(landscape.length ? { landscapeLogoAsset: landscape.map((id) => `${customer}/assets/${id}`) } : {}),
    }
  }
  if (!!r.mainColor !== !!r.accentColor) problems.push('give the main and the accent color together (Google\'s rule)')
  for (const c of [r.mainColor, r.accentColor]) if (c && !HEX.test(c)) problems.push(`"${c}" is not a color as #rrggbb`)
  if (r.font && !(BRAND_FONTS as readonly string[]).includes(r.font)) problems.push(`"${r.font}" is not a font Google takes (${BRAND_FONTS.join(', ')})`)
  if (r.finalUriDomain && !DOMAIN.test(r.finalUriDomain.trim())) problems.push(`"${r.finalUriDomain}" is not a domain (like shop.example)`)
  if (problems.length) return { refusal: `Not queued (${plural(problems.length, 'problem')}): ${problems.join(' · ')}. Nothing was sent.` }
  if (r.mainColor) { op.mainColor = r.mainColor; op.accentColor = r.accentColor }
  if (r.font) op.fontFamily = r.font
  if (r.finalUriDomain) op.finalUriDomain = r.finalUriDomain.trim().toLowerCase()

  const words = (id: string | null) => {
    const a = id ? asset(id) ?? links.find((l) => l.assetId === id) : null
    return a ? `${id}${a.text ? ` ("${a.text}")` : ''}` : (id ?? '(none)')
  }
  const lines: Array<[string, unknown, unknown]> = [['brand guidelines', 'off', 'ON (for good: Google cannot turn them off again)']]
  if (r.autoPopulate) lines.push(['brand assets', 'in each asset group', 'Google picks the top-performing business name and logos'])
  else {
    lines.push(['business name', 'in each asset group', `the campaign's: asset ${words(chosen.name)}`])
    lines.push(['logos', 'in each asset group', `the campaign's: ${plural(chosen.logos.length, 'square logo')}${chosen.wide.length ? `, ${plural(chosen.wide.length, 'landscape logo')}` : ''} (assets ${[...chosen.logos, ...chosen.wide].join(', ')})`])
  }
  if (r.mainColor) lines.push(['colors', '(none)', `${r.mainColor} / ${r.accentColor}`])
  if (r.font) lines.push(['font', '(none)', r.font])
  if (r.finalUriDomain) lines.push(['final URL domain', '(none)', op.finalUriDomain])
  const { changes } = changeLines(lines)
  const record: BrandGuidelinesRecord = {
    campaignId: camp.campaignId, brandGuidelines: true,
    ...(r.autoPopulate ? { autoPopulate: true } : { businessNameAssetId: chosen.name, logoAssetIds: chosen.logos, landscapeLogoAssetIds: chosen.wide }),
  }
  return {
    summary: `Google Ads Performance Max "${camp.name}": turn brand guidelines ON — for good (Google cannot turn them off again).`,
    changes,
    totals: { operations: 1, campaigns: 1 },
    warnings: [
      'It cannot be undone: Google has no way to turn brand guidelines off for a campaign once they are on (Campaign.brand_guidelines_enabled).',
      'From then on the business name and logos are the campaign\'s (set-google-pmax brandAssets), not each asset group\'s; colors and a font guide what Google makes on its own.',
      ...(camp.status === 'ENABLED' ? [`"${camp.name}" serves: its ads show the campaign's brand assets once Google applies the change.`] : []),
    ],
    spendsMoney: [],
    skipped: [],
    operations: [{ accountCall: { path: ENABLE_BRAND_GUIDELINES_PATH, body: { operations: [op] } } }],
    stands: {
      campaign: `${camp.campaignId}:${camp.status}:${camp.brandGuidelines}`,
      brand: { names, logos, wide },
      named: named.map((a) => `${a.assetId}:${a.type}:${a.width ?? ''}x${a.height ?? ''}`).sort(),
    },
    before: { campaignId: camp.campaignId, brandGuidelines: false } satisfies BrandGuidelinesRecord,
    after: record,
  }
}
