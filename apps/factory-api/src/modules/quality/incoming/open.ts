import type { Uom } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { InspectionLevel } from '@nexus/factory-domain/quality/aql/iso2859'
import { reasonProblem } from '@nexus/factory-domain/quality/aql/profiles'
import { acceptanceOf, aqlStored, levelText } from '@nexus/factory-domain/quality/aql/sampling'
import { QUALITY_INCOMING_RECORD, QUALITY_INCOMING_VIEW } from '@nexus/factory-domain/quality/incoming/permissions'
import { INCOMING_LIMITS, sampleWords, secondOpenWords } from '@nexus/factory-domain/quality/incoming/rules'
import { chipsMatch, type Chip } from '@nexus/factory-domain/quality/plans/rules'
import { dimensionOf } from '@nexus/factory-domain/product/units/units'
import { Dec, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { allocateNumber, assertNumberUniqueInTenant } from '../../../platform/numbering/allocate'
import { assertFloorReady } from '../../production/serials/facts'
import { aqlPlanFor } from '../aql/chain'
import { chipsOf } from '../plans/store'
import { postedBy, signerOf } from '../final/access'
import { incomingView } from './views'
import { lotFor, readIncoming, type LotRow, type Reader } from './store'
// The lot's lock: THE SAME KEY as the inspection triggers' handler (B-W2b-101), so a person and a rule never open two of one lot.
import { lockIncomingSubject } from '../triggers/open'

/**
 * Scanning a lot and opening its incoming inspection (B-W2b-98; QHS-025 "Leather lot sampling"; design floor.incoming
 * "Scan the lot: scanning opens the inspection with its plan", "Sample: how many hides to inspect, whole"; Rule 1: every
 * delivery). Office and the site's inspection tablet alike (quality.incoming.record over the lot's company and site).
 *
 *   GET  /quality/incoming/lots/:lotId   the lot, its OPEN inspection when there is one, else what opening would give:
 *                                        the plan that applies, the sample in words, or why nothing can open (in words).
 *   POST /quality/incoming               { lotId, planId?, profileId?, reason?, note? } → 201 the record. ONE command:
 *                                        the lot's lock (the same key as the inspection triggers' handler, B-W2b-101),
 *                                        a second OPEN inspection of the lot refused in words (B-W2b-76: the database
 *                                        does not refuse it); the plan named, else the one INCOMING plan with an APPROVED
 *                                        version whose "applies to" fits the lot (the most specific); its APPROVED
 *                                        version frozen on the record; the lot counted in hides when it has hides (else
 *                                        what its receipt brought in, in its unit); the sample: a fixed sample, or ISO
 *                                        2859-1's from the AQL profile that applies (aqlPlanFor: the plan version's, the
 *                                        company default; a lot has no style or customer), a profile other than that one
 *                                        only with the reason (kept on the audit row), the whole lot when no profile
 *                                        applies (said on the record); numbered from the company's INCOMING_INSPECTION
 *                                        series (office or tablet); the opener its inspector.
 */

interface Size {
  readonly lotSize: Decimal
  readonly uom: Uom
  /** Counted in units (hides, pieces): an AQL sample can be drawn. */
  readonly countable: boolean
  readonly hides: number
}

/** What the decision counts in: the lot's hides (HIDE) when it has hides, else what its receipt moved in, in its unit. */
async function sizeOf(db: Reader, lot: LotRow): Promise<Size | null> {
  const hides = await db.hide.count({ where: { lotId: lot.id } })
  if (hides > 0) return { lotSize: new Dec(hides), uom: 'HIDE', countable: true, hides }
  const moves = await db.stockMove.findMany({ where: { lotId: lot.id, reason: 'RECEIPT', hideId: null, reversalOfId: null }, select: { quantity: true, uom: true }, orderBy: { id: 'asc' } })
  if (moves.length === 0) return null
  const uom = moves[0]!.uom
  const lotSize = moves.filter((move) => move.uom === uom).reduce<Decimal>((sum, move) => sum.plus(move.quantity.toString()), new Dec(0))
  if (lotSize.lessThanOrEqualTo(0)) return null
  return { lotSize, uom, countable: ['COUNT', 'ITEM'].includes(dimensionOf(uom)), hides: 0 }
}

interface Chosen {
  readonly plan: { readonly id: string; readonly code: string; readonly name: string }
  readonly version: { readonly id: string; readonly number: number; readonly samplingMethod: string; readonly fixedSampleSize: number | null }
  readonly because: readonly Chip[]
}

/** The plan the lot is inspected on: the one named, else the most specific INCOMING plan with an APPROVED version that fits. */
async function choosePlan(db: Reader, lot: LotRow, planId: string | null | undefined): Promise<Chosen | { readonly refusal: string; readonly path: string | null }> {
  const plans = await db.inspectionPlan.findMany({ where: { companyId: lot.companyId, stage: 'INCOMING' }, select: { id: true, code: true, name: true, appliesTo: true }, orderBy: { code: 'asc' } })
  const versions = plans.length ? await db.inspectionPlanVersion.findMany({ where: { planId: { in: plans.map((plan) => plan.id) }, status: 'APPROVED' }, select: { id: true, planId: true, number: true, samplingMethod: true, fixedSampleSize: true } }) : []
  const approved = new Map(versions.map((version) => [version.planId, version]))
  const facts = { MATERIAL: [lot.itemId], SUPPLIER: [lot.supplierId], CATEGORY: [lot.item.kind] }
  if (planId) {
    const plan = plans.find((entry) => entry.id === planId)
    if (!plan) return { refusal: "Not an incoming inspection plan of the lot's company.", path: 'body/planId' }
    const version = approved.get(plan.id)
    if (!version) return { refusal: `Plan ${plan.code} has no approved version: a second person approves a version before an inspection runs on it.`, path: 'body/planId' }
    return { plan, version, because: chipsMatch(chipsOf(plan.appliesTo), facts).because }
  }
  const fits = plans.flatMap((plan) => {
    const version = approved.get(plan.id)
    const match = chipsMatch(chipsOf(plan.appliesTo), facts)
    return version && match.matches ? [{ plan, version, because: match.because }] : []
  })
  if (fits.length === 0) return { refusal: `No approved incoming plan applies to lot ${lot.code} (${lot.item.code}): name the plan to inspect it on.`, path: null }
  const most = Math.max(...fits.map((fit) => fit.because.length))
  const best = fits.filter((fit) => fit.because.length === most)
  if (best.length > 1) return { refusal: `Several incoming plans apply to lot ${lot.code} as closely (${best.map((fit) => fit.plan.code).join(', ')}): name the one to inspect it on.`, path: null }
  return best[0]!
}

interface Sampling {
  readonly aqlProfileId: string | null
  readonly codeLetter: string | null
  readonly sampleSize: number
  readonly inspectionLevel: string | null
  readonly aqlMajor: string | null
  readonly aqlMinor: string | null
  readonly acceptMajor: number | null
  readonly acceptMinor: number | null
  readonly note: string | null
  readonly named: boolean
  readonly profileCode: string | null
  readonly words: string | null
}

/** The sample of the lot on the plan version: a fixed number, ISO 2859-1's from the profile that applies, or the whole lot. */
async function samplingOf(db: Reader, lot: LotRow, chosen: Chosen, size: Size, profileId: string | null | undefined): Promise<Sampling | { readonly refusal: string }> {
  const whole = size.lotSize.isInteger() ? Number(size.lotSize.toFixed(0)) : null
  if (chosen.version.samplingMethod === 'FIXED') {
    if (!whole || whole < 1) return { refusal: `Lot ${lot.code} is ${size.lotSize.toFixed()} ${size.uom}: a fixed sample needs the lot counted in whole units.` }
    if (profileId) return { refusal: `Plan ${chosen.plan.code} v${chosen.version.number} samples a fixed number of units: no AQL profile applies.` }
    return { aqlProfileId: null, codeLetter: null, sampleSize: Math.min(chosen.version.fixedSampleSize ?? 1, whole), inspectionLevel: null, aqlMajor: null, aqlMinor: null, acceptMajor: null, acceptMinor: null, note: null, named: false, profileCode: null, words: null }
  }
  if (!size.countable || !whole || whole < 1) return { refusal: `Lot ${lot.code} is counted in ${size.uom}: an AQL sample needs units (hides, pieces); inspect it on a plan with a fixed sample.` }
  const answer = await aqlPlanFor(db, { companyId: lot.companyId, planVersionId: chosen.version.id, styleId: null, customerIds: [], lotSize: whole, profileId: profileId ?? null, at: 'body/profileId' })
  if (!answer.plan || !answer.profile) {
    if (profileId) return { refusal: 'The plan version samples a fixed number of units: no AQL profile applies.' }
    return { aqlProfileId: null, codeLetter: null, sampleSize: whole, inspectionLevel: null, aqlMajor: null, aqlMinor: null, acceptMajor: null, acceptMinor: null, note: 'No AQL profile applies to this lot (no company default): the whole lot is inspected.', named: false, profileCode: null, words: null }
  }
  const plan = answer.plan
  const aql = (defectClass: 'MAJOR' | 'MINOR') => aqlStored(plan.classes.find((entry) => entry.defectClass === defectClass)!.aql)
  return {
    aqlProfileId: answer.profile.id,
    codeLetter: plan.codeLetter,
    sampleSize: plan.sampleSize,
    inspectionLevel: levelText(plan.level as InspectionLevel),
    aqlMajor: aql('MAJOR'),
    aqlMinor: aql('MINOR'),
    ...acceptanceOf(plan),
    note: null,
    named: answer.named,
    profileCode: answer.profile.code,
    words: plan.words,
  }
}

/** GET /quality/incoming/lots/:lotId — the scan of a lot. */
export async function scanLot(caller: CommandCaller, lotId: string) {
  const { lot, context } = await lotFor(caller, lotId, QUALITY_INCOMING_VIEW)
  return caller.withClient(async (db) => {
    const open = await db.incomingInspection.findFirst({ where: { lotId: lot.id, status: 'OPEN' }, select: { id: true }, orderBy: { id: 'asc' } })
    const decided = await db.incomingInspection.count({ where: { lotId: lot.id, status: 'DECIDED' } })
    const head = { id: lot.id, code: lot.code, qualityStatus: lot.qualityStatus, dyeBatch: lot.dyeBatch, supplierLotRef: lot.supplierLotRef, item: { id: lot.item.id, code: lot.item.code, name: lot.item.name }, colour: lot.itemColour }
    if (open) return { lot: head, decided, open: await incomingView(db, (await readIncoming(db, open.id))!, lot, context), opening: null }
    const size = await sizeOf(db, lot)
    const chosen = await choosePlan(db, lot, null)
    let opening: { plan: { planId: string; code: string; name: string; versionId: string; number: number } | null; lotSize: string | null; uom: string | null; sampleSize: number | null; words: { it: string; en: string } | null; refusal: string | null }
    if (!size) opening = { plan: null, lotSize: null, uom: null, sampleSize: null, words: null, refusal: `Lot ${lot.code} has nothing received to inspect.` }
    else if ('refusal' in chosen) opening = { plan: null, lotSize: size.lotSize.toFixed(4), uom: size.uom, sampleSize: null, words: null, refusal: chosen.refusal }
    else {
      const sampling = await samplingOf(db, lot, chosen, size, null).catch((error: unknown) => ({ refusal: error instanceof Error ? error.message : String(error) }))
      const plan = { planId: chosen.plan.id, code: chosen.plan.code, name: chosen.plan.name, versionId: chosen.version.id, number: chosen.version.number }
      opening =
        'refusal' in sampling
          ? { plan, lotSize: size.lotSize.toFixed(4), uom: size.uom, sampleSize: null, words: null, refusal: sampling.refusal }
          : { plan, lotSize: size.lotSize.toFixed(4), uom: size.uom, sampleSize: sampling.sampleSize, words: sampleWords(sampling.sampleSize, size.lotSize.toFixed(), size.uom, null), refusal: lot.qualityStatus === 'REJECTED' ? `Lot ${lot.code} is rejected: there is nothing left to inspect.` : null }
    }
    return { lot: head, decided, open: null, opening }
  })
}

export interface OpenBody {
  readonly lotId: string
  readonly planId?: string | null | undefined
  readonly profileId?: string | null | undefined
  readonly reason?: string | null | undefined
  readonly note?: string | null | undefined
}

const invalid = (problems: readonly Issue[], words: string) => new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems.map((problem) => ({ ...problem, path: problem.path.startsWith('body/') ? problem.path : `body/${problem.path}` })))

/** The inspection's number from the company's series, in words when the company has none (409). */
async function numberOf(tools: CommandTools, companyId: string, id: string): Promise<string> {
  try {
    const issued = await allocateNumber(tools, { companyId, kind: 'INCOMING_INSPECTION' }, { type: 'IncomingInspection', id })
    await assertNumberUniqueInTenant(tools, issued)
    return issued.formatted
  } catch (error) {
    if (error instanceof NotFoundError) throw new InvalidStateError(`${error.message} (incoming inspections are numbered from it).`)
    throw error
  }
}

/** POST /quality/incoming */
export async function openIncoming(caller: CommandCaller, body: OpenBody, idempotencyKey: string | undefined) {
  const { lot, context } = await lotFor(caller, body.lotId, QUALITY_INCOMING_RECORD)
  if (context.audience === 'floor') await assertFloorReady(caller, lot.siteId)
  const note = body.note?.trim() || null
  if (note && note.length > INCOMING_LIMITS.note) throw invalid([{ path: 'note', message: `At most ${INCOMING_LIMITS.note} characters.` }], 'The inspection is not valid.')
  if (body.planId && !isUuid(body.planId)) throw invalid([{ path: 'planId', message: "Not an incoming inspection plan of the lot's company." }], 'The plan is not found.')
  const { result } = await command(caller, { name: 'quality.incoming.open', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    // One opener of a lot at a time (a person or a rule): the OPEN count read under the lock is the truth.
    await lockIncomingSubject(tx, lot.id)
    const open = await tx.incomingInspection.findFirst({ where: { lotId: lot.id, status: 'OPEN' }, select: { number: true }, orderBy: { id: 'asc' } })
    if (open) throw new ConflictError(secondOpenWords(lot.code, open.number))
    const current = (await tx.lot.findUnique({ where: { id: lot.id }, select: { qualityStatus: true } }))!
    if (current.qualityStatus === 'REJECTED') throw new InvalidStateError(`Lot ${lot.code} is rejected: there is nothing left to inspect.`)
    const size = await sizeOf(tx, lot)
    if (!size) throw new InvalidStateError(`Lot ${lot.code} has nothing received to inspect.`)
    const chosen = await choosePlan(tx, lot, body.planId)
    if ('refusal' in chosen) {
      if (chosen.path) throw invalid([{ path: chosen.path, message: chosen.refusal }], chosen.refusal)
      throw new InvalidStateError(chosen.refusal)
    }
    const sampling = await samplingOf(tx, lot, chosen, size, body.profileId)
    if ('refusal' in sampling) throw new InvalidStateError(sampling.refusal)
    const problems: Issue[] = []
    if (sampling.named) {
      const issue = reasonProblem(body.reason)
      if (issue) problems.push({ ...issue, message: `${sampling.profileCode} is not the profile that applies: say why. ${issue.message}` })
    } else if (body.reason?.trim()) problems.push({ path: 'reason', message: 'This is the sample the plan gives: no reason is needed.' })
    if (problems.length > 0) throw invalid(problems, 'The inspection cannot open.')
    const id = newId()
    const number = await numberOf(tools, lot.companyId, id)
    const signer = signerOf(context)
    await tx.incomingInspection.create({
      data: {
        id,
        companyId: lot.companyId,
        siteId: lot.siteId,
        number,
        lotId: lot.id,
        itemId: lot.itemId,
        planVersionId: chosen.version.id,
        aqlProfileId: sampling.aqlProfileId,
        codeLetter: sampling.codeLetter,
        lotSize: size.lotSize.toFixed(4),
        uom: size.uom,
        sampleSize: sampling.sampleSize,
        inspectionLevel: sampling.inspectionLevel,
        aqlMajor: sampling.aqlMajor,
        aqlMinor: sampling.aqlMinor,
        acceptMajor: sampling.acceptMajor,
        acceptMinor: sampling.acceptMinor,
        inspectorWorkerId: signer.workerId,
        inspectorUserId: signer.userId,
        note: [sampling.note, note].filter(Boolean).join(' ') || null,
        createdAt: now,
        updatedAt: now,
        createdById: context.actorId,
      },
      select: { id: true },
    })
    tools.audit({
      recordType: 'IncomingInspection',
      recordId: id,
      companyId: lot.companyId,
      siteId: lot.siteId,
      after: {
        number,
        lotId: lot.id,
        lotCode: lot.code,
        plan: `${chosen.plan.code} v${chosen.version.number}`,
        planVersionId: chosen.version.id,
        because: chosen.because,
        lotSize: size.lotSize.toFixed(4),
        uom: size.uom,
        sampleSize: sampling.sampleSize,
        aqlProfileId: sampling.aqlProfileId,
        codeLetter: sampling.codeLetter,
        sampling: sampling.words,
        status: 'OPEN',
        inspector: postedBy(context),
      },
      // A profile other than the one that applies: the reason lives on the audit row (B-W2b-93's rule; no column keeps it).
      ...(sampling.named ? { reason: body.reason!.trim() } : {}),
    })
    tools.emit({
      type: 'incoming_inspection.opened',
      subject: id,
      companyId: lot.companyId,
      siteId: lot.siteId,
      payload: { incomingInspectionId: id, number, lotId: lot.id, itemId: lot.itemId, planVersionId: chosen.version.id, lotSize: size.lotSize.toFixed(4), uom: size.uom, sampleSize: sampling.sampleSize, postedBy: postedBy(context) },
    })
    return { id }
  })
  return caller.withClient(async (db) => incomingView(db, (await readIncoming(db, result.id))!, lot, context))
}
