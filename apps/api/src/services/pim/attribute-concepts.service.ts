/**
 * P3 (docs/attributes/PLAN.md §4.1) — a business's dictionary against the shared concept catalogue.
 *
 * Three jobs:
 *   · `starterDictionaryRows` — the attributes a NEW business starts with (created in its creation transaction, beside
 *     its markets and warehouse).
 *   · `conceptDictionaryPlan` — for an EXISTING business: which of its attributes already are a concept (link), which
 *     concept it lacks (create), and what cannot be done and why. Reads only.
 *   · `applyConceptDictionary` — writes that plan in one transaction. Dry run unless told otherwise.
 *
 * It never changes an attribute's code, type, options or values, and never deletes. Adopting an existing attribute
 * only sets its `semanticKey`.
 */
import { randomUUID } from 'node:crypto'
import prisma from '../../db.js'
import { inDatabaseTransaction } from '../../lib/database-context.js'
import { ATTRIBUTE_CONCEPTS, CONCEPTS_REVISION, type ConceptGroup } from '@nexus/shared/attribute-concepts'
import { GROUP_LABELS, GROUP_ORDER, attributeDefinitionFor, optionsFor } from './attribute-concepts-rows.js'
export { attributeDefinitionFor, starterDictionaryRows, type StarterDictionary } from './attribute-concepts-rows.js'

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

/** What `applyConceptDictionary` would do for the current business. Reads only. */
export async function conceptDictionaryPlan(): Promise<ConceptPlan> {
  const attributes = await prisma.customAttribute.findMany({ select: { id: true, code: true, semanticKey: true } })
  const byCode = new Map(attributes.map(a => [a.code, a]))
  const bySemantic = new Map(attributes.filter(a => a.semanticKey).map(a => [a.semanticKey!, a]))
  const claimed = new Set<string>()
  const entries: ConceptPlanEntry[] = []
  for (const concept of ATTRIBUTE_CONCEPTS) {
    if (concept.masterField) { entries.push({ concept: concept.key, action: 'master', masterField: concept.masterField }); continue }
    const linked = bySemantic.get(concept.key)
    if (linked) { claimed.add(linked.id); entries.push({ concept: concept.key, action: 'linked', attributeId: linked.id, code: linked.code }); continue }
    const candidate = [concept.key, ...(concept.adoptCodes ?? [])].map(code => byCode.get(code))
      .find(a => a && !a.semanticKey && !claimed.has(a.id))
    if (candidate) { claimed.add(candidate.id); entries.push({ concept: concept.key, action: 'adopt', attributeId: candidate.id, code: candidate.code }); continue }
    const taken = byCode.get(concept.key)
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
