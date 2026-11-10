import type { Issue } from '@nexus/factory-domain/core/errors'
import type { BrandingSetRow, BrandingSetView, PackagingRuleView, UpdateSetBody } from '@nexus/factory-domain/product/branding-sets/contracts'
import { normaliseSetCode, packagingRuleProblems, setProblems, storedRule, type PackagingPer } from '@nexus/factory-domain/product/branding-sets/rules'
import type { ColourCountsView, ColourLibraryRow, CreateColourBody, UpdateColourBody } from '@nexus/factory-domain/product/colours/contracts'
import { COLOUR_SYSTEMS, COLOUR_VIEWS, colourProblems, noticesOf, normaliseColour, normaliseHex, shownNotices, type ColourNotice, type ColourSystem, type ColourView } from '@nexus/factory-domain/product/colours/rules'

/**
 * Products › Colours & artwork (B-W2b-247; SCR-118; design products.colours), the pure rules of the page: what a person may
 * do, the list's address (its filters ARE the API's: `?view=&q=&system=&family=`, the branding sets' `?sets=`, the open set
 * `?open=<id>`, `?new=colour|set`), the words of a colour's reference and use, the colour form and the branding set draft
 * (what Save sends, what is held and why), the notices (factory-domain's order; a dismissal kept by value). Nothing here
 * renders or fetches.
 */

export type { ColourLibraryRow, BrandingSetRow, BrandingSetView, ColourCountsView, ColourNotice, ColourSystem, ColourView }
export { COLOUR_SYSTEMS, COLOUR_VIEWS }

export interface ColoursCan {
  /** product.styles.view: the page. */
  view: boolean
  /** product.colours.manage: add, change, archive colours. */
  colours: boolean
  /** product.branding.manage: start, change, archive branding sets. */
  branding: boolean
  /** product.materials.view: the material colour counts and the packaging rules' material picker. */
  materials: boolean
  /** files.upload: a colour's photo, a set's logos and artwork. */
  upload: boolean
}

export function coloursCan(permissions: readonly string[]): ColoursCan {
  const held = new Set(permissions)
  return {
    view: held.has('product.styles.view'),
    colours: held.has('product.colours.manage'),
    branding: held.has('product.branding.manage'),
    materials: held.has('product.materials.view'),
    upload: held.has('files.upload'),
  }
}

// ---- the address ------------------------------------------------------------------------------------------------------

export const SET_VIEWS = ['all', 'active', 'archived'] as const
export type SetView = (typeof SET_VIEWS)[number]

export interface ColourFilters {
  view: ColourView
  q: string
  /** A system code as the address has it (an unknown one is kept: the API names it as ignored). */
  system: string
  family: string
  sets: SetView
}

export const NO_FILTERS: ColourFilters = { view: 'active', q: '', system: '', family: '', sets: 'all' }

const viewOf = (value: string | null | undefined): ColourView => ((COLOUR_VIEWS as readonly string[]).includes(value ?? '') ? (value as ColourView) : 'active')
const setsOf = (value: string | null | undefined): SetView => ((SET_VIEWS as readonly string[]).includes(value ?? '') ? (value as SetView) : 'all')

export function filtersOf(params: { get(name: string): string | null } | null): ColourFilters {
  return {
    view: viewOf(params?.get('view')),
    q: params?.get('q') ?? '',
    system: params?.get('system') ?? '',
    family: params?.get('family') ?? '',
    sets: setsOf(params?.get('sets')),
  }
}

/** The page's address terms: the filters, the open branding set, a new colour or set. */
export function searchOf(filters: ColourFilters, extra: { open?: string | null; new?: 'colour' | 'set' | null } = {}): string {
  const search = new URLSearchParams()
  if (filters.view !== 'active') search.set('view', filters.view)
  if (filters.q.trim()) search.set('q', filters.q.trim())
  if (filters.system) search.set('system', filters.system)
  if (filters.family) search.set('family', filters.family)
  if (filters.sets !== 'all') search.set('sets', filters.sets)
  if (extra.open) search.set('open', extra.open)
  if (extra.new) search.set('new', extra.new)
  const text = search.toString()
  return text ? `?${text}` : ''
}

/** The colour list is filtered (a chip row and "No rows match" instead of "No colours yet"). */
export const isFiltered = (filters: ColourFilters): boolean => filters.view !== 'active' || filters.q.trim() !== '' || filters.system !== '' || filters.family !== ''

/** The API's own query of the list (pages of 50). */
export function listQuery(filters: ColourFilters, cursor: string | null): Record<string, string | number | undefined> {
  return { view: filters.view, q: filters.q.trim() || undefined, system: filters.system || undefined, family: filters.family || undefined, cursor: cursor ?? undefined, limit: 50 }
}

// ---- words of a row ----------------------------------------------------------------------------------------------------

/** "RAL 9005", "Pantone 18-1662 TCX", "Our own · NX-BLU" — the system's word comes from the catalogue. */
export function referenceWords(row: Pick<ColourLibraryRow, 'system' | 'reference'>, systemWord: (system: ColourSystem) => string): string | null {
  if (!row.system) return row.reference
  const word = systemWord(row.system)
  if (!row.reference) return word
  return row.reference.toUpperCase().startsWith(word.toUpperCase()) ? row.reference : `${word} ${row.reference}`
}

/** The names under the colour's own name, only those that differ ("it Nero · en Black"). */
export function otherNames(row: Pick<ColourLibraryRow, 'name' | 'names'>): Array<{ locale: 'it' | 'en'; name: string }> {
  return (['it', 'en'] as const).flatMap((locale) => {
    const name = row.names[locale]
    return name && name !== row.name ? [{ locale, name }] : []
  })
}

/** Archive N is held when nothing selected is in use or the person may not; Restore N likewise. Keys of this catalogue. */
export function archiveHeldKey(rows: readonly ColourLibraryRow[], can: ColoursCan): string | null {
  if (!can.colours) return 'held.noColours'
  if (!rows.some((row) => row.status === 'ACTIVE')) return 'held.noneActive'
  return null
}
export function restoreHeldKey(rows: readonly ColourLibraryRow[], can: ColoursCan): string | null {
  if (!can.colours) return 'held.noColours'
  if (!rows.some((row) => row.status === 'ARCHIVED')) return 'held.noneArchived'
  return null
}

/** What archiving the chosen colours reaches: how many are named by colourways, material colours or brand sets. */
export function archiveReach(rows: readonly ColourLibraryRow[]): { archive: number; inUse: number } {
  const active = rows.filter((row) => row.status === 'ACTIVE')
  return { archive: active.length, inUse: active.filter((row) => row.use.inUse).length }
}

// ---- the colour form --------------------------------------------------------------------------------------------------

export interface ColourDraft {
  /** '' = every company (a colour of the tenant's library). */
  companyId: string
  code: string
  name: string
  it: string
  en: string
  system: ColourSystem | ''
  reference: string
  family: string
  hex: string
}

export function colourDraftOf(row: ColourLibraryRow | null, companyId: string | null): ColourDraft {
  if (!row) return { companyId: companyId ?? '', code: '', name: '', it: '', en: '', system: '', reference: '', family: '', hex: '' }
  return { companyId: row.companyId ?? '', code: row.code, name: row.name, it: row.names.it ?? '', en: row.names.en ?? '', system: row.system ?? '', reference: row.reference ?? '', family: row.family ?? '', hex: row.hex ?? '' }
}

const fieldsOf = (draft: ColourDraft) =>
  normaliseColour({ code: draft.code, name: draft.name, names: { it: draft.it, en: draft.en }, system: draft.system || null, reference: draft.reference, family: draft.family, hex: draft.hex })

/** The draft's problems as factory-domain says them (paths without `body/`: `code`, `names/en`, `reference`). */
export const colourDraftProblems = (draft: ColourDraft): Issue[] => colourProblems(fieldsOf(draft), '')

/** The swatch a typed hex draws ("#abc" → "#AABBCC"), or null. */
export const typedHex = (text: string): string | null => normaliseHex(text) ?? null

export function createBodyOf(draft: ColourDraft): CreateColourBody {
  const fields = fieldsOf(draft)
  return {
    companyId: draft.companyId || null,
    code: fields.code,
    name: fields.name,
    names: { it: fields.names.it ?? null, en: fields.names.en ?? null },
    system: fields.system,
    reference: fields.reference,
    family: fields.family,
    hex: fields.hex ?? null,
  }
}

/** Only what changed, at the row's version (null when nothing did). */
export function updateBodyOf(row: ColourLibraryRow, draft: ColourDraft): UpdateColourBody | null {
  const fields = fieldsOf(draft)
  const body: UpdateColourBody = { version: row.version }
  if (fields.name !== row.name) body.name = fields.name
  if ((fields.names.it ?? null) !== (row.names.it ?? null) || (fields.names.en ?? null) !== (row.names.en ?? null)) body.names = { it: fields.names.it ?? null, en: fields.names.en ?? null }
  if (fields.system !== row.system) body.system = fields.system
  if (fields.reference !== row.reference) body.reference = fields.reference
  if (fields.family !== row.family) body.family = fields.family
  if ((fields.hex ?? null) !== row.hex) body.hex = fields.hex ?? null
  return Object.keys(body).length > 1 ? body : null
}

// ---- the branding set draft -------------------------------------------------------------------------------------------

export interface RuleDraft {
  key: string
  text: string
  /** '' = a rule in words only. */
  itemId: string
  quantity: string
  per: PackagingPer | ''
}

export interface SetDraft {
  name: string
  note: string
  colourIds: string[]
  rules: RuleDraft[]
  logoIds: string[]
  artworkIds: string[]
}

const ruleDraftOf = (rule: PackagingRuleView): RuleDraft => ({ key: rule.key, text: rule.text, itemId: rule.item?.id ?? '', quantity: rule.quantity ?? '', per: rule.per ?? '' })

export function setDraftOf(set: BrandingSetView): SetDraft {
  return {
    name: set.name,
    note: set.note ?? '',
    colourIds: set.colours.map((colour) => colour.id),
    rules: set.packagingRules.map(ruleDraftOf),
    logoIds: set.files.filter((file) => file.role === 'LOGO').map((file) => file.fileId),
    artworkIds: set.files.filter((file) => file.role === 'ARTWORK').map((file) => file.fileId),
  }
}

export const emptyRule = (): RuleDraft => ({ key: '', text: '', itemId: '', quantity: '', per: '' })

const storedRules = (rules: readonly RuleDraft[]) => rules.map((rule) => storedRule({ key: rule.key, text: rule.text, itemId: rule.itemId || null, quantity: rule.quantity, per: rule.per || null }))
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** What Save sends: the changed parts only, at the set's version; null when nothing changed. */
export function setChangesOf(set: BrandingSetView, draft: SetDraft): UpdateSetBody | null {
  const before = setDraftOf(set)
  const body: UpdateSetBody = { version: set.version }
  if (draft.name.trim() !== set.name) body.name = draft.name.trim()
  if ((draft.note.trim() || null) !== (set.note ?? null)) body.note = draft.note.trim() || null
  if (!same(draft.colourIds, before.colourIds)) body.brandColourIds = [...draft.colourIds]
  if (!same(storedRules(draft.rules), storedRules(before.rules))) {
    body.packagingRules = draft.rules.map((rule) => ({ key: rule.key, text: rule.text, itemId: rule.itemId || null, quantity: rule.quantity.trim() || null, per: rule.per || null }))
  }
  if (!same(draft.logoIds, before.logoIds)) body.logoFileIds = [...draft.logoIds]
  if (!same(draft.artworkIds, before.artworkIds)) body.labelArtworkFileIds = [...draft.artworkIds]
  return Object.keys(body).length > 1 ? body : null
}

/** How many parts the draft changes (the EditModeBar's count). */
export const setChangeCount = (set: BrandingSetView, draft: SetDraft): number => {
  const body = setChangesOf(set, draft)
  return body ? Object.keys(body).length - 1 : 0
}

/** The draft's problems as factory-domain says them (paths `name`, `note`, `packagingRules/<i>/<field>`). */
export function setDraftProblems(set: BrandingSetView, draft: SetDraft): Issue[] {
  return [...setProblems({ code: set.code, name: draft.name.trim(), note: draft.note.trim() || null }, ''), ...packagingRuleProblems(storedRules(draft.rules), 'packagingRules')]
}

/** A file moved one place earlier (-1) or later (+1) in its list; the ends stay. */
export function moved(list: readonly string[], id: string, by: -1 | 1): string[] {
  const index = list.indexOf(id)
  const target = index + by
  if (index < 0 || target < 0 || target >= list.length) return [...list]
  const next = [...list]
  next.splice(index, 1)
  next.splice(target, 0, id)
  return next
}

// ---- a new branding set -----------------------------------------------------------------------------------------------

export interface BrandChoice {
  id: string
  code: string
  name: string
  /** The sets it has in use (per company). */
  active: Array<{ id: string; code: string; name: string; companyId: string }>
}

export interface NewSetDraft {
  brand: BrandChoice | null
  code: string
  name: string
  /** The brand's set in use in this company is archived in the same command. */
  replace: boolean
}

/** The brand's set in use in the company the new one is for (it is replaced, or the new one is held). */
export const activeIn = (brand: BrandChoice | null, companyId: string | null): BrandChoice['active'][number] | null => brand?.active.find((set) => set.companyId === companyId) ?? null

/** A code suggested from the brand and the year ("BS-SEED-C2-2027"); the person may change it. */
export const suggestedCode = (brand: Pick<BrandChoice, 'code'>, year: number): string => normaliseSetCode(`BS-${brand.code}-${year}`).slice(0, 60)

/** Why Create is held (a key of this catalogue), or null. */
export function newSetHeldKey(draft: NewSetDraft, companyId: string | null): string | null {
  if (!draft.brand) return 'newSet.held.brand'
  if (!companyId) return 'newSet.held.company'
  if (setProblems({ code: normaliseSetCode(draft.code), name: draft.name.trim(), note: null }, '').length > 0) return 'newSet.held.fields'
  if (activeIn(draft.brand, companyId) && !draft.replace) return 'newSet.held.replace'
  return null
}

// ---- notices (design sec:colours.notices) ------------------------------------------------------------------------------

/** The page's notices still to show, the most serious first (factory-domain's order). */
export function pageNotices(ignored: readonly string[], counts: ColourCountsView | null, dismissed: ReadonlySet<string>): ColourNotice[] {
  return shownNotices(noticesOf({ ignored, brandsWithoutSet: counts?.brandsWithoutSet.count ?? 0, noHex: counts?.noHex ?? 0 }), dismissed)
}

/** Where the dismissed notices are kept on this device (by value: a new value shows again). */
export const DISMISSED_STORE = 'factory:products.colours:dismissed'

/** A row's tone for its status pill. */
export const STATUS_TONE = { ACTIVE: 'success', ARCHIVED: 'neutral' } as const

/** The colours shown in a set's row (the rest counted). */
export const SWATCHES_SHOWN = 5

/** The address an <img> draws a library picture at: the API's own path through this app's /api (design cases: inline data). */
export function pictureAddress(url: string | null | undefined): string | null {
  if (!url) return null
  if (url.startsWith('data:image/')) return url
  return url.startsWith('/') && !url.startsWith('//') ? `/api${url}` : null
}
