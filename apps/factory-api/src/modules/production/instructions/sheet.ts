import { businessDate } from '@nexus/factory-domain/core/time'
import type { DocumentLanguage } from '@nexus/factory-domain/documents/model'
import { asWords, wordsIn } from '@nexus/factory-domain/production/instructions/rules'
import { instructionSheetDocument } from '@nexus/factory-domain/production/instructions/sheet'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { companyLegalOf } from '../../../platform/documents/documents'
import { renderDocumentPdf } from '../../../platform/documents/pdf'
import { userNames } from '../../people/employees/employees'
import { settingsOf } from './lookup'
import { classesOf, mediaOf, officeOf, operationsOf, readInstruction, readVersion, revisionsOf, statusOf, stepsOf, wordsOrNull, type Db } from './store'

/**
 * GET /production/instructions/:instructionId/versions/:versionId/sheet?language=it|en (B-W2b-214; PRD-117 "the PDF sheet";
 * design production.instructions "Instruction sheet PDF: paper at the station"): one version on A4 through the shared
 * renderer (factory-domain production/instructions/sheet). A draft, superseded or discarded version prints with its banner;
 * the words of each step in the sheet's language, else the first the step has. Printed, not stored: the version is the
 * record. Office only (production.instructions.view).
 */
export async function sheetPdf(caller: CommandCaller, instructionId: string, versionId: string, language: DocumentLanguage = 'it'): Promise<{ pdf: Buffer; fileName: string }> {
  const context = officeOf(caller)
  const facts = await caller.withClient(async (client) => {
    const db = client as Db
    const instruction = await readInstruction(db, context, instructionId)
    const version = await readVersion(db, instruction, versionId)
    const steps = await stepsOf(db, [version.id])
    const media = await mediaOf(db, [version.id])
    const operation = (await operationsOf(db, [instruction.operationId])).get(instruction.operationId)
    const revision = instruction.styleRevisionId ? (await revisionsOf(db, [instruction.styleRevisionId])).get(instruction.styleRevisionId) : undefined
    const settings = await settingsOf(db, { routingOperationId: null, operationId: instruction.operationId })
    const classes = await classesOf(db, settings.map((row) => row.machineClassId))
    const names = await userNames(db, [version.authorId, version.approvedById])
    return { instruction, version, steps, media, operation, revision, settings, classes, names }
  })
  const { instruction, version } = facts
  const composed = instructionSheetDocument({
    language,
    company: await companyLegalOf(caller, instruction.companyId),
    printedOn: businessDate(serverClock.now()),
    instruction: {
      number: instruction.number,
      operation: { code: facts.operation?.code ?? '', name: (facts.operation ? wordsIn(facts.operation.nameI18n, language)?.text : null) ?? facts.operation?.name ?? '' },
      style: facts.revision ? { code: facts.revision.style.code, name: facts.revision.style.name, revision: facts.revision.revision } : null,
    },
    version: {
      number: version.number,
      status: statusOf(version),
      publishedOn: version.publishedAt ? businessDate(version.publishedAt) : null,
      authorName: facts.names.get(version.authorId) ?? null,
      approvedByName: version.approvedById ? (facts.names.get(version.approvedById) ?? null) : null,
      changeNote: version.changeNote,
    },
    settings: facts.settings.map((row) => {
      const machineClass = row.machineClassId ? facts.classes.get(row.machineClassId) : undefined
      return {
        seq: row.seq,
        machineClass: machineClass ? (language === 'it' ? machineClass.labelIt : machineClass.labelEn) : null,
        stitchType: row.stitchType,
        needle: row.needle,
        thread: row.thread,
        stitchesPerCm: row.stitchesPerCm === null ? null : row.stitchesPerCm.toString(),
        tension: row.tension,
        foot: row.foot,
        notes: row.notes,
      }
    }),
    steps: facts.steps.map((step) => {
      const safety = wordsOrNull(step.safetyNoteI18n)
      return {
        code: step.code,
        text: wordsIn(asWords(step.textI18n), language)?.text ?? step.code,
        critical: step.critical,
        safety: safety ? (wordsIn(safety, language)?.text ?? null) : null,
        requiredTick: step.requiredTick,
        media: facts.media.filter((medium) => medium.stepId === step.id).length,
      }
    }),
  })
  return { pdf: await renderDocumentPdf(composed), fileName: `${composed.meta.title.replace(/[\\/]/g, '-')}.pdf` }
}
