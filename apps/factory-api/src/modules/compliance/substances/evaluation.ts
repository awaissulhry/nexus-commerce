import type { FastifyRequest } from 'fastify'
import { evaluateMaterial, styleRollUp, type MaterialEvaluation, type RuleFacts, type RuleVerdict, type StyleUse, type SvhcAnswer } from '@nexus/factory-domain/compliance/substances/evaluate'
import { SUBSTANCES_MANAGE, SUBSTANCES_VIEW } from '@nexus/factory-domain/compliance/substances/permissions'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, holds, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import type { Prisma } from '@nexus/factory-db'
import { runCommand, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayWrite } from '../../product/materials/store'
import { STYLE_SCOPE } from '../../product/styles/store'
import { officeOf } from '../register-of-rules/common'
import { substancesClock, substancesGuarded, substancesSettings } from './common'
import {
  declarationsOf,
  listVersionFacts,
  marketsFor,
  MATERIAL_SELECT,
  materialFacts,
  PROFILE_SELECT,
  profilesOf,
  profileView,
  ruleFacts,
  savedSvhc,
  styleUse,
  svhcSubstances,
  testsOf,
  todayOf,
  usesOf,
  versionsById,
  type MaterialRow,
  type Reader,
} from './store'

/**
 * What the evaluator says (B-W2b-250; PRD-320 … PRD-326, PRD-329; design compliance.tests › Material profiles and the
 * material record's Compliance tab): per material, and per style that uses it, which rule applies, what evidence it needs
 * and whether it is met (factory-domain compliance/substances/evaluate), and the SVHC roll-up per component of a style
 * above 0.1 % w/w (REACH art. 33). Reading needs compliance.certificates.view over the material's or style's company;
 * writing the result into the materials' compliance profiles (ONE update each: the rules, tests and declarations it needs
 * with the time it ran, its state and reason, and the SVHC answer of the newest accepted SVHC declaration) needs
 * compliance.substances.manage over the material's company (a tenant-wide material: every company).
 *
 * The evaluator reads every rule and every style that uses the material, whoever asks (a rule applies or not whatever a
 * person may read); the answer lists only the styles the person reads (product.styles.view).
 */

export const EVALUATE_LIMIT = 100

interface Facts {
  readonly rules: readonly RuleFacts[]
  readonly versions: Awaited<ReturnType<typeof versionsById>>
  readonly svhc: Awaited<ReturnType<typeof svhcSubstances>>
}

const factsOf = async (db: Reader): Promise<Facts> => ({ rules: await ruleFacts(db), versions: await versionsById(db), svhc: await svhcSubstances(db) })

/** The evaluation of each material (`only`: one style's context for all; `marketCode`: that market instead of the switched-on ones). */
async function evaluateAll(db: Reader, materials: readonly MaterialRow[], today: string, options: { readonly only?: StyleUse; readonly marketCode?: string } = {}): Promise<Map<string, { evaluation: MaterialEvaluation; uses: StyleUse[]; markets: string[] }>> {
  const ids = materials.map((material) => material.id)
  const facts = await factsOf(db)
  const uses = options.only ? new Map(ids.map((id) => [id, [options.only!]])) : await usesOf(db, ids)
  const tests = await testsOf(db, ids)
  const declarations = await declarationsOf(db, ids)
  const profiles = await profilesOf(db, ids)
  const marketCache = new Map<string, string[]>()
  const out = new Map<string, { evaluation: MaterialEvaluation; uses: StyleUse[]; markets: string[] }>()
  for (const material of materials) {
    const used = uses.get(material.id) ?? []
    const companies = [material.companyId, ...used.map((use) => use.companyId)]
    const cacheKey = companies.map(String).sort().join('|')
    let markets = options.marketCode ? [options.marketCode] : marketCache.get(cacheKey)
    if (!markets) {
      markets = await marketsFor(db, companies)
      marketCache.set(cacheKey, markets)
    }
    const evaluation = evaluateMaterial({
      material: materialFacts(material),
      uses: used,
      markets,
      rules: facts.rules,
      tests: tests.get(material.id) ?? [],
      declarations: declarations.get(material.id) ?? [],
      listVersions: listVersionFacts(facts.versions.values()),
      svhcSubstanceIds: new Set(facts.svhc.keys()),
      saved: savedSvhc(profiles.get(material.id)),
      today,
    })
    out.set(material.id, { evaluation, uses: used, markets })
  }
  return out
}

/** The SVHC answer as the routes say it: the substances by CAS number and name. */
function svhcView(answer: SvhcAnswer, svhc: Facts['svhc']) {
  return {
    aboveThreshold: answer.aboveThreshold,
    substances: answer.substanceIds.map((id) => {
      const substance = svhc.get(id)
      return { id, casNumber: substance?.casNumber ?? null, name: substance?.name ?? '?' }
    }),
    unnamed: [...answer.unnamed],
    listVersion: answer.listVersion,
    newestVersion: answer.newestVersion,
    current: answer.current,
    grewBy: answer.grewBy,
    source: answer.source,
    request: answer.request,
    asked: answer.asked,
  }
}

/** A verdict as the routes say it: the styles narrowed to those the person reads. */
const verdictView = (verdict: RuleVerdict, readable: ReadonlySet<string>) => ({ ...verdict, styleIds: verdict.styleIds.filter((id) => readable.has(id)), needs: { ...verdict.needs }, proof: verdict.proof ? { ...verdict.proof } : null, asked: verdict.asked ? { ...verdict.asked } : null })

/** The styles among these the person reads (none without product.styles.view). */
async function readableStyles(db: Reader, actor: Actor, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0 || !holds(actor, PRODUCT_STYLES_VIEW)) return new Set()
  const rows = await db.style.findMany({ where: { AND: [{ id: { in: [...new Set(ids)] } }, scopeWhere(actor, PRODUCT_STYLES_VIEW, STYLE_SCOPE) as Prisma.StyleWhereInput] }, select: { id: true } })
  return new Set(rows.map((row) => row.id))
}

async function readMaterialRow(db: Reader, actor: Actor, materialId: string): Promise<MaterialRow> {
  const row = isUuid(materialId) ? await db.item.findUnique({ where: { id: materialId }, select: MATERIAL_SELECT }) : null
  if (!row || row.kind === 'FINISHED' || !can(actor, SUBSTANCES_VIEW, { companyId: row.companyId })) throw new NotFoundError('Material not found.')
  return row
}

export interface MaterialQuery {
  readonly marketCode?: string | undefined
}

/** GET /compliance/substances/materials/:materialId/evaluation — what the evaluator says now (nothing written). */
export async function materialEvaluation(request: FastifyRequest, materialId: string, query: MaterialQuery) {
  const actor = actorOf(officeOf(request))
  const now = substancesClock().now()
  return request.withClient(async (db) => {
    const material = await readMaterialRow(db, actor, materialId)
    const facts = await factsOf(db)
    const { evaluation, uses, markets } = (await evaluateAll(db, [material], todayOf(now), { ...(query.marketCode ? { marketCode: query.marketCode } : {}) })).get(material.id)!
    const readable = await readableStyles(db, actor, uses.map((use) => use.styleId))
    const profile = (await profilesOf(db, [material.id])).get(material.id)
    return {
      material: { id: material.id, code: material.code, name: material.name, kind: material.kind, companyId: material.companyId },
      uses: uses.filter((use) => readable.has(use.styleId)).map((use) => ({ ...use })),
      markets,
      rules: evaluation.rules.map((verdict) => verdictView(verdict, readable)),
      applicableRuleIds: [...evaluation.applicableRuleIds],
      testsNeeded: [...evaluation.testsNeeded],
      declarationsNeeded: [...evaluation.declarationsNeeded],
      svhc: svhcView(evaluation.svhc, facts.svhc),
      state: evaluation.state,
      stateReason: evaluation.stateReason,
      profile: profileView(profile),
      mayEvaluate: mayWrite(actor, SUBSTANCES_MANAGE, material.companyId),
      asOf: toUtcIso(now),
    }
  })
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((value, index) => value === b[index])

/**
 * POST /compliance/substances/materials/evaluate {itemIds} — runs the evaluator and writes each material's compliance
 * profile (made with the item's id when it has none) in ONE command, one update per profile.
 */
export async function evaluateMaterials(caller: CommandCaller, body: { readonly itemIds: readonly string[] }, key: string | null | undefined) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const ids = [...new Set(body.itemIds)]
  const { result } = await substancesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.substances.evaluate', idempotencyKey: key, input: { itemIds: ids } },
      async ({ tx, now, audit, emit }) => {
        const materials = await tx.item.findMany({ where: { id: { in: ids } }, select: MATERIAL_SELECT })
        const byId = new Map(materials.map((material) => [material.id, material]))
        ids.forEach((id, index) => {
          const material = byId.get(id)
          if (!material || material.kind === 'FINISHED' || !can(actor, SUBSTANCES_VIEW, { companyId: material.companyId })) {
            throw new ValidationError('A material to evaluate is not valid.', [{ path: `body/itemIds/${index}`, message: 'Not a material (a finished garment has no compliance profile).' }])
          }
          if (!mayWrite(actor, SUBSTANCES_MANAGE, material.companyId)) {
            throw new ForbiddenError(material.companyId === null ? `${material.code} is a material for every company: its profile is written only by a role over every company.` : `You may not write ${material.code}'s compliance profile.`)
          }
        })
        // The profiles FOR UPDATE, in id order (a concurrent evaluation of the same materials waits, never deadlocks).
        const sorted = [...ids].sort()
        await tx.$queryRaw`SELECT "id" FROM "MaterialComplianceProfile" WHERE "id" = ANY(${sorted}::uuid[]) ORDER BY "id" FOR UPDATE`
        const evaluated = await evaluateAll(tx, ids.map((id) => byId.get(id)!), todayOf(now))
        const before = await profilesOf(tx, ids)
        const profiles = []
        for (const id of ids) {
          const material = byId.get(id)!
          const { evaluation } = evaluated.get(id)!
          const previous = before.get(id)
          const svhc = evaluation.svhc
          const takesSvhc = svhc.source === 'DECLARATION' && svhc.aboveThreshold !== null && svhc.listVersion !== null
          const data = {
            applicableRuleIds: [...evaluation.applicableRuleIds],
            testsNeeded: [...evaluation.testsNeeded],
            declarationsNeeded: [...evaluation.declarationsNeeded],
            evaluatedAt: now,
            state: evaluation.state,
            stateReason: evaluation.stateReason,
            ...(takesSvhc ? { svhcAboveThreshold: svhc.aboveThreshold, svhcListVersionId: svhc.listVersion!.id, svhcSubstanceIds: [...svhc.substanceIds] } : {}),
            updatedAt: now,
          }
          const row = previous
            ? await tx.materialComplianceProfile.update({ where: { id }, data: { ...data, version: { increment: 1 } }, select: PROFILE_SELECT })
            : await tx.materialComplianceProfile.create({ data: { id, itemId: id, ...data, createdAt: now, createdById: context.actorId }, select: PROFILE_SELECT })
          const shown = (profile: typeof row | undefined) =>
            profile
              ? {
                  state: profile.state,
                  stateReason: profile.stateReason,
                  applicableRuleIds: [...profile.applicableRuleIds],
                  testsNeeded: [...profile.testsNeeded],
                  declarationsNeeded: [...profile.declarationsNeeded],
                  svhcAboveThreshold: profile.svhcAboveThreshold,
                  svhcListVersionId: profile.svhcListVersionId,
                  svhcSubstanceIds: [...profile.svhcSubstanceIds],
                }
              : null
          audit({ recordType: 'MaterialComplianceProfile', recordId: id, companyId: material.companyId, before: shown(previous), after: shown(row) })
          emit({
            type: 'compliance_substances.profile_evaluated',
            subject: id,
            companyId: material.companyId,
            payload: {
              itemId: id,
              state: evaluation.state,
              previousState: (previous?.state as 'INCOMPLETE' | 'COMPLETE' | 'BLOCKED' | undefined) ?? null,
              rules: evaluation.applicableRuleIds.length,
              testsNeeded: [...evaluation.testsNeeded],
              declarationsNeeded: [...evaluation.declarationsNeeded],
              svhcAboveThreshold: row.svhcAboveThreshold,
            },
          })
          profiles.push({
            itemId: id,
            code: material.code,
            name: material.name,
            state: evaluation.state,
            previousState: (previous?.state as 'INCOMPLETE' | 'COMPLETE' | 'BLOCKED' | undefined) ?? null,
            stateReason: evaluation.stateReason,
            applicableRules: evaluation.applicableRuleIds.length,
            testsNeeded: [...evaluation.testsNeeded],
            declarationsNeeded: [...evaluation.declarationsNeeded],
            svhcAboveThreshold: row.svhcAboveThreshold,
            changed: !previous || previous.state !== row.state || !sameList(previous.applicableRuleIds, row.applicableRuleIds) || previous.svhcAboveThreshold !== row.svhcAboveThreshold,
            version: row.version,
          })
        }
        return { profiles, evaluatedAt: toUtcIso(now) }
      },
      substancesSettings(),
    ),
  )
  return result
}

export interface StyleQuery {
  readonly revisionId?: string | undefined
  readonly marketCode?: string | undefined
}

/**
 * GET /compliance/substances/styles/:styleId/evaluation — per component of the style revision (the material of each BOM
 * line and each alternate) every rule's verdict in the style's own context, and the SVHC roll-up per component (REACH
 * art. 33: a component above 0.1 % w/w is an article whose SVHCs every recipient is told of). The revision: the one asked,
 * else the RELEASED one, else the newest draft, else the newest.
 */
export async function styleEvaluation(request: FastifyRequest, styleId: string, query: StyleQuery) {
  const actor = actorOf(officeOf(request))
  const now = substancesClock().now()
  return request.withClient(async (db) => {
    const style = isUuid(styleId) ? await db.style.findUnique({ where: { id: styleId }, select: { id: true, code: true, name: true, productType: true, ppeCategory: true, brandPartyId: true, companyId: true } }) : null
    if (!style || !can(actor, SUBSTANCES_VIEW, { companyId: style.companyId })) throw new NotFoundError('Style not found.')
    const revisions = await db.styleRevision.findMany({ where: { styleId }, select: { id: true, revision: true, status: true }, orderBy: { revision: 'desc' } })
    let revision = revisions.find((row) => row.status === 'RELEASED') ?? revisions.find((row) => row.status === 'DRAFT') ?? revisions[0] ?? null
    if (query.revisionId !== undefined) {
      revision = revisions.find((row) => row.id === query.revisionId) ?? null
      if (!revision) throw new ValidationError('The revision is not valid.', [{ path: 'querystring/revisionId', message: 'Not a revision of the style.' }])
    }
    if (!revision) throw new NotFoundError(`Style ${style.code} has no revision yet: its BOM is what the substance checks read.`)
    const lines = await db.bomLine.findMany({ where: { revisionId: revision.id }, select: { id: true, seq: true, placement: true, itemId: true }, orderBy: { seq: 'asc' } })
    const alternates = await db.bomLineAlternate.findMany({ where: { revisionId: revision.id }, select: { bomLineId: true, priority: true, itemId: true }, orderBy: [{ priority: 'asc' }] })
    const itemIds = [...new Set([...lines.map((line) => line.itemId), ...alternates.map((alternate) => alternate.itemId)])]
    const materials = (itemIds.length === 0 ? [] : await db.item.findMany({ where: { id: { in: itemIds } }, select: MATERIAL_SELECT })).filter((material) => material.kind !== 'FINISHED')
    const byId = new Map(materials.map((material) => [material.id, material]))
    const use = styleUse(style)
    const evaluated = await evaluateAll(db, materials, todayOf(now), { only: use, ...(query.marketCode ? { marketCode: query.marketCode } : {}) })
    const facts = await factsOf(db)
    const readable = new Set([style.id])
    const components = [
      ...lines.map((line) => ({ lineId: line.id, seq: line.seq, placement: line.placement, role: 'LINE' as const, priority: null as number | null, itemId: line.itemId })),
      ...alternates.map((alternate) => {
        const line = lines.find((entry) => entry.id === alternate.bomLineId)
        return { lineId: alternate.bomLineId, seq: line?.seq ?? 0, placement: line?.placement ?? null, role: 'ALTERNATE' as const, priority: alternate.priority as number | null, itemId: alternate.itemId }
      }),
    ]
      .filter((component) => byId.has(component.itemId))
      .sort((a, b) => a.seq - b.seq || (a.priority ?? 0) - (b.priority ?? 0))
    const rollUp = styleRollUp(materials.map((material) => ({ materialId: material.id, svhc: evaluated.get(material.id)!.evaluation.svhc })))
    const states = materials.map((material) => evaluated.get(material.id)!.evaluation.state)
    return {
      style: { id: style.id, code: style.code, name: style.name, productType: style.productType, ppeCategory: style.ppeCategory, brandPartyId: style.brandPartyId, companyId: style.companyId },
      revision: { id: revision.id, revision: revision.revision, status: revision.status },
      markets: evaluated.size > 0 ? [...evaluated.values()][0]!.markets : query.marketCode ? [query.marketCode] : await marketsFor(db, [style.companyId]),
      components: components.map((component) => {
        const material = byId.get(component.itemId)!
        const { evaluation } = evaluated.get(material.id)!
        return {
          lineId: component.lineId,
          seq: component.seq,
          placement: component.placement,
          role: component.role,
          priority: component.priority,
          material: { id: material.id, code: material.code, name: material.name, kind: material.kind },
          rules: evaluation.rules.filter((verdict) => verdict.status !== 'NOT_APPLICABLE').map((verdict) => verdictView(verdict, readable)),
          notApplicable: evaluation.rules.filter((verdict) => verdict.status === 'NOT_APPLICABLE').map((verdict) => ({ ruleId: verdict.ruleId, key: verdict.key, why: verdict.why!, words: verdict.words })),
          testsNeeded: [...evaluation.testsNeeded],
          declarationsNeeded: [...evaluation.declarationsNeeded],
          state: evaluation.state,
          stateReason: evaluation.stateReason,
          svhc: svhcView(evaluation.svhc, facts.svhc),
        }
      }),
      summary: {
        materials: materials.length,
        blocked: states.filter((state) => state === 'BLOCKED').length,
        incomplete: states.filter((state) => state === 'INCOMPLETE').length,
        complete: states.filter((state) => state === 'COMPLETE').length,
      },
      svhc: {
        article33: rollUp.article33,
        substances: rollUp.substanceIds.map((id) => {
          const substance = facts.svhc.get(id)
          return { id, casNumber: substance?.casNumber ?? null, name: substance?.name ?? '?' }
        }),
        above: rollUp.above,
        none: rollUp.none,
        unknown: rollUp.unknown,
        stale: rollUp.stale,
        newestVersion: [...listVersionFacts(facts.versions.values())].sort((a, b) => b.publishedOn.localeCompare(a.publishedOn))[0] ?? null,
      },
      asOf: toUtcIso(now),
    }
  })
}
