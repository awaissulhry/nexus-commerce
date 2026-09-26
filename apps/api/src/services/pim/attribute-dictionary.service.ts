/**
 * P3 (docs/attributes/PLAN.md §4.1) — create and update many attributes (and their options) in one call.
 *
 * All-or-nothing: every row is checked first; if any row is wrong, nothing is written and each wrong row says why.
 * A dictionary is shared by every product, so half a batch is worse than none. Reads are batched (one query per
 * table); writes run in one transaction.
 *
 * Rules kept from the single-row routes (`attributes.routes.ts`): the code is the stable identifier and never
 * changes; the type never changes (it would orphan stored values); a choice list cannot be per-language.
 * Added: `validation` must satisfy the shared contract (`parseAttributeRules`), and `semanticKey` must name a concept
 * that is not already a master field.
 */
import { randomUUID } from 'node:crypto'
import prisma from '../../db.js'
import { inDatabaseTransaction } from '../../lib/database-context.js'
import { parseAttributeRules } from '@nexus/shared/attributes'
import { conceptByKey } from '@nexus/shared/attribute-concepts'
import { CODE_NOT_LOCALIZABLE, CODE_TYPES } from './attribute-rules.js'

export const ATTRIBUTE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/
export const ATTRIBUTE_TYPES: ReadonlySet<string> = new Set(['text', 'textarea', 'number', 'boolean', 'select', 'multiselect', 'date', 'reference', 'asset'])
export const ATTRIBUTE_SCOPES: ReadonlySet<string> = new Set(['global', 'per_variant'])
export const MAX_DICTIONARY_ROWS = 500
/**
 * P6 (docs/attributes/PLAN.md §4.4) — attribute types that may carry options. A select's options are its list; a
 * text attribute's options are SUGGESTIONS (the open dropdown: pick one or type your own).
 */
export const OPTION_TYPES: ReadonlySet<string> = new Set(['select', 'multiselect', 'text', 'textarea'])

export interface OptionUpsert { code: string; label?: string; synonyms?: string[]; metadata?: unknown; sortOrder?: number; archived?: boolean }
export interface AttributeUpsert {
  code: string
  label?: string
  description?: string | null
  /** Either the group's id or its code. */
  groupId?: string
  groupCode?: string
  type?: string
  validation?: unknown
  defaultValue?: unknown
  localizable?: boolean
  scope?: string
  sortOrder?: number
  semanticKey?: string | null
  options?: OptionUpsert[]
}

export type AttributeUpsertResult = { code: string; ok: true; id: string; created: boolean; options: { created: number; updated: number } } | { code: string; ok: false; errors: string[] }

/** Is `semanticKey` a concept a business attribute may take? Returns the refusal, or null. */
export function semanticKeyRefusal(semanticKey: unknown): string | null {
  if (semanticKey === null || semanticKey === undefined) return null
  if (typeof semanticKey !== 'string') return 'semanticKey must be a concept key or null'
  const concept = conceptByKey(semanticKey)
  if (!concept) return `"${semanticKey}" is not a known concept`
  if (concept.masterField) return `"${semanticKey}" is already the master field "${concept.masterField}"; it cannot also be a custom attribute`
  return null
}

/** Check and (unless `dryRun`) write a batch. See the file header. */
export async function upsertAttributes(rows: AttributeUpsert[], options: { dryRun?: boolean } = {}): Promise<{ applied: boolean; results: AttributeUpsertResult[] }> {
  if (!Array.isArray(rows) || rows.length === 0) throw new DictionaryError('Send at least one attribute.')
  if (rows.length > MAX_DICTIONARY_ROWS) throw new DictionaryError(`Send at most ${MAX_DICTIONARY_ROWS} attributes per call.`)

  const codes = rows.map(row => row?.code).filter((code): code is string => typeof code === 'string')
  const semanticKeys = rows.map(row => row?.semanticKey).filter((key): key is string => typeof key === 'string')
  const [existing, groups, linked] = await Promise.all([
    prisma.customAttribute.findMany({ where: { code: { in: codes } }, select: { id: true, code: true, type: true, localizable: true, semanticKey: true } }),
    prisma.attributeGroup.findMany({ select: { id: true, code: true } }),
    semanticKeys.length ? prisma.customAttribute.findMany({ where: { semanticKey: { in: semanticKeys } }, select: { code: true, semanticKey: true } }) : [],
  ])
  const byCode = new Map(existing.map(a => [a.code, a]))
  const groupById = new Map(groups.map(g => [g.id, g.id]))
  const groupByCode = new Map(groups.map(g => [g.code, g.id]))
  const linkedTo = new Map<string, string>(linked.map(a => [a.semanticKey!, a.code] as [string, string]))
  const existingOptions = existing.length
    ? await prisma.attributeOption.findMany({ where: { attributeId: { in: existing.map(a => a.id) } }, select: { id: true, attributeId: true, code: true } })
    : []

  const seenCodes = new Set<string>()
  const seenSemantic = new Map<string, string>()
  const checked = rows.map(row => {
    const errors: string[] = []
    const code = typeof row?.code === 'string' ? row.code : ''
    if (!ATTRIBUTE_CODE_PATTERN.test(code)) errors.push('code must be lowercase snake_case (a–z, 0–9, _), starting with a letter, at most 64 characters')
    if (seenCodes.has(code)) errors.push(`code "${code}" appears twice in this batch`)
    seenCodes.add(code)
    const current = byCode.get(code)
    const type = row.type ?? current?.type
    if (!current) {
      if (!row.label?.trim()) errors.push('label is required for a new attribute')
      if (!row.type) errors.push('type is required for a new attribute')
      if (!row.groupId && !row.groupCode) errors.push('groupId or groupCode is required for a new attribute')
    } else if (row.type !== undefined && row.type !== current.type) {
      errors.push(`type cannot change from "${current.type}" to "${row.type}": stored values would be orphaned`)
    }
    if (row.label !== undefined && !row.label.trim()) errors.push('label cannot be empty')
    if (type !== undefined && !ATTRIBUTE_TYPES.has(type)) errors.push(`type must be one of ${[...ATTRIBUTE_TYPES].join(', ')}`)
    if (row.scope !== undefined && !ATTRIBUTE_SCOPES.has(row.scope)) errors.push(`scope must be one of ${[...ATTRIBUTE_SCOPES].join(', ')}`)
    const localizable = row.localizable ?? current?.localizable ?? false
    if (localizable && type && CODE_TYPES.has(type)) errors.push(CODE_NOT_LOCALIZABLE)
    let groupId: string | undefined
    if (row.groupId !== undefined) { groupId = groupById.get(row.groupId); if (!groupId) errors.push(`groupId "${row.groupId}" does not exist`) }
    else if (row.groupCode !== undefined) { groupId = groupByCode.get(row.groupCode); if (!groupId) errors.push(`groupCode "${row.groupCode}" does not exist`) }
    if (row.validation !== undefined && row.validation !== null) {
      const rules = parseAttributeRules(row.validation)
      // (`strictNullChecks` is off in this app, so the result union does not narrow by itself.)
      if (!rules.ok) errors.push(...(rules as { errors: string[] }).errors.map(error => `validation — ${error}`))
    }
    if (row.semanticKey !== undefined) {
      const refusal = semanticKeyRefusal(row.semanticKey)
      if (refusal) errors.push(refusal)
      else if (row.semanticKey) {
        const holder = linkedTo.get(row.semanticKey)
        if (holder && holder !== code && !rows.some(other => other.code === holder && other.semanticKey === null)) errors.push(`concept "${row.semanticKey}" is already linked to attribute "${holder}"`)
        const inBatch = seenSemantic.get(row.semanticKey)
        if (inBatch && inBatch !== code) errors.push(`concept "${row.semanticKey}" is given to "${inBatch}" and "${code}" in this batch`)
        seenSemantic.set(row.semanticKey, code)
      }
    }
    if (row.options !== undefined) {
      if (!Array.isArray(row.options)) errors.push('options must be a list')
      else {
        if (row.options.length && type && !OPTION_TYPES.has(type)) errors.push(`attribute type "${type}" does not accept options (select, multiselect, text or textarea)`)
        const optionCodes = new Set<string>()
        for (const option of row.options) {
          if (!option || !ATTRIBUTE_CODE_PATTERN.test(option.code ?? '')) { errors.push(`option code "${option?.code ?? ''}" must be lowercase snake_case`); continue }
          if (optionCodes.has(option.code)) errors.push(`option "${option.code}" appears twice`)
          optionCodes.add(option.code)
          const known = existingOptions.some(o => o.attributeId === current?.id && o.code === option.code)
          if (!known && !option.label?.trim()) errors.push(`option "${option.code}" needs a label`)
          if (option.label !== undefined && !option.label.trim()) errors.push(`option "${option.code}" label cannot be empty`)
          if (option.synonyms !== undefined && (!Array.isArray(option.synonyms) || option.synonyms.some(s => typeof s !== 'string' || !s.trim()))) errors.push(`option "${option.code}" synonyms must be non-empty text`)
        }
      }
    }
    return { row, code, current, groupId, errors }
  })

  const failed = checked.filter(c => c.errors.length)
  if (failed.length || options.dryRun) {
    return { applied: false, results: checked.map(c => c.errors.length
      ? { code: c.code, ok: false as const, errors: c.errors }
      : { code: c.code, ok: true as const, id: c.current?.id ?? '', created: !c.current, options: { created: 0, updated: 0 } }) }
  }

  const results = await inDatabaseTransaction(prisma, async () => {
    // Release concepts first, so a batch can move a concept from one attribute to another.
    for (const c of checked) if (c.current && c.row.semanticKey === null && c.current.semanticKey) await prisma.customAttribute.update({ where: { id: c.current.id }, data: { semanticKey: null } })
    const creates = checked.filter(c => !c.current).map(c => ({ ...c, id: randomUUID() }))
    if (creates.length) {
      await prisma.customAttribute.createMany({ data: creates.map(c => ({
        id: c.id, code: c.code, label: c.row.label!.trim(), description: c.row.description?.trim() || null, groupId: c.groupId!, type: c.row.type!,
        validation: (c.row.validation ?? undefined) as never, defaultValue: (c.row.defaultValue ?? undefined) as never,
        localizable: c.row.localizable ?? false, scope: c.row.scope ?? 'global', sortOrder: typeof c.row.sortOrder === 'number' ? c.row.sortOrder : 0,
        semanticKey: c.row.semanticKey ?? null,
      })) })
    }
    for (const c of checked.filter(c => c.current)) {
      const data: Record<string, unknown> = {}
      if (c.row.label !== undefined) data.label = c.row.label.trim()
      if (c.row.description !== undefined) data.description = c.row.description?.trim() || null
      if (c.groupId !== undefined) data.groupId = c.groupId
      if (c.row.validation !== undefined) data.validation = c.row.validation ?? null
      if (c.row.defaultValue !== undefined) data.defaultValue = c.row.defaultValue ?? null
      if (c.row.localizable !== undefined) data.localizable = c.row.localizable
      if (c.row.scope !== undefined) data.scope = c.row.scope
      if (c.row.sortOrder !== undefined) data.sortOrder = c.row.sortOrder
      if (typeof c.row.semanticKey === 'string') data.semanticKey = c.row.semanticKey
      if (Object.keys(data).length) await prisma.customAttribute.update({ where: { id: c.current!.id }, data })
    }
    const idOf = new Map([...creates.map(c => [c.code, c.id] as const), ...checked.filter(c => c.current).map(c => [c.code, c.current!.id] as const)])
    const optionCounts = new Map<string, { created: number; updated: number }>()
    const newOptions: Array<{ id: string; attributeId: string; code: string; label: string; synonyms: string[]; metadata?: never; sortOrder: number; archivedAt: Date | null }> = []
    for (const c of checked) {
      const counts = { created: 0, updated: 0 }
      optionCounts.set(c.code, counts)
      for (const option of c.row.options ?? []) {
        const attributeId = idOf.get(c.code)!
        const known = existingOptions.find(o => o.attributeId === attributeId && o.code === option.code)
        const archivedAt = option.archived === undefined ? undefined : option.archived ? new Date() : null
        if (!known) {
          newOptions.push({ id: randomUUID(), attributeId, code: option.code, label: option.label!.trim(), synonyms: (option.synonyms ?? []).map(s => s.trim()),
            ...(option.metadata !== undefined ? { metadata: option.metadata as never } : {}), sortOrder: option.sortOrder ?? 0, archivedAt: archivedAt ?? null })
          counts.created++
          continue
        }
        const data: Record<string, unknown> = {}
        if (option.label !== undefined) data.label = option.label.trim()
        if (option.synonyms !== undefined) data.synonyms = option.synonyms.map(s => s.trim())
        if (option.metadata !== undefined) data.metadata = option.metadata ?? null
        if (option.sortOrder !== undefined) data.sortOrder = option.sortOrder
        if (archivedAt !== undefined) data.archivedAt = archivedAt
        if (Object.keys(data).length) { await prisma.attributeOption.update({ where: { id: known.id }, data }); counts.updated++ }
      }
    }
    if (newOptions.length) await prisma.attributeOption.createMany({ data: newOptions })
    return checked.map(c => ({ code: c.code, ok: true as const, id: idOf.get(c.code)!, created: !c.current, options: optionCounts.get(c.code)! }))
  })
  return { applied: true, results }
}

export class DictionaryError extends Error {}
