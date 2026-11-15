import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { searchWords, storedVatNumbers } from '@nexus/factory-domain/imports/duplicates/match'
import {
  byLikelihood,
  DUPLICATE_LIMITS,
  likelihoodOf,
  materialKeys,
  materialReasons,
  partyKeys,
  partyReasons,
  type DuplicateRecordType,
  type Likelihood,
  type MaterialKeys,
  type MaterialProbe,
  type PartyKeys,
  type PartyProbe,
  type ReasonFound,
} from '@nexus/factory-domain/imports/duplicates/rules'
import { PARTIES_VIEW } from '@nexus/factory-domain/parties/permissions'
import { PRODUCT_MATERIALS_VIEW } from '@nexus/factory-domain/product/materials/permissions'
import type { CommandTx } from '../../../core/command'
import { PARTY_SCOPE } from '../../../modules/parties/store'
import { MATERIAL_SCOPE } from '../../../modules/product/materials/store'

/**
 * Finding likely duplicates (B-W2b-427): the records the caller may see (parties.view, product.materials.view, through
 * scopeWhere), each with the keys of factory-domain imports/duplicates, and the ones that look like a probe — a draft on
 * create, a sheet row, or every other record (the list of possible duplicates). Records are grouped by their keys
 * ("blocks": a VAT number, an e-mail domain, a name, the first letters of a name's words, a code) so only records that
 * share one are compared. Read only.
 */

type Reader = Pick<FactoryClient | CommandTx, 'party' | 'item'>

export interface Candidate {
  readonly recordType: DuplicateRecordType
  readonly id: string
  readonly code: string
  readonly name: string
  readonly status: string
  readonly companyId: string | null
  readonly roles: readonly string[]
  readonly kind: string | null
  readonly createdAt: string
  readonly likelihood: Likelihood
  readonly reasons: readonly ReasonFound[]
}

/** A record as compared: what the screen shows of it, and its keys. */
interface Indexed<Keys> {
  readonly view: Omit<Candidate, 'likelihood' | 'reasons'>
  readonly keys: Keys
}

/** Blocks bigger than this are not paired by (a word every second supplier has says nothing). */
const BLOCK_MAX = 60
/** A word is grouped by its first letters: "pelletteria" and "pelletterie" meet in "pellet". */
const prefixOf = (word: string): string => word.slice(0, 6)

class Index<Keys> {
  readonly #rows: Indexed<Keys>[] = []
  readonly #blocks = new Map<string, number[]>()

  constructor(
    rows: readonly Indexed<Keys>[],
    private readonly blocksOf: (keys: Keys) => readonly string[],
    private readonly reasonsOf: (a: Keys, b: Keys) => ReasonFound[],
  ) {
    for (const row of rows) {
      const at = this.#rows.push(row) - 1
      for (const block of new Set(blocksOf(row.keys))) this.#blocks.set(block, [...(this.#blocks.get(block) ?? []), at])
    }
  }

  get size(): number {
    return this.#rows.length
  }

  /** The records sharing a block with these keys, judged, the likeliest first. */
  candidatesFor(keys: Keys, except: ReadonlySet<string>, limit: number = DUPLICATE_LIMITS.candidates): Candidate[] {
    const seen = new Set<number>()
    for (const block of new Set(this.blocksOf(keys))) {
      const members = this.#blocks.get(block) ?? []
      if (members.length > BLOCK_MAX && block.startsWith('t:')) continue
      for (const at of members) seen.add(at)
    }
    const found: Candidate[] = []
    for (const at of seen) {
      const row = this.#rows[at]!
      if (except.has(row.view.id)) continue
      const reasons = this.reasonsOf(keys, row.keys)
      if (reasons.length > 0) found.push({ ...row.view, likelihood: likelihoodOf(reasons), reasons })
    }
    return found.sort(byLikelihood).slice(0, limit)
  }

  /** Every pair of records that look alike, the likeliest first: the older record is `a`. */
  pairs(limit: number): { pairs: { a: Indexed<Keys>['view']; b: Indexed<Keys>['view']; likelihood: Likelihood; reasons: ReasonFound[] }[]; more: boolean } {
    const judged = new Set<string>()
    const found: { a: Indexed<Keys>['view']; b: Indexed<Keys>['view']; likelihood: Likelihood; reasons: ReasonFound[]; code: string }[] = []
    for (const [block, members] of this.#blocks) {
      if (members.length < 2 || (members.length > BLOCK_MAX && block.startsWith('t:'))) continue
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          const one = this.#rows[members[i]!]!
          const two = this.#rows[members[j]!]!
          const [a, b] = one.view.createdAt < two.view.createdAt || (one.view.createdAt === two.view.createdAt && one.view.id < two.view.id) ? [one, two] : [two, one]
          const key = `${a.view.id}:${b.view.id}`
          if (judged.has(key)) continue
          judged.add(key)
          const reasons = this.reasonsOf(a.keys, b.keys)
          if (reasons.length > 0) found.push({ a: a.view, b: b.view, likelihood: likelihoodOf(reasons), reasons, code: `${a.view.code} ${b.view.code}` })
        }
      }
    }
    found.sort(byLikelihood)
    return { pairs: found.slice(0, limit).map(({ code: _code, ...pair }) => pair), more: found.length > limit }
  }
}

// ---- parties -----------------------------------------------------------------------------------------------------------

const PARTY_SELECT = {
  id: true,
  code: true,
  legalName: true,
  tradeName: true,
  status: true,
  roles: true,
  companyId: true,
  website: true,
  createdAt: true,
  taxIdentities: { select: { vatNumber: true, fiscalCode: true } },
  // The domains only: never shown, never sent.
  contacts: { where: { erasedAt: null }, select: { email: true } },
} as const satisfies Prisma.PartySelect
type PartyData = Prisma.PartyGetPayload<{ select: typeof PARTY_SELECT }>

const partyIndexed = (row: PartyData): Indexed<PartyKeys> => ({
  view: { recordType: 'PARTY', id: row.id, code: row.code, name: row.tradeName ?? row.legalName, status: row.status, companyId: row.companyId, roles: [...row.roles], kind: null, createdAt: toUtcIso(row.createdAt) },
  keys: partyKeys({
    legalName: row.legalName,
    tradeName: row.tradeName,
    vatNumbers: row.taxIdentities.map((identity) => identity.vatNumber),
    fiscalCodes: row.taxIdentities.map((identity) => identity.fiscalCode),
    emails: row.contacts.map((contact) => contact.email),
    website: row.website,
  }),
})

const partyBlocks = (keys: PartyKeys): string[] => [
  ...keys.vat.map((value) => `v:${value}`),
  ...keys.fiscal.map((value) => `f:${value}`),
  ...keys.domains.map((value) => `d:${value}`),
  ...keys.domains.map((value) => `w:${value}`),
  ...(keys.website ? [`w:${keys.website}`, `d:${keys.website}`] : []),
  ...keys.names.map((value) => `n:${value.replace(/ /g, '')}`),
  ...keys.names.flatMap((value) => value.split(' ').filter((word) => word.length >= 4).map((word) => `t:${prefixOf(word)}`)),
]

const partyVisible = (actor: Actor): Prisma.PartyWhereInput => scopeWhere(actor, PARTIES_VIEW, PARTY_SCOPE) as Prisma.PartyWhereInput

/** What narrows the parties a probe may look like, in the database (the index judges them). */
function partyProbeWhere(probe: PartyProbe, keys: PartyKeys, country: string | null | undefined): Prisma.PartyWhereInput[] {
  const or: Prisma.PartyWhereInput[] = []
  if (keys.vat.length > 0) or.push({ taxIdentities: { some: { vatNumber: { in: storedVatNumbers(keys.vat, country) } } } })
  if (keys.fiscal.length > 0) or.push({ taxIdentities: { some: { fiscalCode: { in: [...keys.fiscal] } } } })
  for (const domain of [...keys.domains, ...(keys.website ? [keys.website] : [])]) {
    or.push({ contacts: { some: { email: { endsWith: `@${domain}`, mode: 'insensitive' } } } }, { website: { contains: domain, mode: 'insensitive' } })
  }
  const words = [...new Set([...searchWords(probe.legalName), ...searchWords(probe.tradeName)].map(prefixOf))].slice(0, DUPLICATE_LIMITS.nameWords)
  for (const word of words) or.push({ legalName: { contains: word, mode: 'insensitive' } }, { tradeName: { contains: word, mode: 'insensitive' } })
  return or
}

/** The parties that look like a probe (a draft, a sheet row), the likeliest first; `except`: records left out. */
export async function partyCandidates(client: Reader, actor: Actor, probe: PartyProbe & { readonly country?: string | null | undefined }, except: ReadonlySet<string> = new Set()): Promise<Candidate[]> {
  const keys = partyKeys(probe)
  const or = partyProbeWhere(probe, keys, probe.country)
  if (or.length === 0) return []
  const rows = await client.party.findMany({ where: { AND: [partyVisible(actor), { OR: or }] }, select: PARTY_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 400 })
  return new Index(rows.map(partyIndexed), partyBlocks, partyReasons).candidatesFor(keys, except)
}

/** Every party the caller may see (archived ones only when asked), indexed for many probes or for pairs. */
export async function partyIndex(client: Reader, actor: Actor, options: { readonly archived: boolean; readonly companyId?: string | undefined }): Promise<Index<PartyKeys>> {
  const rows = await client.party.findMany({
    where: {
      AND: [partyVisible(actor), options.archived ? {} : { status: { not: 'ARCHIVED' } }, options.companyId ? { OR: [{ companyId: options.companyId }, { companyId: null }] } : {}],
    },
    select: PARTY_SELECT,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  return new Index(rows.map(partyIndexed), partyBlocks, partyReasons)
}

// ---- materials ---------------------------------------------------------------------------------------------------------

const MATERIAL_SELECT = {
  id: true,
  code: true,
  name: true,
  kind: true,
  status: true,
  companyId: true,
  defaultSupplierId: true,
  supplierArticleCode: true,
  createdAt: true,
} as const satisfies Prisma.ItemSelect
type MaterialData = Prisma.ItemGetPayload<{ select: typeof MATERIAL_SELECT }>

const materialIndexed = (row: MaterialData): Indexed<MaterialKeys> => ({
  view: { recordType: 'MATERIAL', id: row.id, code: row.code, name: row.name, status: row.status, companyId: row.companyId, roles: [], kind: row.kind, createdAt: toUtcIso(row.createdAt) },
  keys: materialKeys({ code: row.code, name: row.name, supplierId: row.defaultSupplierId, supplierArticleCode: row.supplierArticleCode }),
})

const materialBlocks = (keys: MaterialKeys): string[] => [
  ...(keys.code ? [`c:${keys.code}`] : []),
  ...(keys.article.length >= 3 ? [`a:${keys.article}`] : []),
  ...(keys.name ? [`n:${keys.name.replace(/ /g, '')}`] : []),
  ...(keys.name ? keys.name.split(' ').filter((word) => word.length >= 4).map((word) => `t:${prefixOf(word)}`) : []),
]

// Every material record: the finished items of styles (kind FINISHED) are not the material library's.
const materialVisible = (actor: Actor): Prisma.ItemWhereInput => ({ AND: [scopeWhere(actor, PRODUCT_MATERIALS_VIEW, MATERIAL_SCOPE) as Prisma.ItemWhereInput, { kind: { not: 'FINISHED' } }] })

export async function materialCandidates(client: Reader, actor: Actor, probe: MaterialProbe, except: ReadonlySet<string> = new Set()): Promise<Candidate[]> {
  const keys = materialKeys(probe)
  const or: Prisma.ItemWhereInput[] = []
  if (keys.code.length >= 2) or.push({ code: { startsWith: keys.code.slice(0, 2), mode: 'insensitive' } })
  if (keys.article.length >= 3 && probe.supplierArticleCode) or.push({ supplierArticleCode: { contains: probe.supplierArticleCode.trim().slice(0, 3), mode: 'insensitive' } })
  for (const word of searchWords(probe.name).map(prefixOf)) or.push({ name: { contains: word, mode: 'insensitive' } })
  if (or.length === 0) return []
  const rows = await client.item.findMany({ where: { AND: [materialVisible(actor), { OR: or }] }, select: MATERIAL_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 600 })
  return new Index(rows.map(materialIndexed), materialBlocks, materialReasons).candidatesFor(keys, except)
}

export async function materialIndex(client: Reader, actor: Actor, options: { readonly archived: boolean; readonly companyId?: string | undefined }): Promise<Index<MaterialKeys>> {
  const rows = await client.item.findMany({
    where: { AND: [materialVisible(actor), options.archived ? {} : { status: { not: 'ARCHIVED' } }, options.companyId ? { OR: [{ companyId: options.companyId }, { companyId: null }] } : {}] },
    select: MATERIAL_SELECT,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  return new Index(rows.map(materialIndexed), materialBlocks, materialReasons)
}

