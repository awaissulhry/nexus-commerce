/**
 * P3 (docs/attributes/PLAN.md §4.1) — a business's dictionary against the shared concept catalogue.
 *
 * Three jobs:
 *   · `starterDictionaryRows` — the attributes a NEW business starts with (created in its creation transaction, beside
 *     its markets and warehouse).
 *   · `conceptDictionaryPlan` — for an EXISTING business: which of its attributes already are a concept (link), which
 *     concept it lacks (create), and what cannot be done and why. Reads only.
 *   · `applyConceptDictionary` — writes that plan in one transaction. Dry run unless told otherwise.
 *   · `applyConceptOptions` — adds a concept's value list (colour, size) as options of the attribute linked to it.
 *
 * It never changes an attribute's code, type, options or values, and never deletes. Adopting an existing attribute
 * only sets its `semanticKey`.
 */
import { randomUUID } from 'node:crypto'
import prisma from '../../db.js'
import { inDatabaseTransaction } from '../../lib/database-context.js'
import { ATTRIBUTE_CONCEPTS, CONCEPTS_REVISION, conceptByKey, conceptFieldToken, conceptOptionCode, type ConceptGroup, type ValueLabels } from '@nexus/shared/attribute-concepts'
import { GROUP_LABELS, GROUP_ORDER, SEEDED_OPTION_CONCEPTS, attributeDefinitionFor, conceptLabelLanguage, optionsFor, seededOption } from './attribute-concepts-rows.js'
export { attributeDefinitionFor, starterDictionaryRows, SEEDED_OPTION_CONCEPTS, type StarterDictionary } from './attribute-concepts-rows.js'

export type ConceptPlanEntry =
  | { concept: string; action: 'master'; masterField: string }
  | { concept: string; action: 'linked'; attributeId: string; code: string }
  | { concept: string; action: 'adopt'; attributeId: string; code: string }
  | { concept: string; action: 'create'; code: string; group: ConceptGroup }
  | { concept: string; action: 'blocked'; reason: string }

export interface ConceptPlan {
  revision: string
  entries: ConceptPlanEntry[]
  counts: Record<ConceptPlanEntry['action'], number>
}

/**
 * What `applyConceptDictionary` would do for the current business. Reads only. An ARCHIVED attribute is never adopted
 * (linking a concept to a hidden attribute would hide the concept); one already linked stays `linked`, and one holding
 * the concept's own code blocks the create with the way out (restore it).
 */
export async function conceptDictionaryPlan(): Promise<ConceptPlan> {
  const attributes = await prisma.customAttribute.findMany({ select: { id: true, code: true, semanticKey: true, archivedAt: true } })
  const byCode = new Map(attributes.map(a => [a.code, a]))
  const bySemantic = new Map(attributes.filter(a => a.semanticKey).map(a => [a.semanticKey!, a]))
  const claimed = new Set<string>()
  const entries: ConceptPlanEntry[] = []
  for (const concept of ATTRIBUTE_CONCEPTS) {
    if (concept.masterField) { entries.push({ concept: concept.key, action: 'master', masterField: concept.masterField }); continue }
    const linked = bySemantic.get(concept.key)
    if (linked) { claimed.add(linked.id); entries.push({ concept: concept.key, action: 'linked', attributeId: linked.id, code: linked.code }); continue }
    const candidate = [concept.key, ...(concept.adoptCodes ?? [])].map(code => byCode.get(code))
      .find(a => a && !a.semanticKey && !a.archivedAt && !claimed.has(a.id))
    if (candidate) { claimed.add(candidate.id); entries.push({ concept: concept.key, action: 'adopt', attributeId: candidate.id, code: candidate.code }); continue }
    const taken = byCode.get(concept.key)
    if (taken?.archivedAt && !taken.semanticKey) {
      entries.push({ concept: concept.key, action: 'blocked', reason: `The attribute "${concept.key}" is archived. Restore it to link it to "${concept.key}", or link another attribute by hand.` })
      continue
    }
    if (taken) {
      entries.push({ concept: concept.key, action: 'blocked', reason: `The code "${concept.key}" is already used by an attribute linked to "${taken.semanticKey}". Link another attribute to "${concept.key}" by hand, or rename one of them.` })
      continue
    }
    entries.push({ concept: concept.key, action: 'create', code: concept.key, group: concept.group })
  }
  const counts = { master: 0, linked: 0, adopt: 0, create: 0, blocked: 0 }
  for (const entry of entries) counts[entry.action]++
  return { revision: CONCEPTS_REVISION, entries, counts }
}

/**
 * Write the plan: adopt (set `semanticKey`), create the missing concept attributes (and the groups they need, and the
 * options of closed-list concepts), in one transaction. `dryRun` (the default) returns the plan and writes nothing.
 */
export async function applyConceptDictionary(options: { dryRun?: boolean } = {}): Promise<ConceptPlan & { applied: boolean }> {
  const dryRun = options.dryRun ?? true
  if (dryRun) return { ...(await conceptDictionaryPlan()), applied: false }
  // One transaction; the plan is re-read inside it (through the same client), so what is written is what was read.
  return inDatabaseTransaction(prisma, async () => {
    const plan = await conceptDictionaryPlan()
    for (const entry of plan.entries) {
      if (entry.action === 'adopt') await prisma.customAttribute.update({ where: { id: entry.attributeId }, data: { semanticKey: entry.concept } })
    }
    const creates = plan.entries.filter((e): e is Extract<ConceptPlanEntry, { action: 'create' }> => e.action === 'create')
    if (creates.length) {
      const groups = await prisma.attributeGroup.findMany({ select: { id: true, code: true } })
      const groupId = new Map(groups.map(g => [g.code, g.id]))
      const missingGroups = [...new Set(creates.map(c => c.group))].filter(code => !groupId.has(code))
      for (const code of missingGroups) groupId.set(code, (await prisma.attributeGroup.create({ data: { code, label: GROUP_LABELS[code], sortOrder: GROUP_ORDER.indexOf(code) } })).id)
      const maxOrder = (await prisma.customAttribute.aggregate({ _max: { sortOrder: true } }))._max.sortOrder ?? 0
      const rows = creates.map((entry, index) => {
        const concept = ATTRIBUTE_CONCEPTS.find(c => c.key === entry.concept)!
        return { concept, row: { id: randomUUID(), code: concept.key, label: concept.label, groupId: groupId.get(concept.group)!, ...attributeDefinitionFor(concept),
          localizable: concept.localizable, scope: concept.scope, sortOrder: maxOrder + 1 + index, semanticKey: concept.key } }
      })
      await prisma.customAttribute.createMany({ data: rows.map(r => ({ ...r.row, validation: (r.row.validation ?? undefined) as never })) })
      const optionRows = rows.flatMap(({ concept, row }) => optionsFor(concept).map(option => ({ id: randomUUID(), attributeId: row.id, ...option })))
      if (optionRows.length) await prisma.attributeOption.createMany({ data: optionRows })
    }
    return { ...plan, applied: true }
  })
}

// ── Concept options (2026-09-26, the Owner's "option A": this lane seeds colour and size) ──────────────────────────

export type ConceptOptionEntry =
  | { concept: string; action: 'no-attribute' }
  | { concept: string; action: 'present' | 'matched'; attributeCode: string; code: string; existingCode: string }
  | { concept: string; action: 'create'; attributeId: string; attributeCode: string; code: string; label: string; synonyms: string[]; sortOrder: number; labels?: ValueLabels }

export interface ConceptOptionsPlan {
  revision: string
  entries: ConceptOptionEntry[]
  counts: Record<ConceptOptionEntry['action'], number>
}

export class ConceptOptionsError extends Error {}

/**
 * The options each concept's value list would add to the business attribute linked to it (`semanticKey`, not
 * archived). Reads only. An existing option is never changed: one with the value's code is `present`, one whose code,
 * label or synonym is a spelling of the value is `matched` (no second option is made). The rest are `create`:
 * code = `conceptOptionCode`, label = the primary content language's text, `metadata.labels` = every language.
 */
export async function conceptOptionsPlan(conceptKeys: readonly string[] = SEEDED_OPTION_CONCEPTS): Promise<ConceptOptionsPlan> {
  const language = conceptLabelLanguage()
  const entries: ConceptOptionEntry[] = []
  for (const key of conceptKeys) {
    const concept = conceptByKey(key)
    if (!concept?.valueSynonyms || concept.masterField) throw new ConceptOptionsError(`"${key}" is not a concept with a value list.`)
    const attribute = await prisma.customAttribute.findFirst({ where: { semanticKey: key, archivedAt: null },
      select: { id: true, code: true, options: { select: { code: true, label: true, synonyms: true, sortOrder: true } } } })
    if (!attribute) { entries.push({ concept: key, action: 'no-attribute' }); continue }
    const byToken = new Map<string, string>()
    for (const option of attribute.options) for (const text of [option.code, option.label, ...option.synonyms]) {
      const token = conceptFieldToken(text)
      if (token && !byToken.has(token)) byToken.set(token, option.code)
    }
    const existingCodes = new Set(attribute.options.map(option => option.code))
    let next = Math.max(-1, ...attribute.options.map(option => option.sortOrder)) + 1
    for (const [valueCode, spellings] of Object.entries(concept.valueSynonyms)) {
      const code = conceptOptionCode(valueCode)
      const at = { concept: key, attributeCode: attribute.code, code }
      if (existingCodes.has(code)) { entries.push({ ...at, action: 'present', existingCode: code }); continue }
      const match = [valueCode, ...spellings].map(text => byToken.get(conceptFieldToken(text))).find(Boolean)
      if (match) { entries.push({ ...at, action: 'matched', existingCode: match }); continue }
      // The same option a new business's starter dictionary makes (`seededOption`), appended after the existing ones.
      const option = seededOption(concept, valueCode, next++, language)
      entries.push({ ...at, action: 'create', attributeId: attribute.id, label: option.label, synonyms: option.synonyms,
        sortOrder: option.sortOrder, ...(option.metadata ? { labels: option.metadata.labels } : {}) })
    }
  }
  const counts = { 'no-attribute': 0, present: 0, matched: 0, create: 0 }
  for (const entry of entries) counts[entry.action]++
  return { revision: CONCEPTS_REVISION, entries, counts }
}

/** Write `conceptOptionsPlan` in one transaction (the plan is re-read inside it). Dry run unless told otherwise. */
export async function applyConceptOptions(options: { concepts?: readonly string[]; dryRun?: boolean } = {}): Promise<ConceptOptionsPlan & { applied: boolean }> {
  const concepts = options.concepts?.length ? options.concepts : SEEDED_OPTION_CONCEPTS
  if (options.dryRun ?? true) return { ...(await conceptOptionsPlan(concepts)), applied: false }
  return inDatabaseTransaction(prisma, async () => {
    const plan = await conceptOptionsPlan(concepts)
    const rows = plan.entries.filter((e): e is Extract<ConceptOptionEntry, { action: 'create' }> => e.action === 'create')
      .map(e => ({ id: randomUUID(), attributeId: e.attributeId, code: e.code, label: e.label, synonyms: e.synonyms, sortOrder: e.sortOrder,
        ...(e.labels ? { metadata: { labels: e.labels } } : {}) }))
    if (rows.length) await prisma.attributeOption.createMany({ data: rows })
    return { ...plan, applied: true }
  })
}

