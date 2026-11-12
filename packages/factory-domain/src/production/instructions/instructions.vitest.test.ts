import { describe, expect, it } from 'vitest'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { QUEUED_ACTIONS } from '../../floor-sync/kinds'
import { summaryOf } from '../../floor-sync/rules'
import type { CompanyLegal } from '../../documents/model'
import { PRODUCTION_INSTRUCTIONS_PERMISSIONS } from './permissions'
import {
  acknowledgementDue,
  checklistOfLines,
  checklistOfSteps,
  instructionFor,
  languagesOf,
  mediaTypeProblem,
  missingLanguages,
  publishRefusal,
  stepsFromTypedLines,
  stepsProblems,
  wordsIn,
  type PublishFacts,
} from './rules'
import { instructionSheetDocument, type SheetInput } from './sheet'

/** Work instructions (B-W2b-214): the pure rules, by hand. Every name and value is made up. */

describe('the steps a version holds', () => {
  const step = { code: 'SEAM', text: { it: 'Cucire a 10 mm', en: 'Sew at 10 mm' } }

  it('takes codes the tablet can tick, words in at least one language, the icons of the list', () => {
    expect(stepsProblems([step, { code: 'CHECK_SEAM', text: { ro: 'Verificați' }, icon: 'check', requiredTick: true, safety: { it: 'Dita lontane' } }])).toEqual([])
    const problems = stepsProblems([
      { code: 'seam allowance', text: { it: 'x' } },
      { ...step },
      { ...step },
      { code: 'B', text: {} },
      { code: 'C', text: { it: '  ' } },
      { code: 'D', text: { ITA: 'x' } },
      { code: 'E', text: { it: 'x' }, icon: 'rocket' },
      { code: 'F', text: { it: 'x' }, media: [{ fileId: 'a', kind: 'PHOTO' }, { fileId: 'a', kind: 'VIDEO' }] },
    ])
    expect(problems.map((problem) => problem.path)).toEqual(['steps/0/code', 'steps/2/code', 'steps/3/text', 'steps/4/text/it', 'steps/5/text/ITA', 'steps/6/icon', 'steps/7/media/1/fileId'])
  })

  it('a photo is a picture, a video a short clip', () => {
    expect(mediaTypeProblem('PHOTO', 'image/jpeg')).toBeNull()
    expect(mediaTypeProblem('VIDEO', 'video/mp4')).toBeNull()
    expect(mediaTypeProblem('PHOTO', 'video/mp4')).toMatch(/picture/)
    expect(mediaTypeProblem('VIDEO', 'image/png')).toMatch(/clip/)
  })

  it('reads the words in the language asked, else Italian, English, the first one', () => {
    expect(wordsIn({ it: 'Cucire', ro: 'Coaseți' }, 'ro')).toEqual({ text: 'Coaseți', language: 'ro' })
    expect(wordsIn({ it: 'Cucire', en: 'Sew' }, 'zh')).toEqual({ text: 'Cucire', language: 'it' })
    expect(wordsIn({ en: 'Sew' }, null)).toEqual({ text: 'Sew', language: 'en' })
    expect(wordsIn({ ro: 'Coaseți' }, 'it')).toEqual({ text: 'Coaseți', language: 'ro' })
    expect(wordsIn({}, 'it')).toBeNull()
    expect(languagesOf([{ text: { it: 'a', en: 'b' } }, { text: { ro: 'c', it: 'd' } }])).toEqual(['en', 'it', 'ro'])
    expect(missingLanguages({ it: 'a', ro: ' ' }, ['it', 'en', 'ro'])).toEqual(['en', 'ro'])
  })
})

describe('the checklist the tablet ticks (B-W2b-47 follow-up: the published version replaces the typed lines)', () => {
  it('orders a version’s steps, keeps the first of a code, carries the icon and the critical point', () => {
    const rows = [
      { code: 'CHECK', sortOrder: 30, textI18n: { it: 'Verificare', en: 'Check' }, critical: false, icon: 'check', requiredTick: true },
      { code: 'PREPARE', sortOrder: 10, textI18n: { it: 'Preparare' }, critical: false, icon: null, requiredTick: false },
      { code: 'SEAM', sortOrder: 20, textI18n: { it: 'Cucire', en: 'Sew' }, critical: true, icon: 'needle', requiredTick: false },
    ]
    expect(checklistOfSteps(rows, 'en')).toEqual([
      { code: 'PREPARE', words: 'Preparare', required: false, icon: null, critical: false },
      { code: 'SEAM', words: 'Sew', required: false, icon: 'needle', critical: true },
      { code: 'CHECK', words: 'Check', required: true, icon: 'check', critical: false },
    ])
  })

  it('keeps the typed lines as they were until an instruction is published', () => {
    expect(checklistOfLines('Sew the collar.\n[ ] TRIM_THREADS Trim the threads\n[o] POCKET_ZIP Close the zip')).toEqual([
      { code: 'TRIM_THREADS', words: 'Trim the threads', required: true, icon: null, critical: false },
      { code: 'POCKET_ZIP', words: 'Close the zip', required: false, icon: null, critical: false },
    ])
  })

  it('brings the typed lines into a first version with the same codes and the tick they asked', () => {
    expect(stepsFromTypedLines('[ ] TRIM_THREADS Trim the threads\nplain words\n[o] POCKET_ZIP Close the zip', 'it')).toEqual([
      { code: 'TRIM_THREADS', text: { it: 'Trim the threads' }, critical: false, safety: null, icon: null, requiredTick: true, media: [] },
      { code: 'POCKET_ZIP', text: { it: 'Close the zip' }, critical: false, safety: null, icon: null, requiredTick: false, media: [] },
    ])
    expect(stepsFromTypedLines(null, 'it')).toEqual([])
  })

  it('takes the revision’s own instruction first, then the one for every style, active only', () => {
    const every = { id: 'every', styleRevisionId: null, status: 'ACTIVE' }
    const own = { id: 'own', styleRevisionId: 'rev-1', status: 'ACTIVE' }
    const archived = { id: 'old', styleRevisionId: 'rev-2', status: 'ARCHIVED' }
    expect(instructionFor([every, own], 'rev-1')?.id).toBe('own')
    expect(instructionFor([every, own, archived], 'rev-2')?.id).toBe('every')
    expect(instructionFor([own], 'rev-3')).toBeNull()
    expect(instructionFor([every], null)?.id).toBe('every')
  })
})

describe('publishing: a second person, a complete draft', () => {
  const facts: PublishFacts = { number: 2, status: 'DRAFT', authorId: 'author', editorIds: ['author', 'editor'], approverId: 'approver', instructionNumber: 'WI-0007', instructionActive: true, changeNote: 'Wider allowance.', steps: 3, mediaNotReady: 0 }

  it('says why, in the order the database checks', () => {
    expect(publishRefusal(facts)).toBeNull()
    expect(publishRefusal({ ...facts, number: 1, changeNote: null })).toBeNull()
    expect(publishRefusal({ ...facts, status: 'PUBLISHED' })?.code).toBe('NOT_DRAFT')
    expect(publishRefusal({ ...facts, status: 'DISCARDED' })?.message).toMatch(/discarded/)
    expect(publishRefusal({ ...facts, approverId: 'author' })).toMatchObject({ code: 'OWN_DRAFT', message: 'Version 2 of WI-0007 is your own draft: another person approves it (four eyes).' })
    expect(publishRefusal({ ...facts, instructionActive: false })?.code).toBe('ARCHIVED')
    expect(publishRefusal({ ...facts, steps: 0 })?.code).toBe('NO_STEPS')
    expect(publishRefusal({ ...facts, changeNote: '  ' })?.code).toBe('CHANGE_NOTE_MISSING')
    expect(publishRefusal({ ...facts, mediaNotReady: 2 })?.message).toMatch(/2 photos or videos not uploaded yet/)
  })

  it('nobody approves their own work (B-W2b-F24; Owner W2b-5 Q3): a person who changed the draft never publishes it', () => {
    expect(publishRefusal({ ...facts, approverId: 'editor' })).toEqual({ code: 'EDITED_DRAFT', message: 'You changed version 2 of WI-0007: a person who neither wrote nor changed it approves it (four eyes).' })
    // Who changed it is refused before what the draft lacks; a third person is not.
    expect(publishRefusal({ ...facts, approverId: 'editor', steps: 0 })?.code).toBe('EDITED_DRAFT')
    expect(publishRefusal({ ...facts, approverId: 'third' })).toBeNull()
    expect(publishRefusal({ ...facts, editorIds: [] })).toBeNull()
  })
})

describe('Seen (MES-119) and the version that opens before Start (MES-110)', () => {
  it('asks once: the first time, and after a change that asks for it; never for a wording fix someone saw before', () => {
    expect(acknowledgementDue({ required: true, seenThis: false, seenEarlier: false })).toBe('FIRST')
    expect(acknowledgementDue({ required: true, seenThis: false, seenEarlier: true })).toBe('CHANGED')
    expect(acknowledgementDue({ required: true, seenThis: true, seenEarlier: true })).toBeNull()
    expect(acknowledgementDue({ required: false, seenThis: false, seenEarlier: true })).toBeNull()
    expect(acknowledgementDue({ required: false, seenThis: false, seenEarlier: false })).toBe('FIRST')
  })

  it('queues offline under the scans’ right; the ledger keeps the version, never who', () => {
    expect(QUEUED_ACTIONS['production.instruction.ack']).toMatchObject({ permission: 'production.scan', numbers: null })
    expect(summaryOf('production.instruction.ack', { versionId: 'v-1', locale: 'ro' })).toEqual({ target: 'v-1' })
  })
})

describe('registries', () => {
  it('declares the rights and gives them to the templates that write, approve and keep the training record', () => {
    for (const name of PRODUCTION_INSTRUCTIONS_PERMISSIONS) expect(FACTORY_PERMISSIONS.isDeclared(name)).toBe(true)
    expect(FACTORY_PERMISSIONS.get('production.instructions.people')?.risk).toBe('write')
    expect(templateOf('production_manager')?.permissions).toEqual(expect.arrayContaining(['production.instructions.manage', 'production.instructions.approve']))
    expect(templateOf('hr')?.permissions).toEqual(expect.arrayContaining(['production.instructions.view', 'production.instructions.people']))
    expect(templateOf('read_only')?.permissions).toContain('production.instructions.view')
    expect(templateOf('read_only')?.permissions).not.toContain('production.instructions.people')
    expect(templateOf('floor_supervisor')?.permissions).not.toContain('production.instructions.approve')
  })

  it('declares the events, with no person in a payload', () => {
    for (const type of ['production.instruction_changed', 'production.instruction_published', 'production.instruction_acknowledged']) {
      const definition = EVENT_CATALOGUE.get(type, 1)
      expect(Object.keys(definition.payload.shape)).not.toEqual(expect.arrayContaining(['workerId']))
      expect(definition.live?.floor ?? null).toBeNull()
    }
  })
})

describe('the instruction sheet (PDF)', () => {
  const company: CompanyLegal = {
    legalName: 'Pelletteria Fittizia S.r.l.',
    address: { line1: 'Via Inventata 1', postalCode: '00000', city: 'Nessuna', province: 'XX', country: 'IT' },
    vatNumber: 'IT00000000000',
    fiscalCode: '00000000000',
    reaOffice: 'XX',
    reaNumber: '000000',
    shareCapital: '10000.00',
    currency: 'EUR',
  } as CompanyLegal
  const input: SheetInput = {
    language: 'en',
    company,
    printedOn: '2026-11-20',
    instruction: { number: 'WI-0007', operation: { code: 'SEW-ASM', name: 'Sew the body' }, style: null },
    version: { number: 2, status: 'PUBLISHED', publishedOn: '2026-11-19', authorName: 'A. Writer', approvedByName: 'B. Approver', changeNote: 'Wider allowance.' },
    settings: [{ seq: 1, machineClass: 'Post-bed', stitchType: '301', needle: '134 LR, Nm 110', thread: null, stitchesPerCm: '3.50', tension: null, foot: null, notes: null }],
    steps: [
      { code: 'SEAM', text: 'Sew at 10 mm.', critical: true, safety: 'Keep your fingers away from the foot.', requiredTick: false, media: 2 },
      { code: 'CHECK', text: 'Check the seam.', critical: false, safety: null, requiredTick: true, media: 0 },
    ],
  }

  it('prints the steps, the settings and the safety notes; a version not in force says so', () => {
    const sheet = instructionSheetDocument(input)
    expect(sheet.banner).toBeNull()
    expect(sheet.identity).toEqual([
      { label: 'Number', value: 'WI-0007' },
      { label: 'Version', value: '2' },
      { label: 'Printed on', value: expect.any(String) },
    ])
    expect(sheet.table.rows).toEqual([
      ['1. SEAM', 'Sew at 10 mm. (2 photos or videos on the tablet)', 'yes', 'optional'],
      ['2. CHECK', 'Check the seam.', '', 'required'],
    ])
    expect(sheet.blocks.find((block) => block.heading === 'Machine settings')?.lines).toEqual(['1. Post-bed · stitch 301 · 134 LR, Nm 110 · 3.5 stitches/cm'])
    expect(sheet.notices[0]).toBe('Safety, step SEAM: Keep your fingers away from the foot.')
    expect(sheet.notices.at(-1)).toMatch(/This paper is version 2/)
    expect(sheet.meta.title).toBe('Work instruction WI-0007 v2')
    expect(instructionSheetDocument({ ...input, version: { ...input.version, status: 'SUPERSEDED' } }).banner).toMatch(/SUPERSEDED/)
    expect(instructionSheetDocument({ ...input, language: 'it', version: { ...input.version, status: 'DRAFT', publishedOn: null } }).banner).toMatch(/BOZZA/)
  })
})
