import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { packagingRulesOf } from '@nexus/factory-domain/compliance/label-artwork/rules'
import type { BrandingFileView, BrandingSetRow, BrandingSetView, BrandColourView, PackagingRuleView } from '@nexus/factory-domain/product/branding-sets/contracts'
import { PRODUCT_BRANDING_MANAGE } from '@nexus/factory-domain/product/branding-sets/permissions'
import { isDrawnPicture, type BrandingFileRole } from '@nexus/factory-domain/product/branding-sets/rules'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { SET_SCOPE } from '../colours/store'
import { contextOf, STYLE_SCOPE } from '../styles/store'

/**
 * The branding sets, the shared parts (B-W2b-247; PRD-045): the row, its files (pictures drawn from the API's own address),
 * colours, packaging rules and the styles that read it — the brand's styles of the set's company (and the styles of every
 * company), as B-W2b-259's label lines and B-W2b-230's tech pack read the brand's ACTIVE set.
 */

type Reader = FactoryClient | CommandTx

export const SET_COLUMNS = {
  id: true,
  companyId: true,
  partyId: true,
  code: true,
  name: true,
  logoFileIds: true,
  labelArtworkFileIds: true,
  brandColourIds: true,
  packagingRules: true,
  note: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.BrandingSetSelect
export type SetRowData = Prisma.BrandingSetGetPayload<{ select: typeof SET_COLUMNS }>

const FILE_COLUMNS = { id: true, recordType: true, recordId: true, kind: true, status: true, contentType: true, originalName: true } as const satisfies Prisma.StoredFileSelect
type FileRow = Prisma.StoredFileGetPayload<{ select: typeof FILE_COLUMNS }>

/** The most styles a set's detail lists (the count says all). */
const STYLES_SHOWN = 50

export function fileViewOf(file: FileRow, role: BrandingFileRole): BrandingFileView {
  const picture = isDrawnPicture(file.contentType)
  const available = file.status === 'AVAILABLE'
  return { fileId: file.id, role, name: file.originalName, contentType: file.contentType, kind: file.kind, picture, available, url: picture && available ? `/product/colours/pictures/${file.id}` : null }
}

const partyName = (party: { legalName: string; tradeName: string | null }): string => party.tradeName ?? party.legalName

/** The brand's styles a set is read for: of its company or of every company, not archived, the caller sees. */
const linkedStylesWhere = (actor: Actor, set: Pick<SetRowData, 'companyId' | 'partyId'>): Prisma.StyleWhereInput => ({
  AND: [scopeWhere(actor, PRODUCT_STYLES_VIEW, STYLE_SCOPE) as Prisma.StyleWhereInput, { brandPartyId: set.partyId, status: { not: 'ARCHIVED' }, OR: [{ companyId: set.companyId }, { companyId: null }] }],
})

interface Lookups {
  readonly parties: Map<string, { id: string; code: string; name: string }>
  readonly files: Map<string, FileRow>
  readonly colours: Map<string, BrandColourView>
  readonly styles: Map<string, number>
}

async function lookupsOf(db: Reader, actor: Actor, sets: readonly SetRowData[], fileIds: readonly string[]): Promise<Lookups> {
  const partyIds = [...new Set(sets.map((set) => set.partyId))]
  const colourIds = [...new Set(sets.flatMap((set) => set.brandColourIds))]
  const [parties, files, colours, styles] = await Promise.all([
    partyIds.length === 0 ? [] : db.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, code: true, legalName: true, tradeName: true } }),
    fileIds.length === 0 ? [] : db.storedFile.findMany({ where: { id: { in: [...new Set(fileIds)] } }, select: FILE_COLUMNS }),
    colourIds.length === 0 ? [] : db.colour.findMany({ where: { id: { in: colourIds } }, select: { id: true, code: true, name: true, hex: true, status: true } }),
    Promise.all(sets.map(async (set) => [set.id, set.status === 'ACTIVE' ? await db.style.count({ where: linkedStylesWhere(actor, set) }) : -1] as const)),
  ])
  return {
    parties: new Map(parties.map((party) => [party.id, { id: party.id, code: party.code, name: partyName(party) }])),
    files: new Map(files.map((file) => [file.id, file])),
    colours: new Map(colours.map((colour) => [colour.id, colour])),
    styles: new Map(styles),
  }
}

function rowOf(set: SetRowData, lookups: Lookups): BrandingSetRow {
  const firstLogo = set.logoFileIds.map((fileId) => lookups.files.get(fileId)).find((file): file is FileRow => file !== undefined)
  const linked = lookups.styles.get(set.id) ?? -1
  return {
    id: set.id,
    companyId: set.companyId,
    party: lookups.parties.get(set.partyId) ?? { id: set.partyId, code: '—', name: '—' },
    code: set.code,
    name: set.name,
    logos: set.logoFileIds.length,
    artwork: set.labelArtworkFileIds.length,
    logo: firstLogo ? fileViewOf(firstLogo, 'LOGO') : null,
    colours: set.brandColourIds.flatMap((colourId) => {
      const colour = lookups.colours.get(colourId)
      return colour ? [colour] : []
    }),
    rules: packagingRulesOf(set.packagingRules).length,
    stylesLinked: linked < 0 ? null : linked,
    status: set.status,
    version: set.version,
    updatedAt: toUtcIso(set.updatedAt),
  }
}

/** The list's rows (only the first logo's file is read per set). */
export async function rowsOf(db: Reader, actor: Actor, sets: readonly SetRowData[]): Promise<BrandingSetRow[]> {
  const lookups = await lookupsOf(db, actor, sets, sets.flatMap((set) => set.logoFileIds.slice(0, 1)))
  return sets.map((set) => rowOf(set, lookups))
}

/** One set whole: its files, rules with their materials, the styles that read it, the brand's other set in use. */
export async function viewOf(db: Reader, actor: Actor, set: SetRowData): Promise<BrandingSetView> {
  const lookups = await lookupsOf(db, actor, [set], [...set.logoFileIds, ...set.labelArtworkFileIds])
  const rules = packagingRulesOf(set.packagingRules)
  const itemIds = [...new Set(rules.flatMap((rule) => (rule.itemId ? [rule.itemId] : [])))]
  const [items, styles, other] = await Promise.all([
    itemIds.length === 0 ? [] : db.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, code: true, name: true, status: true } }),
    db.style.findMany({ where: linkedStylesWhere(actor, set), select: { id: true, code: true, name: true, status: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }], take: STYLES_SHOWN + 1 }),
    set.status === 'ARCHIVED' ? db.brandingSet.findFirst({ where: { companyId: set.companyId, partyId: set.partyId, status: 'ACTIVE' }, select: { id: true, code: true, name: true } }) : null,
  ])
  const itemOf = new Map(items.map((item) => [item.id, item]))
  const files = [
    ...set.logoFileIds.map((fileId) => [fileId, 'LOGO'] as const),
    ...set.labelArtworkFileIds.map((fileId) => [fileId, 'ARTWORK'] as const),
  ].flatMap(([fileId, role]) => {
    const file = lookups.files.get(fileId)
    return file ? [fileViewOf(file, role)] : []
  })
  const packagingRules: PackagingRuleView[] = rules.map((rule) => {
    const item = rule.itemId ? itemOf.get(rule.itemId) : undefined
    return { key: rule.key, text: rule.text, item: item ?? null, quantity: rule.quantity ?? null, per: rule.per ?? null }
  })
  // An archived set is read for no style (null); its styles list still names the brand's styles it would be read for again.
  const linked = set.status === 'ACTIVE' ? lookups.styles.get(set.id) ?? 0 : null
  return {
    ...rowOf(set, lookups),
    stylesLinked: linked,
    files,
    packagingRules,
    note: set.note,
    styles: styles.slice(0, STYLES_SHOWN),
    stylesMore: styles.length > STYLES_SHOWN,
    activeOther: other,
    createdAt: toUtcIso(set.createdAt),
  }
}

/** A set the caller may see (product.styles.view over its company and brand); else not found. */
export async function readSet(caller: CommandCaller, setId: string): Promise<SetRowData> {
  if (!isUuid(setId)) throw new NotFoundError('Branding set not found.')
  const row = await caller.withClient((client) => client.brandingSet.findUnique({ where: { id: setId }, select: SET_COLUMNS }))
  if (!row || !can(actorOf(contextOf(caller)), PRODUCT_STYLES_VIEW, { companyId: row.companyId, partyId: row.partyId })) throw new NotFoundError('Branding set not found.')
  return row
}

/** product.branding.manage over the set's company and brand. */
export function assertMayKeep(caller: CommandCaller, companyId: string, partyId: string): void {
  if (!can(actorOf(contextOf(caller)), PRODUCT_BRANDING_MANAGE, { companyId, partyId })) throw new ForbiddenError()
}

/** The where of the sets the actor sees. */
export const setsWhere = (actor: Actor): Prisma.BrandingSetWhereInput => scopeWhere(actor, PRODUCT_STYLES_VIEW, SET_SCOPE) as Prisma.BrandingSetWhereInput
