import { NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { RoutingDepthView, StepCheckpointBody, StepDepthView, StepSettingsBody, StepVariantsBody } from '@nexus/factory-domain/product/routing-depth/contracts'
import { checkpointRefusal, effectiveDays, NO_OPTIONS_YET, planSettings, planVariants, sameSettings, sameVariants, type SettingData } from '@nexus/factory-domain/product/routing-depth/rules'
import { PRODUCT_ROUTING_MANAGE } from '@nexus/factory-domain/product/routing/permissions'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { STYLE_COLUMNS, type BomStyleRow, type RevisionRow } from '../bom/store'
import { mayWrite } from '../materials/store'
// B-W2b-229: the options a step may be only for (the style's offered active options).
import { offeredValuesOf, optionLabelsOf } from '../options/offers'
import { assertMayWrite, contextOf, lockDraft, lockOperations, readRevisionFor, type LockedDraft } from '../routing/store'
import {
  auditedSettings,
  checkpointViewOf,
  depthGuarded,
  readColourwaysOf,
  readDepthSteps,
  readMachineClasses,
  readPlans,
  readSettings,
  REVISION_DAY_COLUMNS,
  revisionDaysOf,
  settingDataOf,
  settingViewOf,
  variantsOfRow,
  variantsViewOf,
  type DepthRow,
  type Db,
} from './store'

/**
 * A draft routing's steps in depth (B-W2b-225; PRD-118, PRD-119, PRD-128; design products.styles › Operations (routing):
 * "Quality checkpoint (W2b)", "Only for sizes, colours or options (W2b)", the operation drawer's "Sizes, colours, options
 * it runs for (W2b)"; products.operations › Machine & settings for a step of this style):
 *
 *   GET …/routing/depth                         every step's variants, checkpoint and settings, the revision's days
 *   PUT …/routing/steps/:stepId/variants        the sizes, colourways and options it is for (B-W2b-229: active options of
 *                                               a group the style offers); empty lists: every cell
 *   PUT …/routing/steps/:stepId/checkpoint      a cutting, in-line or end-of-line plan of the style's company; null: none
 *   PUT …/routing/steps/:stepId/settings        the whole list, or `fromLibrary` (a copy of the library operation's now)
 *
 * Every write is ONE command with the routing's lock order (../routing/store lockDraft: the style row, the revision's
 * version compare-and-set, 409 when it is not a DRAFT or the version is stale), then the step; an audit row on the step
 * and one on the revision, and W1's `style.routing_changed`. Every rule the database holds is checked here first and
 * answered in words (400 with the field, 409 for the state); a refusal that still comes from it is a 409 (store
 * depthGuarded), never a 500.
 */

// ---- the view -----------------------------------------------------------------------------------------------------------

async function sizeLabelsOf(db: Db, style: Pick<BomStyleRow, 'sizeScaleId' | 'sizes'>): Promise<Map<string, string>> {
  const rows = await db.size.findMany({ where: { scaleId: style.sizeScaleId, code: { in: style.sizes } }, select: { code: true, label: true } })
  return new Map(rows.map((row) => [row.code, row.label ?? row.code]))
}

export async function depthViewOf(db: Db, style: BomStyleRow, revision: Pick<RevisionRow, 'id'>, editable: boolean): Promise<RoutingDepthView> {
  const days = await db.styleRevision.findMany({ where: { styleId: style.id }, select: REVISION_DAY_COLUMNS })
  const mine = effectiveDays(days.map(revisionDaysOf)).find((entry) => entry.revision.id === revision.id)
  if (!mine) throw new NotFoundError('Revision not found.')
  const steps = await readDepthSteps(db, revision.id)
  const settings = await readSettings(db, 'step', steps.map((step) => step.id))
  const library = await readSettings(db, 'operation', steps.map((step) => step.operationId))
  const classes = await readMachineClasses(db, [...settings.values()].flat().map((row) => row.machineClassId))
  const plans = await readPlans(db, steps.map((step) => step.inspectionPlanId))
  const colourways = await readColourwaysOf(db, style.id)
  const sizeLabels = await sizeLabelsOf(db, style)
  // B-W2b-229: the style's offered options, and the words of every option a step names.
  const offered = await offeredValuesOf(db, style.id)
  const optionLabels = await optionLabelsOf(db, [...offered.map((value) => value.id), ...steps.flatMap((step) => step.appliesToOptionValueIds)])
  const stepViews: StepDepthView[] = steps.map((step) => {
    const plan = step.inspectionPlanId ? plans.get(step.inspectionPlanId) : undefined
    return {
      stepId: step.id,
      seq: step.seq,
      operationId: step.operationId,
      code: step.code,
      name: step.name,
      workCentreKind: step.workCentreKind,
      scanRequired: step.scanRequired,
      variants: variantsViewOf(variantsOfRow(step), sizeLabels, colourways, optionLabels),
      checkpoint: plan ? checkpointViewOf(plan) : null,
      settings: (settings.get(step.id) ?? []).map((row) => settingViewOf(row, classes)),
      librarySettings: (library.get(step.operationId) ?? []).length,
      version: step.version,
      updatedAt: toUtcIso(step.updatedAt),
    }
  })
  return {
    style: { id: style.id, code: style.code, name: style.name, companyId: style.companyId, status: style.status },
    revision: { id: mine.revision.id, revision: mine.revision.revision, status: mine.revision.status, effectiveFrom: mine.from, effectiveTo: mine.to, fromSource: mine.fromSource },
    sizes: style.sizes.map((code) => ({ code, label: sizeLabels.get(code) ?? code })),
    colourways: colourways.map((row) => ({ ...row })),
    steps: stepViews,
    options:
      offered.length > 0
        ? { available: true, words: { it: `Opzioni offerte dall'articolo: ${offered.map((value) => value.label).join(', ')}.`, en: `Options the style offers: ${offered.map((value) => value.label).join(', ')}.` } }
        : { available: false, words: { ...NO_OPTIONS_YET } },
    editable,
  }
}

const editableFor = (caller: CommandCaller, style: BomStyleRow, revision: Pick<RevisionRow, 'status'>): boolean =>
  revision.status === 'DRAFT' && style.status !== 'ARCHIVED' && mayWrite(actorOf(contextOf(caller)), PRODUCT_ROUTING_MANAGE, style.companyId)

/** GET …/routing/depth (product.routing.view over the style's company). */
export async function getRoutingDepth(caller: CommandCaller, styleId: string, revisionId: string): Promise<RoutingDepthView> {
  const { style, revision } = await readRevisionFor(caller, styleId, revisionId)
  return caller.withClient((client) => depthViewOf(client, style, revision, editableFor(caller, style, revision)))
}

// ---- writes -------------------------------------------------------------------------------------------------------------

/** The step of the draft, read inside the command (after the revision's lock). */
async function stepIn(tx: CommandTx, revisionId: string, stepId: string): Promise<DepthRow> {
  const step = isUuid(stepId) ? (await readDepthSteps(tx, revisionId)).find((row) => row.id === stepId) : undefined
  if (!step) throw new NotFoundError('Routing step not found.')
  return step
}

function recorded(tools: CommandTools, draft: LockedDraft, step: DepthRow, field: string, before: unknown, after: unknown): void {
  const { style } = draft
  tools.audit({ recordType: 'RoutingOperation', recordId: step.id, companyId: style.companyId, before: { [field]: before }, after: { [field]: after } })
  tools.audit({ recordType: 'StyleRevision', recordId: draft.revisionId, companyId: style.companyId, after: { routing: { changed: step.id, fields: [field] }, version: draft.version } })
  tools.emit({
    type: 'style.routing_changed',
    subject: style.id,
    companyId: style.companyId,
    payload: { styleId: style.id, code: style.code, revisionId: draft.revisionId, revision: draft.revision, stepIds: [step.id] },
  })
}

interface StepWrite<Body> {
  readonly name: `${string}.${string}`
  readonly styleId: string
  readonly revisionId: string
  readonly stepId: string
  readonly body: Body & { readonly version: number }
  readonly idempotencyKey: string | undefined
}

/** One command on one draft step: the access, the routing's lock order, then `work`; answers the routing in depth. */
async function onStep<Body>(caller: CommandCaller, write: StepWrite<Body>, work: (tools: CommandTools, draft: LockedDraft, step: DepthRow) => Promise<void>): Promise<RoutingDepthView> {
  const { style } = await readRevisionFor(caller, write.styleId, write.revisionId)
  assertMayWrite(contextOf(caller), PRODUCT_ROUTING_MANAGE, style.companyId)
  const { result } = await depthGuarded(() =>
    command(caller, { name: write.name, idempotencyKey: write.idempotencyKey, input: { styleId: write.styleId, revisionId: write.revisionId, stepId: write.stepId, ...write.body } }, async (tools) => {
      const { tx } = tools
      const draft = await lockDraft(tools, write.styleId, write.revisionId, write.body.version)
      const step = await stepIn(tx, write.revisionId, write.stepId)
      await work(tools, draft, step)
      const row = await tx.style.findUniqueOrThrow({ where: { id: write.styleId }, select: STYLE_COLUMNS })
      return depthViewOf(tx, row, { id: write.revisionId }, true)
    }),
  )
  return result
}

const touched = (tools: CommandTools) => ({ version: { increment: 1 }, updatedAt: tools.now })

/** product.routing.setStepVariants: the sizes and colourways a draft step is for (PRD-128). */
export async function setStepVariants(caller: CommandCaller, styleId: string, revisionId: string, stepId: string, body: StepVariantsBody, idempotencyKey?: string): Promise<RoutingDepthView> {
  return onStep(caller, { name: 'product.routing.setStepVariants', styleId, revisionId, stepId, body, idempotencyKey }, async (tools, draft, step) => {
    const { tx } = tools
    const style = await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: { sizes: true } })
    const colourways = await readColourwaysOf(tx, styleId)
    // B-W2b-229: the style's offered active options, and those the step names already (kept, as the database keeps them).
    const offered = (await offeredValuesOf(tx, styleId)).map((value) => value.id)
    const optionValueIds = [...offered, ...step.appliesToOptionValueIds.filter((id) => !offered.includes(id))]
    const plan = planVariants({ sizes: body.sizes, colourwayIds: body.colourwayIds, optionValueIds: body.optionValueIds }, { sizes: style.sizes, colourwayIds: colourways.map((row) => row.id), optionValueIds })
    if (!plan.ok) throw new ValidationError('The cells the step is for are not valid.', plan.issues.map((issue) => ({ path: `body/${issue.path}`, message: issue.message })))
    const before = variantsOfRow(step)
    if (sameVariants(before, plan.variants)) return
    await tx.routingOperation.update({
      where: { id: step.id },
      data: { appliesToSizes: [...plan.variants.sizes], appliesToColourwayIds: [...plan.variants.colourwayIds], appliesToOptionValueIds: [...plan.variants.optionValueIds], ...touched(tools) },
      select: { id: true },
    })
    recorded(tools, draft, step, 'appliesTo', before, plan.variants)
  })
}

/** product.routing.setStepCheckpoint: a draft step's quality checkpoint (PRD-119), or none. */
export async function setStepCheckpoint(caller: CommandCaller, styleId: string, revisionId: string, stepId: string, body: StepCheckpointBody, idempotencyKey?: string): Promise<RoutingDepthView> {
  return onStep(caller, { name: 'product.routing.setStepCheckpoint', styleId, revisionId, stepId, body, idempotencyKey }, async (tools, draft, step) => {
    const { tx } = tools
    const planId = body.inspectionPlanId
    if (planId === step.inspectionPlanId) return
    if (planId !== null) {
      const plan = (await readPlans(tx, [planId])).get(planId)
      if (!plan) throw new ValidationError('No such inspection plan.', [{ path: 'body/inspectionPlanId', message: 'No such inspection plan.' }])
      const refusal = checkpointRefusal(plan, draft.style.companyId)
      if (refusal) throw new ValidationError('This plan cannot be the step\'s checkpoint.', [{ path: 'body/inspectionPlanId', message: refusal }])
    }
    await tx.routingOperation.update({ where: { id: step.id }, data: { inspectionPlanId: planId, ...touched(tools) }, select: { id: true } })
    recorded(tools, draft, step, 'inspectionPlanId', step.inspectionPlanId, planId)
  })
}

/** Replaces the settings of a library operation (`operationId`) or of a draft step (`step`), as planned. */
export async function replaceSettings(tools: CommandTools, owner: { readonly operationId: string } | { readonly revisionId: string; readonly routingOperationId: string }, settings: readonly SettingData[]): Promise<void> {
  const { tx, now } = tools
  const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
  const where = 'operationId' in owner ? { operationId: owner.operationId } : { routingOperationId: owner.routingOperationId }
  await tx.operationMachineSetting.deleteMany({ where })
  if (settings.length === 0) return
  await tx.operationMachineSetting.createMany({
    data: settings.map((setting) => ({
      id: newId(),
      ...('operationId' in owner ? { operationId: owner.operationId } : { revisionId: owner.revisionId, routingOperationId: owner.routingOperationId }),
      ...setting,
      createdAt: now,
      updatedAt: now,
      createdById,
    })),
  })
}

/** The settings as typed, checked against the machine classes (the ones the list names now may stay switched off). */
export async function plannedSettings(tx: CommandTx, inputs: NonNullable<StepSettingsBody['settings']>, current: readonly SettingData[]): Promise<SettingData[]> {
  const classes = await readMachineClasses(tx, inputs.map((input) => input.machineClassId ?? null))
  const kept = new Set(current.flatMap((setting) => (setting.machineClassId ? [setting.machineClassId] : [])))
  const plan = planSettings(inputs, classes, kept)
  if (!plan.ok) throw new ValidationError('The machine settings are not valid.', plan.issues.map((issue): Issue => ({ path: `body/${issue.path}`, message: issue.message })))
  return [...plan.settings]
}

/** product.routing.setStepSettings: a draft step's machine and stitch settings (PRD-118). */
export async function setStepSettings(caller: CommandCaller, styleId: string, revisionId: string, stepId: string, body: StepSettingsBody, idempotencyKey?: string): Promise<RoutingDepthView> {
  return onStep(caller, { name: 'product.routing.setStepSettings', styleId, revisionId, stepId, body, idempotencyKey }, async (tools, draft, step) => {
    const { tx } = tools
    const current = (await readSettings(tx, 'step', [step.id])).get(step.id)?.map(settingDataOf) ?? []
    // A copy of the library's list: its operation row FOR SHARE, so the library's list does not change under the copy.
    if (body.fromLibrary) await lockOperations(tx, [step.operationId])
    const next = body.fromLibrary ? ((await readSettings(tx, 'operation', [step.operationId])).get(step.operationId)?.map(settingDataOf) ?? []) : await plannedSettings(tx, body.settings ?? [], current)
    if (sameSettings(current, next)) return
    await replaceSettings(tools, { revisionId, routingOperationId: step.id }, next)
    await tx.routingOperation.update({ where: { id: step.id }, data: touched(tools), select: { id: true } })
    recorded(tools, draft, step, 'machineSettings', auditedSettings(current), { ...(body.fromLibrary ? { fromLibrary: step.operationId } : {}), settings: auditedSettings(next) })
  })
}
