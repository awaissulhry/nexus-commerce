import { newId } from '@nexus/factory-domain/core/ids'
import { stepsOfInstructions } from '@nexus/factory-domain/production/checklists/rules'
import { PRODUCTION_INSTRUCTIONS_MANAGE } from '@nexus/factory-domain/production/instructions/permissions'
import { stepsFromTypedLines, WORDS_LANGUAGE } from '@nexus/factory-domain/production/instructions/rules'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { assertMay, INSTRUCTION, INSTRUCTION_RECORD, inWords, officeOf, VERSION, VERSION_RECORD, type Db } from './store'

/**
 * The typed step lines brought into work instructions, once (B-W2b-214, follow-up WI1:01 of B-W2b-47): until W2b-4 the office
 * typed an operation's steps as `[ ] CODE words` / `[o] CODE words` lines in a routing step's instructions. Each routing step
 * that has such lines becomes an instruction of its operation for that style revision, numbered from the company's series,
 * with a version 1 DRAFT holding the same codes (a tick already made names them), the words in the language they were
 * typed in, a `[ ]` line's tick required. A second person publishes each (the database refuses the author); until then the
 * typed lines stay the steps of the floor (checklists/store.ts stepsOfOperation), so nothing changes at a station before a
 * person approves it.
 *
 *   GET  /production/instructions/typed-steps?companyId=     what would be made, and what was made already (dry run)
 *   POST /production/instructions/typed-steps                {companyId, language?}: makes them in ONE command
 *
 * Once: a routing step whose operation and revision have an instruction (of any state) is left alone, so a second run makes
 * nothing again. The routing's lines themselves are never changed (a released revision is frozen).
 */

interface Candidate {
  readonly routingOperationId: string
  readonly revisionId: string
  readonly styleId: string
  readonly operationId: string
  readonly seq: number
  readonly code: string
  readonly instructions: string
  readonly style: { readonly code: string; readonly name: string }
  readonly revision: number
  readonly revisionStatus: string
  /** The instruction this operation and revision already has, of any state. */
  readonly existing: { readonly id: string; readonly number: string; readonly status: string } | null
}

/** The routing steps of the company's styles (or the group's) with typed step lines, in style, revision and step order. */
async function candidatesOf(db: Db, companyId: string): Promise<Candidate[]> {
  const steps = await db.routingOperation.findMany({ where: { instructions: { contains: '] ' } }, select: { id: true, revisionId: true, styleId: true, operationId: true, seq: true, code: true, instructions: true } })
  const typed = steps.filter((step) => stepsOfInstructions(step.instructions).length > 0)
  if (typed.length === 0) return []
  const styles = new Map((await db.style.findMany({ where: { id: { in: [...new Set(typed.map((step) => step.styleId))] }, OR: [{ companyId }, { companyId: null }] }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const revisions = new Map((await db.styleRevision.findMany({ where: { id: { in: [...new Set(typed.map((step) => step.revisionId))] } }, select: { id: true, revision: true, status: true } })).map((row) => [row.id, row]))
  const operations = new Map((await db.operation.findMany({ where: { id: { in: [...new Set(typed.map((step) => step.operationId))] } }, select: { id: true, companyId: true } })).map((row) => [row.id, row]))
  const existing = await db.workInstruction.findMany({ where: { companyId, styleRevisionId: { in: [...new Set(typed.map((step) => step.revisionId))] } }, select: { id: true, number: true, status: true, operationId: true, styleRevisionId: true } })
  const seen = new Set<string>()
  return typed
    .flatMap((step) => {
      const style = styles.get(step.styleId)
      const revision = revisions.get(step.revisionId)
      const operation = operations.get(step.operationId)
      // An operation used twice in one routing: one instruction per operation and revision, from its first step.
      const key = `${step.operationId}|${step.revisionId}`
      if (!style || !revision || !operation || (operation.companyId !== null && operation.companyId !== companyId) || seen.has(key)) return []
      seen.add(key)
      const found = existing.find((row) => row.operationId === step.operationId && row.styleRevisionId === step.revisionId) ?? null
      return [{ routingOperationId: step.id, revisionId: step.revisionId, styleId: step.styleId, operationId: step.operationId, seq: step.seq, code: step.code, instructions: step.instructions ?? '', style: { code: style.code, name: style.name }, revision: revision.revision, revisionStatus: revision.status as string, existing: found ? { id: found.id, number: found.number, status: found.status as string } : null }]
    })
    .sort((a, b) => (a.style.code < b.style.code ? -1 : a.style.code > b.style.code ? 1 : a.revision - b.revision || a.seq - b.seq))
}

const rowOf = (candidate: Candidate, language: string) => ({
  routingOperationId: candidate.routingOperationId,
  style: { id: candidate.styleId, code: candidate.style.code, name: candidate.style.name },
  revision: { id: candidate.revisionId, revision: candidate.revision, status: candidate.revisionStatus },
  step: { seq: candidate.seq, code: candidate.code, operationId: candidate.operationId },
  steps: stepsFromTypedLines(candidate.instructions, language).map((step) => ({ code: step.code, words: step.text[language] ?? '', requiredTick: step.requiredTick ?? false })),
  existing: candidate.existing,
})

function languageOf(language: string | undefined): string {
  const value = language ?? 'it'
  if (!WORDS_LANGUAGE.test(value)) throw new ValidationError('The language is an ISO 639 code (it, en, ro).', [{ path: 'language', message: 'Expected a language code in lower case.' }])
  return value
}

/** GET /production/instructions/typed-steps?companyId=&language=. */
export async function typedSteps(caller: CommandCaller, query: { readonly companyId: string; readonly language?: string | undefined }) {
  const context = officeOf(caller)
  assertMay(context, PRODUCTION_INSTRUCTIONS_MANAGE, query.companyId, 'You write work instructions only for the companies your role reaches (production.instructions.manage).')
  const language = languageOf(query.language)
  const candidates = await caller.withClient((client) => candidatesOf(client as Db, query.companyId))
  return { rows: candidates.map((candidate) => rowOf(candidate, language)), toMake: candidates.filter((candidate) => !candidate.existing).length, made: candidates.filter((candidate) => candidate.existing).length }
}

async function makeOne(tools: CommandTools, companyId: string, candidate: Candidate, language: string) {
  const { tx, now } = tools
  const actorId = officeOf({ factoryContext: tools.context }).actorId
  const instructionId = newId()
  const issued = await allocateNumber(tools, { companyId, kind: 'WORK_INSTRUCTION' }, { type: INSTRUCTION_RECORD, id: instructionId })
  const instruction = await tx.workInstruction.create({ data: { id: instructionId, companyId, number: issued.formatted, operationId: candidate.operationId, styleId: candidate.styleId, styleRevisionId: candidate.revisionId, createdAt: now, updatedAt: now, createdById: actorId }, select: INSTRUCTION })
  const version = await tx.workInstructionVersion.create({ data: { id: newId(), instructionId, number: 1, changeNote: null, authorId: actorId, createdAt: now, updatedAt: now, createdById: actorId }, select: VERSION })
  const steps = stepsFromTypedLines(candidate.instructions, language)
  for (const [index, step] of steps.entries()) {
    await tx.workInstructionStep.create({ data: { id: newId(), versionId: version.id, sortOrder: (index + 1) * 10, code: step.code, textI18n: { ...step.text }, requiredTick: step.requiredTick ?? false, createdAt: now, updatedAt: now, createdById: actorId }, select: { id: true } })
  }
  tools.audit({ recordType: INSTRUCTION_RECORD, recordId: instruction.id, companyId, after: { number: instruction.number, operationId: instruction.operationId, styleRevisionId: instruction.styleRevisionId, fromTypedLines: { routingOperationId: candidate.routingOperationId, language } } })
  tools.audit({ recordType: VERSION_RECORD, recordId: version.id, companyId, after: { number: 1, status: 'DRAFT', steps: steps.map((step) => step.code) } })
  tools.emit({ type: 'production.instruction_changed', subject: instruction.id, companyId, siteId: null, payload: { instructionId: instruction.id, number: instruction.number, operationId: instruction.operationId, change: 'CREATED', versionId: version.id, versionNumber: 1 } })
  return { instructionId: instruction.id, number: instruction.number, versionId: version.id, routingOperationId: candidate.routingOperationId }
}

/** POST /production/instructions/typed-steps. */
export async function bringTypedSteps(caller: CommandCaller, body: { readonly companyId: string; readonly language?: string | undefined }, idempotencyKey?: string) {
  const context = officeOf(caller)
  assertMay(context, PRODUCTION_INSTRUCTIONS_MANAGE, body.companyId, 'You write work instructions only for the companies your role reaches (production.instructions.manage).')
  const language = languageOf(body.language)
  const { result } = await inWords(() =>
    command(caller, { name: 'production.bringTypedSteps', idempotencyKey, input: { ...body, language } }, async (tools) => {
      // One run at a time per company: the second sees what the first made.
      await tools.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.work-instructions-typed', current_setting('factory.tenant_id', true), ${body.companyId}::text), 0))`
      const candidates = (await candidatesOf(tools.tx, body.companyId)).filter((candidate) => !candidate.existing)
      const made = []
      for (const candidate of candidates) made.push(await makeOne(tools, body.companyId, candidate, language))
      if (made.length === 0) tools.audit({ recordType: 'Company', recordId: body.companyId, companyId: body.companyId, after: { typedSteps: 'nothing to bring' } })
      return { made }
    }),
  )
  return result
}
