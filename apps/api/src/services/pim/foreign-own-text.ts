import { PRIMARY_CONTENT_LOCALE } from './content-locale.js'

/**
 * A-32 (R-30) — a listing whose OWN text is the product's primary-language text, on a market that speaks another language.
 *
 * Found by Step 3.2's M3: 25 Amazon·DE listings (local copy) pin their own title (`followMasterTitle = false`) and that
 * title is the product's Italian name. A listing's own column records no language, so the content resolver trusts it as
 * the market's language and the publish sends Italian under `de_DE`. A FOLLOWING listing is not affected: the resolver
 * then reads the product's text per language and omits a language it does not have (R-LX-6).
 *
 * This names such a listing in the publish preview. It is a warning, not a refusal: which text is right — a German title,
 * or letting the listing follow the product — is the operator's choice (R-30: per listing, after the production count).
 */
type Text = { name?: string | null; description?: string | null; bulletPoints?: readonly string[] | null } | null | undefined
type OwnText = { title?: string | null; description?: string | null; bulletPointsOverride?: readonly string[] | null
  followMasterTitle?: boolean | null; followMasterDescription?: boolean | null; followMasterBulletPoints?: boolean | null } | null | undefined

const FIELDS = [
  { field: 'title', label: 'title', own: 'title', follows: 'followMasterTitle', source: 'name' },
  { field: 'description', label: 'description', own: 'description', follows: 'followMasterDescription', source: 'description' },
  { field: 'bulletPoints', label: 'bullet points', own: 'bulletPointsOverride', follows: 'followMasterBulletPoints', source: 'bulletPoints' },
] as const

const languageName = (code: string) => new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code
const same = (own: unknown, source: unknown) => Array.isArray(own)
  ? own.length > 0 && Array.isArray(source) && source.length === own.length && source.every((v, i) => v === own[i])
  : typeof own === 'string' && own.trim() !== '' && own === source

export function foreignOwnTextIssues(input: { channel: string; marketplace: string; marketLanguages: readonly string[]
  product: Text; parent?: Text; listing: OwnText; primary?: string }): Array<{ field: string; message: string }> {
  const primary = input.primary ?? PRIMARY_CONTENT_LOCALE
  const listing = input.listing
  if (!listing || !input.marketLanguages.length || input.marketLanguages.includes(primary)) return []
  const channel = input.channel.charAt(0) + input.channel.slice(1).toLowerCase()
  const spoken = input.marketLanguages.map(languageName).join(' / ')
  return FIELDS.flatMap(f => {
    // Following: the resolver reads the product per language and omits a missing one (R-LX-6) — nothing to name.
    if (listing[f.follows] !== false) return []
    const own = listing[f.own]
    if (![input.product?.[f.source], input.parent?.[f.source]].some(source => same(own, source))) return []
    return [{ field: f.field, message: `This ${channel} · ${input.marketplace} listing's own ${f.label} is the ${languageName(primary)} text, and it would go out as ${spoken}. Give it ${spoken} text, or let it follow the product.` }]
  })
}
