/**
 * /design/language-axis — frozen fixture. NOTHING here touches an API or a database.
 *
 * The family is shaped like GALE-JACKET (6 children, size × colour) and the markets are the ones
 * production holds today (docs/2026-09-11 audit, §6) plus Belgium's SECOND language, which the
 * current schema cannot represent and this design adds. Every text value is invented; every
 * STATE is one the design names, so the Owner can see each mark where it would appear.
 */

export interface Language {
  code: string
  label: string
  /** The catalogue's authoring language. Its column is the SOURCE every other language falls back to. */
  primary?: boolean
}

export const LANGUAGES: Language[] = [
  { code: 'it', label: 'Italian', primary: true },
  { code: 'de', label: 'German' },
  { code: 'fr', label: 'French' },
  { code: 'es', label: 'Spanish' },
  { code: 'en', label: 'English' },
  { code: 'nl', label: 'Dutch' },
]

export const languageLabel = (code: string) => LANGUAGES.find((l) => l.code === code)?.label ?? code.toUpperCase()

export interface Market {
  code: string
  label: string
  /** ONE market, ONE OR MORE languages — the axis today's `Marketplace.language` cannot express. */
  languages: string[]
  channels: string[]
}

export const MARKETS: Market[] = [
  { code: 'IT', label: 'Italy', languages: ['it'], channels: ['AMAZON', 'EBAY'] },
  { code: 'DE', label: 'Germany', languages: ['de'], channels: ['AMAZON', 'EBAY'] },
  { code: 'FR', label: 'France', languages: ['fr'], channels: ['AMAZON', 'EBAY'] },
  { code: 'ES', label: 'Spain', languages: ['es'], channels: ['AMAZON', 'EBAY'] },
  { code: 'BE', label: 'Belgium', languages: ['fr', 'nl'], channels: ['AMAZON'] },
  { code: 'NL', label: 'Netherlands', languages: ['nl'], channels: ['AMAZON'] },
  { code: 'UK', label: 'United Kingdom', languages: ['en'], channels: ['AMAZON', 'EBAY'] },
]

/**
 * What a language cell can be. `own` is a reviewed value in this language; the rest are the marks
 * the design names (§7.3 of the design doc). `outdated` is the ONE member the build adds to the
 * DS `CellProvenance` vocabulary; the others already exist.
 */
export type LangState = 'own' | 'inherited' | 'ai' | 'aiStale' | 'outdated'

export interface LangCell {
  value: string | null
  state: LangState
}

export type ContentField = 'title' | 'description' | 'bullet1' | 'keywords'
export const CONTENT_FIELDS: { key: ContentField; label: string; long?: boolean }[] = [
  { key: 'title', label: 'Title' },
  { key: 'description', label: 'Description', long: true },
  { key: 'bullet1', label: 'Bullet 1' },
  { key: 'keywords', label: 'Search keywords' },
]

export interface FamilyRow {
  id: string
  sku: string
  axes: string
  role: 'P' | 'C'
  content: Record<ContentField, Record<string, LangCell>>
}

const own = (value: string): LangCell => ({ value, state: 'own' })
const inherit = (): LangCell => ({ value: null, state: 'inherited' })
const ai = (value: string, stale = false): LangCell => ({ value, state: stale ? 'aiStale' : 'ai' })
const outdated = (value: string): LangCell => ({ value, state: 'outdated' })

const IT_TITLE = (size: string, colour: string) => `Giacca antivento GALE ${colour} — taglia ${size}`
const DE_TITLE = (size: string, colour: string) => `GALE Windjacke ${colour} — Größe ${size}`
const FR_TITLE = (size: string, colour: string) => `Veste coupe-vent GALE ${colour} — taille ${size}`
const NL_TITLE = (size: string, colour: string) => `GALE windjack ${colour} — maat ${size}`

const IT_DESC = 'Giacca leggera con membrana antivento, cappuccio regolabile e tasche con zip. Lavabile in lavatrice a 30°.'
const DE_DESC = 'Leichte Jacke mit winddichter Membran, verstellbarer Kapuze und Reißverschlusstaschen. Maschinenwäsche bei 30°.'
const FR_DESC = 'Veste légère à membrane coupe-vent, capuche réglable et poches zippées. Lavable en machine à 30°.'

const IT_B1 = 'MEMBRANA ANTIVENTO — blocca il vento senza rinunciare alla traspirabilità'
const DE_B1 = 'WINDDICHTE MEMBRAN — hält den Wind ab, bleibt atmungsaktiv'
const FR_B1 = 'MEMBRANE COUPE-VENT — bloque le vent sans sacrifier la respirabilité'

const IT_KW = 'giacca antivento, giacca leggera, giacca running'
const DE_KW = 'windjacke, leichte jacke, laufjacke'

interface Variant { id: string; size: string; colourIt: string; colourDe: string; colourFr: string; colourNl: string; skuColour: string }
const VARIANTS: Variant[] = [
  { id: 'v1', size: 'M', colourIt: 'nera', colourDe: 'Schwarz', colourFr: 'noire', colourNl: 'zwart', skuColour: 'BLK' },
  { id: 'v2', size: 'L', colourIt: 'nera', colourDe: 'Schwarz', colourFr: 'noire', colourNl: 'zwart', skuColour: 'BLK' },
  { id: 'v3', size: 'XL', colourIt: 'nera', colourDe: 'Schwarz', colourFr: 'noire', colourNl: 'zwart', skuColour: 'BLK' },
  { id: 'v4', size: 'M', colourIt: 'blu navy', colourDe: 'Marineblau', colourFr: 'bleu marine', colourNl: 'marineblauw', skuColour: 'NVY' },
  { id: 'v5', size: 'L', colourIt: 'blu navy', colourDe: 'Marineblau', colourFr: 'bleu marine', colourNl: 'marineblauw', skuColour: 'NVY' },
  { id: 'v6', size: 'XL', colourIt: 'blu navy', colourDe: 'Marineblau', colourFr: 'bleu marine', colourNl: 'marineblauw', skuColour: 'NVY' },
]

/** The master family in the LANGUAGES view: one row per variation, every field × every language. */
export const FAMILY: FamilyRow[] = VARIANTS.map((v, i) => {
  const de: Record<ContentField, LangCell> = {
    title: i === 2 ? ai(DE_TITLE(v.size, v.colourDe)) : i === 4 ? outdated(DE_TITLE(v.size, v.colourDe)) : own(DE_TITLE(v.size, v.colourDe)),
    description: i === 5 ? ai(DE_DESC, true) : i === 1 ? inherit() : own(DE_DESC),
    bullet1: i >= 3 ? inherit() : own(DE_B1),
    keywords: i === 0 ? own(DE_KW) : inherit(),
  }
  const fr: Record<ContentField, LangCell> = {
    title: i < 2 ? own(FR_TITLE(v.size, v.colourFr)) : i === 3 ? ai(FR_TITLE(v.size, v.colourFr)) : inherit(),
    description: i === 0 ? own(FR_DESC) : inherit(),
    bullet1: i === 0 ? own(FR_B1) : inherit(),
    keywords: inherit(),
  }
  const nl: Record<ContentField, LangCell> = {
    title: i === 0 ? own(NL_TITLE(v.size, v.colourNl)) : inherit(),
    description: inherit(),
    bullet1: inherit(),
    keywords: inherit(),
  }
  const empty: Record<ContentField, LangCell> = { title: inherit(), description: inherit(), bullet1: inherit(), keywords: inherit() }
  return {
    id: v.id,
    sku: `GALE-JACKET-${v.size}-${v.skuColour}`,
    axes: `${v.size} · ${v.colourIt.charAt(0).toUpperCase() + v.colourIt.slice(1)}`,
    role: 'C',
    content: {
      title: { it: own(IT_TITLE(v.size, v.colourIt)), de: de.title, fr: fr.title, nl: nl.title, es: empty.title, en: empty.title },
      description: { it: own(IT_DESC), de: de.description, fr: fr.description, nl: nl.description, es: empty.description, en: empty.description },
      bullet1: { it: own(IT_B1), de: de.bullet1, fr: fr.bullet1, nl: nl.bullet1, es: empty.bullet1, en: empty.bullet1 },
      keywords: { it: own(IT_KW), de: de.keywords, fr: fr.keywords, nl: nl.keywords, es: empty.keywords, en: empty.keywords },
    },
  }
})

/** The same family read on Amazon · BE · nl: the channel resolves THROUGH the Dutch shared text. */
export type ChannelState = 'inheritedLanguage' | 'inheritedSource' | 'pinned' | 'mapped'
export interface ChannelCell { value: string; state: ChannelState }
export interface ChannelRow { id: string; sku: string; axes: string; listingId: string; title: ChannelCell; description: ChannelCell; bullet1: ChannelCell }

export const CHANNEL_BE_NL: ChannelRow[] = VARIANTS.map((v, i) => ({
  id: v.id,
  sku: `GALE-JACKET-${v.size}-${v.skuColour}`,
  axes: `${v.size} · ${v.colourIt.charAt(0).toUpperCase() + v.colourIt.slice(1)}`,
  listingId: `B0${(7 + i).toString().padStart(2, '0')}GALE${v.skuColour}${v.size}`,
  title: i === 0
    ? { value: NL_TITLE(v.size, v.colourNl), state: 'inheritedLanguage' }
    : i === 3
      ? { value: `GALE windjack ${v.colourNl} ${v.size} — gratis verzending in België`, state: 'pinned' }
      : { value: IT_TITLE(v.size, v.colourIt), state: 'inheritedSource' },
  description: { value: IT_DESC, state: 'inheritedSource' },
  bullet1: i === 0 ? { value: 'WINDDICHT MEMBRAAN — houdt de wind buiten, blijft ademend', state: 'mapped' } : { value: IT_B1, state: 'inheritedSource' },
}))

/** Readiness per coordinate × language — what the scope bar chip summarises and the matrix shows. */
export type ScopeState = 'live' | 'ready' | 'pending' | 'errors'
export interface ReadinessCell { pct: number; state: ScopeState; missing?: string[] }
export interface CoordinateReadiness { id: string; label: string; channel: string; market: string; byLanguage: Partial<Record<string, ReadinessCell>> }

export const READINESS: CoordinateReadiness[] = [
  { id: 'master', label: 'Shared product', channel: '', market: '', byLanguage: {
    it: { pct: 100, state: 'ready' }, de: { pct: 71, state: 'pending', missing: ['Bullet 1 (3)', 'Search keywords (5)'] },
    fr: { pct: 33, state: 'pending', missing: ['Title (2)', 'Description (5)', 'Bullet 1 (5)', 'Search keywords (6)'] },
    es: { pct: 0, state: 'errors', missing: ['Everything'] }, en: { pct: 0, state: 'errors', missing: ['Everything'] }, nl: { pct: 8, state: 'pending', missing: ['Title (5)', 'Description (6)', 'Bullet 1 (6)'] },
  } },
  { id: 'amazon-it', label: 'Amazon · IT', channel: 'AMAZON', market: 'IT', byLanguage: { it: { pct: 100, state: 'live' } } },
  { id: 'amazon-de', label: 'Amazon · DE', channel: 'AMAZON', market: 'DE', byLanguage: { de: { pct: 94, state: 'ready', missing: ['Search keywords (5)'] } } },
  { id: 'amazon-fr', label: 'Amazon · FR', channel: 'AMAZON', market: 'FR', byLanguage: { fr: { pct: 33, state: 'errors', missing: ['Title (4)', 'Description (5)', 'Bullet 1 (5)'] } } },
  { id: 'amazon-es', label: 'Amazon · ES', channel: 'AMAZON', market: 'ES', byLanguage: { es: { pct: 0, state: 'errors', missing: ['Everything'] } } },
  { id: 'amazon-be', label: 'Amazon · BE', channel: 'AMAZON', market: 'BE', byLanguage: {
    fr: { pct: 33, state: 'errors', missing: ['Title (4)', 'Description (5)', 'Bullet 1 (5)'] },
    nl: { pct: 8, state: 'errors', missing: ['Title (5)', 'Description (6)', 'Bullet 1 (5)'] },
  } },
  { id: 'ebay-it', label: 'eBay · IT', channel: 'EBAY', market: 'IT', byLanguage: { it: { pct: 100, state: 'live' } } },
  { id: 'ebay-de', label: 'eBay · DE', channel: 'EBAY', market: 'DE', byLanguage: { de: { pct: 100, state: 'ready' } } },
]

/** Compare pane targets for ONE cell — Title on GALE-JACKET-M-BLK. */
export interface CompareTarget { id: string; label: string; kind: 'source' | 'language' | 'coordinate'; value: string; note: string }
export const COMPARE_TITLE: CompareTarget[] = [
  { id: 'it', label: 'Italian · source', kind: 'source', value: IT_TITLE('M', 'nera'), note: 'The value every other language falls back to' },
  { id: 'de', label: 'German · shared', kind: 'language', value: DE_TITLE('M', 'Schwarz'), note: 'Reviewed 2026-09-08 · reaches Amazon · DE and eBay · DE' },
  { id: 'fr', label: 'French · shared', kind: 'language', value: FR_TITLE('M', 'noire'), note: 'Reviewed 2026-09-08 · reaches Amazon · FR, eBay · FR, Amazon · BE (fr)' },
  { id: 'nl', label: 'Dutch · shared', kind: 'language', value: NL_TITLE('M', 'zwart'), note: 'Reviewed 2026-09-10 · reaches Amazon · NL, Amazon · BE (nl)' },
  { id: 'amazon-de', label: 'Amazon · DE · de', kind: 'coordinate', value: DE_TITLE('M', 'Schwarz'), note: 'Inherits the shared German — no pin' },
  { id: 'amazon-be-nl', label: 'Amazon · BE · nl', kind: 'coordinate', value: NL_TITLE('M', 'zwart'), note: 'Inherits the shared Dutch — no pin' },
  { id: 'ebay-de', label: 'eBay · DE · de', kind: 'coordinate', value: 'GALE Windjacke Schwarz Gr. M — Versand aus Italien', note: 'Pinned on this listing 2026-09-09 (80-character cap)' },
]

/** The products grid at catalogue level: a language column selector, and a bulk verb with a preview. */
export interface CatalogueRow { id: string; sku: string; name: string; family: string; variations: number; titleIt: string; titleDe: LangCell; readinessDe: ReadinessCell }
export const CATALOGUE: CatalogueRow[] = [
  { id: 'p1', sku: 'GALE-JACKET', name: 'Giacca antivento GALE', family: 'Outerwear', variations: 6, titleIt: 'Giacca antivento GALE', titleDe: own('GALE Windjacke'), readinessDe: { pct: 71, state: 'pending' } },
  { id: 'p2', sku: 'MISANO-SUIT', name: 'Tuta in pelle MISANO', family: 'Suit', variations: 12, titleIt: 'Tuta in pelle MISANO', titleDe: ai('MISANO Lederkombi'), readinessDe: { pct: 40, state: 'pending' } },
  { id: 'p3', sku: 'XRACING-GLOVE', name: 'Guanti XRACING', family: 'Gloves', variations: 8, titleIt: 'Guanti XRACING', titleDe: inherit(), readinessDe: { pct: 0, state: 'errors' } },
  { id: 'p4', sku: 'STORM-PANTS', name: 'Pantaloni STORM', family: 'Pants', variations: 10, titleIt: 'Pantaloni STORM', titleDe: own('STORM Hose'), readinessDe: { pct: 100, state: 'ready' } },
  { id: 'p5', sku: 'COAST-COAT', name: 'Cappotto COAST', family: 'Coat', variations: 5, titleIt: 'Cappotto COAST', titleDe: outdated('COAST Mantel (Herbstkollektion 2025)'), readinessDe: { pct: 88, state: 'pending' } },
]
