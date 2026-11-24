import { REQUIREMENT_STAGES } from '@nexus/factory-domain/parties/requirements/requirements'
import type { Requirement, RequirementKind, RequirementStage, Requirements } from '../../depth/api'
import type { Read } from '../../depth/model'
import { actOf, type Act } from './holds'
import { kitProblemOf, said, text, type Said, type TermsCan } from './model'

/**
 * F-CT-501 (customer page › TERMS & REQUIREMENTS tab, lane ct-; 10-design §5.3; 18-lead-settles Z12, Z20, Z29, Z31, Z36) — section 3,
 * Requirements (#party-requirements), pure: the brand's rules as rows — the kind, the words, its version in the chain ("v3 · replaces v2
 * of 12/11", from `supersedesId`), what it applies to (all orders, or each style "CODE · name": this customer's and our own only — a
 * style saved before the wall reads "a style no longer offered", Z36), for which company, WHERE IT REALLY SHOWS (a shipping rule is
 * printed on the delivery note — "unless the office types its own remarks" —, every other stage is kept, not on that screen yet: honest,
 * Z12), its file (a door with files.read, else its name), who wrote it and when. Ended and replaced rules are folded and told apart.
 * Kind chips from six rules in force (Z31); ten rows, then "Show n more". Add / Replace… / End… are the depth provider's own windows
 * (RequirementWindows), each HIDDEN without its right (the server's `mayAdd` / `mayChange` first), held only by state.
 */

/** The rules a list shows before "Show n more requirements" (10-design §5.3). */
export const REQUIREMENT_ROWS = 10
/** Kind chips from this many rules in force (Z31; fewer: the kind tag on each row is enough). */
export const KIND_CHIPS_FROM = 6

export const requirementAnchor = (id: string): string => `party-requirement-${id}`

export interface RequirementStyle {
  readonly id: string
  /** null: a style that is no longer offered (saved before the wall; another brand's is never named, Z36). */
  readonly code: string | null
  readonly name: string
}

export interface RequirementRow {
  readonly id: string
  readonly anchor: string
  readonly kind: RequirementKind
  readonly words: string
  /** Its place in the chain (1 = the first version). */
  readonly version: number
  /** The version it replaced (only from v2): its number and when it was written. */
  readonly replaces: { readonly version: number; readonly on: string } | null
  readonly everyStyle: boolean
  readonly styles: readonly RequirementStyle[]
  /** The company it is for; null: every company. */
  readonly company: string | null
  /** A shipping rule: printed on the delivery note (DDT). */
  readonly ddt: boolean
  /** The other stages it is kept for (not on those screens yet). */
  readonly kept: readonly RequirementStage[]
  readonly file: { readonly id: string; readonly name: string } | null
  /** The file is a door (files.read: one preview read per click), else its name. */
  readonly fileDoor: boolean
  readonly by: string | null
  readonly on: string
  readonly replace: Act
  readonly end: Act
  /** The rule as its windows take it. */
  readonly requirement: Requirement
}

export interface EndedRequirementRow {
  readonly id: string
  readonly kind: RequirementKind
  readonly words: string
  /** Replaced by a newer version (else ended). */
  readonly replaced: boolean
  readonly version: number
  readonly nextVersion: number | null
  readonly on: string | null
  readonly by: string | null
  readonly reason: string | null
}

export interface RequirementsSectionModel {
  readonly reading: boolean
  readonly problem: string | null
  readonly answer: Said | null
  readonly all: readonly RequirementRow[]
  /** The rows drawn (after the kind chip and the "Show more" cap). */
  readonly rows: readonly RequirementRow[]
  /** How many more "Show n more requirements" brings (0: none). */
  readonly hidden: number
  readonly ended: readonly EndedRequirementRow[]
  readonly endedOpen: boolean
  /** The kind chips (six or more in force), each with its count; null: none drawn. */
  readonly kinds: ReadonlyArray<{ readonly kind: RequirementKind; readonly count: number }> | null
  readonly kind: RequirementKind | null
  readonly add: Act
}

export interface RequirementsInput {
  readonly read: Read<Requirements> | null
  readonly can: TermsCan
  readonly archived: boolean
  /** Our companies' names by id (a rule names its company by code; the name is said when known). */
  readonly companyNames: Readonly<Record<string, string>>
  readonly kind: RequirementKind | null
  readonly more: boolean
  readonly endedOpen: boolean
}

/** Every rule's version in its chain (v1 has no `supersedesId`; each replacement is one more). */
export function versionsOf(read: Requirements): ReadonlyMap<string, number> {
  const all = new Map([...read.inForce, ...read.ended].map((row) => [row.id, row]))
  const versions = new Map<string, number>()
  const versionOf = (row: Requirement, seen: Set<string>): number => {
    const known = versions.get(row.id)
    if (known !== undefined) return known
    const before = row.supersedesId ? all.get(row.supersedesId) : undefined
    const version = before && !seen.has(before.id) ? versionOf(before, new Set([...seen, row.id])) + 1 : 1
    versions.set(row.id, version)
    return version
  }
  for (const row of all.values()) versionOf(row, new Set())
  return versions
}

/** The stages a rule is kept for besides the delivery note, in the domain's order. */
const keptOf = (stages: readonly RequirementStage[]): RequirementStage[] => REQUIREMENT_STAGES.filter((stage) => stage !== 'SHIPMENT' && stages.includes(stage))

/** The section's model (pure). */
export function requirementsSection(input: RequirementsInput): RequirementsSectionModel {
  const { can, archived } = input
  const read = input.read?.status === 'ready' ? input.read.value : null
  const versions = read ? versionsOf(read) : new Map<string, number>()
  const byId = new Map(read ? [...read.inForce, ...read.ended].map((row) => [row.id, row]) : [])
  const companyOf = (row: Requirement): string | null => (row.companyId === null ? null : (input.companyNames[row.companyId] ?? row.companyCode ?? null))
  const all: RequirementRow[] = (read?.inForce ?? []).map((row) => {
    const version = versions.get(row.id) ?? 1
    const before = row.supersedesId ? byId.get(row.supersedesId) : undefined
    const may = can.manage && (row.mayChange ?? true)
    return {
      id: row.id,
      anchor: requirementAnchor(row.id),
      kind: row.kind,
      words: row.words,
      version,
      replaces: before ? { version: versions.get(before.id) ?? version - 1, on: before.createdAt } : null,
      everyStyle: row.everyStyle,
      // Z36: a style saved before the wall that is not ours or this customer's reads { code: '' }: "a style no longer offered".
      styles: row.styles.map((style) => ({ id: style.id, code: style.code === '' ? null : style.code, name: style.name })),
      company: companyOf(row),
      ddt: row.appliesAt.includes('SHIPMENT'),
      kept: keptOf(row.appliesAt),
      file: row.file ? { id: row.file.id, name: row.file.fileName } : null,
      fileDoor: can.files,
      by: row.createdBy,
      on: row.createdAt,
      replace: actOf(may, archived),
      end: actOf(may, archived),
      requirement: row,
    }
  })
  const replacedIds = new Set([...(read?.inForce ?? []), ...(read?.ended ?? [])].flatMap((row) => (row.supersedesId ? [row.supersedesId] : [])))
  const successor = (id: string) => [...(read?.inForce ?? []), ...(read?.ended ?? [])].find((row) => row.supersedesId === id)
  const ended: EndedRequirementRow[] = (read?.ended ?? []).map((row) => {
    const next = replacedIds.has(row.id) ? successor(row.id) : undefined
    return { id: row.id, kind: row.kind, words: row.words, replaced: next !== undefined, version: versions.get(row.id) ?? 1, nextVersion: next ? (versions.get(next.id) ?? null) : null, on: row.endedAt, by: row.endedBy, reason: row.endReason }
  })
  const counts = new Map<RequirementKind, number>()
  for (const row of all) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1)
  const kinds = all.length >= KIND_CHIPS_FROM ? [...counts.entries()].map(([kind, count]) => ({ kind, count })) : null
  const kind = kinds && input.kind && counts.has(input.kind) ? input.kind : null
  const shown = kind ? all.filter((row) => row.kind === kind) : all
  const capped = kind || input.more ? shown : shown.slice(0, REQUIREMENT_ROWS)
  return {
    reading: input.read === null || input.read.status === 'loading',
    problem: input.read?.status === 'error' ? kitProblemOf(input.read.problem) : null,
    answer: read ? requirementsAnswer(all) : null,
    all,
    rows: capped,
    hidden: shown.length - capped.length,
    ended,
    endedOpen: input.endedOpen,
    kinds,
    kind,
    add: actOf(can.manage && (read?.mayAdd ?? true), archived),
  }
}

/** "4 requirements in force: packing, labels and documents · 1 printed on the delivery note (DDT); the rest kept, not on the other screens yet." */
export function requirementsAnswer(rows: readonly RequirementRow[]): Said {
  if (rows.length === 0) return said('ct.req.none')
  const kinds = [...new Set(rows.map((row) => row.kind))].map((kind) => said(`sales-customers-depth:kind.${kind}`))
  const ddt = rows.filter((row) => row.ddt).length
  return said('ct.req.answer', {
    params: { count: rows.length },
    words: { printed: ddt > 0 ? said(ddt < rows.length ? 'ct.req.ddtSome' : 'ct.req.ddtAll', { params: { count: ddt } }) : said('ct.req.ddtNone') },
    saidLists: { kinds: kinds.map((words) => said('ct.req.kindLower', { lower: { kind: words } })) },
  })
}

/** A replaced or ended rule's line: "v1 · replaced by v2 on {date} by {name}: “{reason}”" vs "Ended on {date} by {name}: “{reason}”". */
export function endedLine(row: EndedRequirementRow): Said {
  const name = row.by ? text(row.by) : said('sales-customers-depth:hold.system')
  const when = row.on ? { days: { date: row.on } } : {}
  if (row.replaced) return said(row.reason ? 'ct.req.replacedBy' : 'ct.req.replacedByBare', { params: { version: row.version, next: row.nextVersion ?? row.version + 1, ...(row.reason ? { reason: row.reason } : {}) }, words: { name }, ...when })
  return said(row.reason ? 'ct.req.endedOn' : 'ct.req.endedOnBare', { params: row.reason ? { reason: row.reason } : {}, words: { name }, ...when })
}

/** Where a rule really shows (Z12): the delivery note for a shipping rule; the other stages kept, not on those screens yet. */
export function keptWords(stages: readonly RequirementStage[]): Said | null {
  if (stages.length === 0) return null
  return said(stages.length === 1 ? 'ct.req.keptOne' : 'ct.req.keptMany', { saidLists: { stages: stages.map((stage) => said(`sales-customers-depth:stage.${stage}`)) } })
}
