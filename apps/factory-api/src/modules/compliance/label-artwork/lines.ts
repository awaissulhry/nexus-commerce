import { brandingKey, lineRules, packagingRulesOf, planChanges, planLabelLines, sourceOf, type LinePlanEntry, type LineRule, type RuleLine, type RuleMaterial } from '@nexus/factory-domain/compliance/label-artwork/rules'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { PRODUCT_BOM_MANAGE } from '@nexus/factory-domain/product/bom/permissions'
import { editRefusal, nextSeq, planLine } from '@nexus/factory-domain/product/bom/rules'
import { decimalText, type Uom } from '@nexus/factory-domain/product/units/units'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { assertMayWrite, auditedLine, bomStyleOf, contextOf, deleteLine, lockDraft, materialFor, prefixed, readColourways, readLines, readRevisionFor, writeLine, type LockedDraft } from '../../product/bom/store'
import { guarded as bomGuarded, recordChange } from '../../product/bom-lines/store'
import type { LabelLinesView } from './contract'
import { guarded, type Reader } from './store'

/**
 * The label and packaging lines a style's BOM needs, made by the rules (B-W2b-259; PRD-088; B-W2b-211's BomLine.sourceKey).
 * The rules: the marking the law asks of the garment — each label template it carries (the revision's garment label and the
 * style's own other labels: fibre and care, glove marking, packaging label; "compliance:label:<code>", one per garment) and,
 * for PPE, the user information leaflet ("compliance:user-information", Reg. 2016/425 art. 8(7)) — and the brand's packaging
 * rules of its ACTIVE branding set (B-W2b-206 BrandingSet.packagingRules: a material and a quantity per garment;
 * "branding:<key>"). A rule per pack or carton, or in words only, makes no line (packing counts it): listed.
 *
 * The read compares the rules with the lines they made before (by sourceKey) and says what to add, change or remove; the
 * refresh applies it to a DRAFT revision in one command (W1's lockDraft: the style row FOR UPDATE, B-W2b-221's edit rule, the
 * revision's version compared and set; W1's writeLine / deleteLine with their checks), so a changed rule ("refreshed when a
 * rule changes") is one refresh away. A compliance line's material is the person's choice the first time (`materials`,
 * sourceKey → a LABEL or PACKAGING material counted in pieces); it is kept afterwards. Lines typed by a person are never
 * touched. Audit rows on each line and on the revision; W1's `style.bom_changed`.
 */

interface Facts {
  readonly style: { id: string; code: string; name: string; companyId: string | null; ppe: boolean; brand: { id: string; name: string } | null }
  readonly revision: { id: string; revision: number; status: string; version: number; labelTemplateId: string | null; editable: boolean }
  readonly brandingSet: { id: string; code: string; name: string } | null
  readonly rules: LineRule[]
  readonly inWords: LabelLinesView['inWords']
  readonly lines: RuleLine[]
}

/** The rules and the lines they made, read one query after another with `db`. */
async function readFacts(db: Reader, styleId: string, revisionId: string): Promise<Facts> {
  const style = await db.style.findUnique({ where: { id: styleId }, select: { id: true, code: true, name: true, companyId: true, status: true, ppeCategory: true, brandPartyId: true } })
  const revision = await db.styleRevision.findUnique({ where: { id: revisionId }, select: { id: true, styleId: true, revision: true, status: true, version: true, labelTemplateId: true } })
  if (!style || !revision || revision.styleId !== styleId) throw new NotFoundError('Revision not found.')
  const brand = style.brandPartyId ? await db.party.findUnique({ where: { id: style.brandPartyId }, select: { id: true, legalName: true, tradeName: true } }) : null
  // The brand's ACTIVE set of the style's company; a tenant-wide style: the brand's only ACTIVE set (several: none, in words).
  const sets = style.brandPartyId
    ? await db.brandingSet.findMany({ where: { partyId: style.brandPartyId, status: 'ACTIVE', ...(style.companyId ? { companyId: style.companyId } : {}) }, select: { id: true, code: true, name: true, packagingRules: true }, orderBy: [{ code: 'asc' }], take: 2 })
    : []
  const set = sets.length === 1 ? sets[0]! : null
  // The labels the garment carries: the revision's own, then the style's other labels (per code, ACTIVE else the newest draft).
  const own = revision.labelTemplateId ? await db.labelTemplate.findUnique({ where: { id: revision.labelTemplateId }, select: { id: true, code: true, revision: true, kind: true, name: true, status: true } }) : null
  const styleLabels = await db.labelTemplate.findMany({ where: { styleId, status: { in: ['ACTIVE', 'DRAFT'] } }, select: { id: true, code: true, revision: true, kind: true, name: true, status: true }, orderBy: [{ code: 'asc' }, { revision: 'desc' }] })
  const byCode = new Map<string, (typeof styleLabels)[number]>()
  for (const row of styleLabels) {
    const kept = byCode.get(row.code)
    if (!kept || (kept.status !== 'ACTIVE' && row.status === 'ACTIVE')) byCode.set(row.code, row)
  }
  if (own) byCode.delete(own.code)
  const labels = [...(own ? [own] : []), ...byCode.values()]
  const { rules, inWords } = lineRules({ labels, ppe: style.ppeCategory !== 'NOT_PPE', packaging: set ? packagingRulesOf(set.packagingRules) : [] })
  const ambiguous = sets.length > 1 ? [{ sourceKey: brandingKey('*'), words: `The brand has ${sets.length} active branding sets: its packaging rules are not read until one is left.`, why: 'NO_MATERIAL' as const }] : []
  const lines = (await db.bomLine.findMany({ where: { revisionId, sourceKey: { not: null } }, select: { id: true, seq: true, sourceKey: true, itemId: true, qty: true, uom: true, section: true }, orderBy: [{ seq: 'asc' }] })).map(
    (row): RuleLine => ({ id: row.id, seq: row.seq, sourceKey: row.sourceKey!, itemId: row.itemId, qty: decimalText(row.qty.toString()), uom: row.uom as Uom, section: row.section }),
  )
    // Several sets of the brand: its rules are not known, so its lines are left as they are (never removed for that).
    .filter((line) => ambiguous.length === 0 || sourceOf(line.sourceKey) !== 'BRANDING')
  return {
    style: { id: style.id, code: style.code, name: style.name, companyId: style.companyId, ppe: style.ppeCategory !== 'NOT_PPE', brand: brand ? { id: brand.id, name: brand.tradeName ?? brand.legalName } : null },
    revision: { id: revision.id, revision: revision.revision, status: revision.status, version: revision.version, labelTemplateId: revision.labelTemplateId, editable: editRefusal(revision, style.status) === null },
    brandingSet: set ? { id: set.id, code: set.code, name: set.name } : null,
    rules,
    inWords: [...ambiguous, ...inWords],
    lines,
  }
}

const MATERIAL_SELECT = { id: true, code: true, name: true, kind: true, status: true, approval: true, companyId: true, consumptionUom: true } as const

async function readMaterials(db: Reader, ids: readonly string[]): Promise<Map<string, RuleMaterial>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const rows = await db.item.findMany({ where: { id: { in: unique } }, select: MATERIAL_SELECT })
  return new Map(rows.map((row) => [row.id, { ...row, status: row.status as 'ACTIVE' | 'ARCHIVED', consumptionUom: row.consumptionUom as Uom }]))
}

/** The plan with every material it names. */
async function planOf(db: Reader, facts: Facts, picked: Readonly<Record<string, string>>): Promise<{ plan: LinePlanEntry[]; materials: Map<string, RuleMaterial> }> {
  const materials = await readMaterials(db, [...facts.rules.flatMap((rule) => (rule.itemId ? [rule.itemId] : [])), ...Object.values(picked), ...facts.lines.map((line) => line.itemId)])
  return { plan: planLabelLines({ rules: facts.rules, lines: facts.lines, picked, materials, companyId: facts.style.companyId }), materials }
}

async function viewOf(db: Reader, facts: Facts, plan: readonly LinePlanEntry[], materials: ReadonlyMap<string, RuleMaterial>): Promise<LabelLinesView> {
  const candidates = await db.item.findMany({
    where: { kind: { in: ['LABEL', 'PACKAGING'] }, status: 'ACTIVE', approval: { not: 'BLOCKED' }, consumptionUom: 'PCS', OR: [{ companyId: null }, ...(facts.style.companyId ? [{ companyId: facts.style.companyId }] : [])] },
    select: MATERIAL_SELECT,
    orderBy: [{ code: 'asc' }],
    take: 200,
  })
  const material = (id: string | null | undefined) => {
    const row = id ? materials.get(id) : undefined
    return row ? { id: row.id, code: row.code, name: row.name, kind: row.kind, consumptionUom: row.consumptionUom } : null
  }
  return {
    style: { id: facts.style.id, code: facts.style.code, name: facts.style.name, ppe: facts.style.ppe, brand: facts.style.brand },
    revision: { id: facts.revision.id, revision: facts.revision.revision, status: facts.revision.status, version: facts.revision.version, editable: facts.revision.editable },
    brandingSet: facts.brandingSet,
    plan: plan.map((entry) => ({
      action: entry.action,
      sourceKey: entry.sourceKey,
      source: sourceOf(entry.sourceKey),
      words: entry.rule?.words ?? null,
      section: entry.rule?.section ?? null,
      per: entry.rule?.per ?? null,
      template: entry.rule?.template ?? null,
      line: entry.line ? { id: entry.line.id, seq: entry.line.seq, itemId: entry.line.itemId, qty: entry.line.qty, uom: entry.line.uom, section: entry.line.section } : null,
      next: entry.next,
      material: material(entry.next?.itemId ?? entry.line?.itemId),
      changes: [...entry.changes],
      why: entry.why,
      held: entry.held,
    })),
    inWords: facts.inWords,
    candidates: candidates.map((row) => ({ id: row.id, code: row.code, name: row.name, kind: row.kind, consumptionUom: row.consumptionUom as Uom })),
    changes: facts.revision.editable ? planChanges(plan).length : 0,
  }
}

/** GET /product/styles/:styleId/revisions/:revisionId/bom/label-lines */
export async function readLabelLines(caller: CommandCaller, styleId: string, revisionId: string): Promise<LabelLinesView> {
  await readRevisionFor(caller, styleId, revisionId)
  return caller.withClient(async (db) => {
    const facts = await readFacts(db, styleId, revisionId)
    const { plan, materials } = await planOf(db, facts, {})
    return viewOf(db, facts, plan, materials)
  })
}

function pickedProblems(facts: Facts, picked: Readonly<Record<string, string>>): { path: string; message: string }[] {
  return Object.keys(picked).flatMap((sourceKey) => {
    const rule = facts.rules.find((entry) => entry.sourceKey === sourceKey)
    if (!rule) return [{ path: `body/materials/${sourceKey}`, message: 'No rule of this style has this key.' }]
    if (rule.source !== 'COMPLIANCE') return [{ path: `body/materials/${sourceKey}`, message: "The brand's rule names its material: change it in the branding set." }]
    return []
  })
}

async function apply(tools: CommandTools, draft: LockedDraft, styleId: string, entry: LinePlanEntry, companyId: string | null): Promise<string | null> {
  const { tx } = tools
  const target = (lineId: string) => ({ styleId, revisionId: draft.revisionId, lineId })
  if (entry.action === 'REMOVE') {
    const current = (await readLines(tx, draft.revisionId)).find((line) => line.id === entry.line!.id)
    if (!current) return null
    await deleteLine(tools, current)
    tools.audit({ recordType: 'BomLine', recordId: current.id, companyId, before: { revisionId: draft.revisionId, sourceKey: entry.sourceKey, ...auditedLine(current) }, reason: entry.why === 'DUPLICATE' ? 'A second line of one rule.' : 'Its rule no longer applies to the style.' })
    return current.id
  }
  const next = entry.next!
  const material = await materialFor(tx, next.itemId, companyId)
  const row = await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: { sizes: true, baseSize: true } })
  const style = bomStyleOf(row, await readColourways(tx, styleId))
  const lines = await readLines(tx, draft.revisionId)
  if (entry.action === 'ADD') {
    const planned = planLine(null, { itemId: next.itemId, qty: next.qty, uom: next.uom }, material, style, nextSeq(lines))
    if (!planned.ok) throw new ValidationError('The rule line is not valid.', prefixed(planned.issues, `lines/${entry.sourceKey}`))
    const id = newId()
    await writeLine(tools, target(id), planned.line, null)
    await tx.bomLine.update({ where: { id }, data: { section: next.section, sourceKey: entry.sourceKey }, select: { id: true } })
    tools.audit({ recordType: 'BomLine', recordId: id, companyId, after: { revisionId: draft.revisionId, sourceKey: entry.sourceKey, section: next.section, ...auditedLine(planned.line) } })
    return id
  }
  const current = lines.find((line) => line.id === entry.line!.id)
  if (!current) return null
  const planned = planLine(current, { itemId: next.itemId, qty: next.qty, uom: next.uom }, material, style, current.seq)
  if (!planned.ok) throw new ValidationError('The rule line is not valid.', prefixed(planned.issues, `lines/${entry.sourceKey}`))
  await writeLine(tools, target(current.id), planned.line, current)
  if (entry.changes.includes('section')) await tx.bomLine.update({ where: { id: current.id }, data: { section: next.section }, select: { id: true } })
  tools.audit({ recordType: 'BomLine', recordId: current.id, companyId, before: { section: entry.line!.section, ...auditedLine(current) }, after: { sourceKey: entry.sourceKey, section: next.section, ...auditedLine(planned.line) } })
  return current.id
}

/** POST /product/styles/:styleId/revisions/:revisionId/bom/label-lines/refresh — the plan applied to a draft (what is held stays, said). */
export async function refreshLabelLines(
  caller: CommandCaller,
  styleId: string,
  revisionId: string,
  body: { readonly version: number; readonly materials?: Readonly<Record<string, string>> | undefined },
  idempotencyKey?: string,
): Promise<{ lines: LabelLinesView; applied: { action: LinePlanEntry['action']; sourceKey: string; lineId: string }[] }> {
  const context = contextOf(caller)
  const { style } = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(context, PRODUCT_BOM_MANAGE, style.companyId)
  const picked = body.materials ?? {}

  return guarded(() =>
    bomGuarded(async () => {
      const { result } = await command(caller, { name: 'product.bomLabelLines.refresh', idempotencyKey, input: { styleId, revisionId, ...body } }, async (tools) => {
        const draft = await lockDraft(tools, styleId, revisionId, body.version)
        const facts = await readFacts(tools.tx, styleId, revisionId)
        const problems = pickedProblems(facts, picked)
        if (problems.length > 0) throw new ValidationError('The materials picked are not valid.', problems)
        const { plan } = await planOf(tools.tx, facts, picked)
        // A material the person picked that cannot be used is said, not skipped.
        const refused = plan.filter((entry) => entry.held !== null && picked[entry.sourceKey] !== undefined)
        if (refused.length > 0) throw new ValidationError('A material picked cannot be on the line.', refused.map((entry) => ({ path: `body/materials/${entry.sourceKey}`, message: entry.held! })))
        const applied: { action: LinePlanEntry['action']; sourceKey: string; lineId: string }[] = []
        // Removals first (their places free), then changes, then the new lines at the end of the BOM.
        const order = { REMOVE: 0, UPDATE: 1, ADD: 2, KEEP: 3, NEEDS_MATERIAL: 4 } as const
        for (const entry of [...planChanges(plan)].sort((a, b) => order[a.action] - order[b.action])) {
          const lineId = await apply(tools, draft, styleId, entry, style.companyId)
          if (lineId) applied.push({ action: entry.action, sourceKey: entry.sourceKey, lineId })
        }
        recordChange(tools, draft, applied.map((entry) => entry.lineId), { labelLines: applied.map((entry) => ({ action: entry.action, sourceKey: entry.sourceKey, line: entry.lineId })) })
        const after = await readFacts(tools.tx, styleId, revisionId)
        const next = await planOf(tools.tx, { ...after, revision: { ...after.revision, version: draft.version } }, {})
        return { lines: await viewOf(tools.tx, { ...after, revision: { ...after.revision, version: draft.version } }, next.plan, next.materials), applied }
      })
      return result
    }),
  )
}
