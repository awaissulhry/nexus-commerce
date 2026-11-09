import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { Locale } from '../../../../lib/i18n/locales'
import type { Job } from '../api'
import { jobBandOf } from '../band'
import { at, backJob, dayAt, FACTS, jobOf, kitJob, newJob, pageOf, PREFIX, proposedJob, shellOf, threadOf, TODAY, words } from '../design-data'
import { ACCEPT_DRAFT, DECLINE_DRAFT, kitDraftOf, PROBLEM_DRAFT, progressDraftOf, returnDraftOf, type PersonFacts, type RecordTab } from '../model'
import { JobsCase, type JobsCaseBuilder } from '../view/JobsCase'
import type { JobRecordViewModel } from '../view/JobRecordView'

/**
 * SCR-193 › one job (design portal.supplier.jobs rec "Job": Kit received, Progress, Send back, Documents, Messages;
 * pop:accept-job, pop:decline-job, the kit's damage photo, the send-back's review; tab:job-sheet), MADE-UP data only:
 * every tab with its states (to do, done, refused, held with the reason, offline), a New job with its answer, a proposed
 * day and our answer, an office preview and a colleague who may only read. Measure at 390 first, then 1440 and 1920.
 */

function recordModel(job: Job | null, over: Partial<JobRecordViewModel> = {}): JobRecordViewModel {
  return {
    state: 'ready',
    page: job ? pageOf(job) : null,
    tab: 'progress',
    prefix: PREFIX,
    today: TODAY,
    facts: FACTS,
    kitLines: false,
    kit: job ? kitDraftOf(job) : { lines: {} },
    progress: job ? progressDraftOf(job) : { grids: {}, whole: {}, finishBy: '', note: '' },
    returns: job ? returnDraftOf(job, TODAY) : { rows: {}, material: {}, parcels: '1', expectedDate: TODAY, weCollect: false, ddtNumber: '', ddtDate: '', note: '' },
    problem: PROBLEM_DRAFT,
    busy: null,
    refusal: null,
    end: null,
    accept: null,
    decline: null,
    photo: null,
    review: null,
    offlineSince: null,
    ...over,
  }
}

function recordCase(job: Job | null, tab: RecordTab, over: (job: Job | null) => Partial<JobRecordViewModel> = () => ({}), shell: { preview?: boolean } = {}): JobsCaseBuilder {
  return (locale: Locale) => {
    const t = words(locale)
    const model = recordModel(job, { tab, ...over(job) })
    const facts = model.facts
    const held = facts.preview ? t('held.preview') : facts.mayAct.approve ? null : t('held.may.approve')
    return {
      shell: shellOf(locale, { path: '/jobs', preview: shell.preview ?? false, band: job ? jobBandOf({ t, job, tab, prefix: PREFIX, acceptHeld: held, declineHeld: held }) : { title: t('record.titleLoading') } }),
      body: { kind: 'record', model, thread: tab === 'messages' ? threadOf(locale) : null },
    }
  }
}

const viewer: PersonFacts = { ...FACTS, mayAct: { approve: false, comment: false, upload: false } }
const progressTyped = (job: Job) => ({ ...progressDraftOf(job), grids: { [job.operations[0]!.id]: { Nero: { L: 6, XL: 4 }, Cuoio: { L: 3 } } } })
const progressOver = (job: Job) => ({ ...progressDraftOf(job), grids: { [job.operations[0]!.id]: { Nero: { L: 12 } } } })

export const designScreen = defineDesignScreen<JobsCaseBuilder>({
  screen: 'SCR-193',
  title: 'Workshop Job (portal.supplier.jobs rec Job)',
  view: JobsCase,
  cases: [
    // Progress
    { id: 'progress', label: 'Progress: finished pieces per size', model: recordCase(jobOf(), 'progress'), note: 'Per size: finished so far of ordered, and today’s pieces on the stacked size grid (a phone) with what is left beside each size; the day it finishes by; the reports so far.' },
    { id: 'progress-typed', label: 'Progress: today’s pieces typed', model: recordCase(jobOf(), 'progress', (job) => ({ progress: progressTyped(job!) })), note: '“Send 13 finished pieces”.' },
    { id: 'progress-held', label: 'Progress: more than is left', model: recordCase(jobOf(), 'progress', (job) => ({ progress: progressOver(job!) })), note: 'Send is held with the reason: “Line 10, Nero L: at most 10 more.”' },
    { id: 'progress-sent', label: 'Progress: sent', model: recordCase(jobOf(), 'progress', () => ({ end: { kind: 'progress', pieces: 13 } })), note: '“Sent: 13 finished pieces. Our work order sees them at once.”' },
    { id: 'progress-offline', label: 'Progress: no connection', model: recordCase(jobOf(), 'progress', (job) => ({ progress: progressTyped(job!), facts: { ...FACTS, offline: true }, offlineSince: at(-1) })), note: '“Not sent — no connection. Your report stays on this page; press Send again.” No background queue.' },
    { id: 'problem', label: 'Progress: report a problem', model: recordCase(jobOf(), 'progress', () => ({ problem: { kind: 'MATERIAL', note: 'Mancano 2 zip.' } })), note: 'The problem goes to our office in the job’s messages.' },
    { id: 'progress-viewer', label: 'Progress: a colleague who may only read', model: recordCase(jobOf(), 'progress', (job) => ({ facts: viewer, progress: progressTyped(job!) })) },
    // Kit
    { id: 'kit', label: 'Kit received: to confirm', model: recordCase(kitJob(), 'kit'), note: 'The kit as on our DDT; ONE big “All received as listed”, or line by line; a photo of damage per line.' },
    { id: 'kit-lines', label: 'Kit received: line by line, one short', model: recordCase(kitJob(), 'kit', (job) => ({ kitLines: true, kit: { lines: { ...kitDraftOf(job!).lines, [job!.kit.lines[1]!.id]: { quantity: '118', note: '' } } } })), note: 'A shortfall needs words: Send is held until they are written.' },
    { id: 'kit-done', label: 'Kit received: confirmed', model: recordCase(jobOf(), 'kit', () => ({ end: { kind: 'kit', lines: 3, short: 1 } })), note: 'Each line with what was counted; a short line with its note and photo.' },
    { id: 'kit-photo', label: 'Kit received: photo of damage', model: recordCase(kitJob(), 'kit', (job) => ({ photo: { line: { seq: job!.kit.lines[1]!.seq, name: job!.kit.lines[1]!.item.name }, busy: false, heldReason: null, problem: null } })), note: 'The DS photo capture: the camera or a file; faces kept out of the picture.' },
    { id: 'kit-refused', label: 'Kit received: refused (changed meanwhile)', model: recordCase(kitJob(), 'kit', () => ({ refusal: { act: 'kit', words: { key: 'problem.changed' } } })) },
    { id: 'kit-waiting', label: 'Kit received: our kit not sent yet', model: recordCase(proposedJob('ACCEPTED'), 'kit') },
    // Send back
    { id: 'sendback', label: 'Send back: what comes back', model: recordCase(backJob(), 'sendback'), note: 'Finished and scrap per operation (scrap with a reason), unused material per kit line, your DDT (DPR 472/1996), parcels, the day, who carries; partial send-backs allowed.' },
    { id: 'sendback-review', label: 'Send back: review before it goes', model: recordCase(backJob(), 'sendback', (job) => ({ review: { job: job!, draft: { ...returnDraftOf(job!, TODAY), ddtNumber: 'LP-122', ddtDate: TODAY, rows: { [job!.operations[0]!.id]: { finished: '56', scrapped: '2', reasonCode: 'STAIN' } } }, busy: false, heldReason: null, problem: null } })) },
    { id: 'sendback-held', label: 'Send back: scrap without a reason', model: recordCase(backJob(), 'sendback', (job) => ({ returns: { ...returnDraftOf(job!, TODAY), rows: { [job!.operations[0]!.id]: { finished: '56', scrapped: '2', reasonCode: '' } } } })), note: 'Review is held with the reason.' },
    { id: 'sendback-sent', label: 'Send back: announced', model: recordCase(backJob(), 'sendback', () => ({ end: { kind: 'returns', pieces: 58, day: dayAt(2) } })), note: '“We expect 58 pieces on …”.' },
    { id: 'sendback-nothing', label: 'Send back: nothing with you yet', model: recordCase(proposedJob(), 'sendback') },
    // A new job, its answer
    { id: 'new', label: 'A new job: accept or decline', model: recordCase(newJob(), 'kit'), note: 'The answer at the top: Accept (primary) and Decline; the band’s Accept on a phone moves to the action bar.' },
    { id: 'accept', label: 'Pop-up: accept the job', model: recordCase(newJob(), 'kit', (job) => ({ accept: { number: job!.number, job, loading: false, draft: ACCEPT_DRAFT, today: TODAY, person: 'Rosa Prova', busy: false, heldReason: null, problem: null } })) },
    { id: 'accept-move', label: 'Pop-up: accept with another day', model: recordCase(newJob(), 'kit', (job) => ({ accept: { number: job!.number, job, loading: false, draft: { mode: 'move', proposedDate: dayAt(16), reason: 'Due macchine ferme fino a lunedì.' }, today: TODAY, person: 'Rosa Prova', busy: false, heldReason: null, problem: null } })) },
    { id: 'decline', label: 'Pop-up: decline the job', model: recordCase(newJob(), 'kit', (job) => ({ decline: { number: job!.number, draft: { ...DECLINE_DRAFT, reason: 'NO_CAPACITY' }, tried: false, busy: false, heldReason: null, problem: null } })) },
    { id: 'accepted', label: 'Accepted', model: recordCase(proposedJob('ACCEPTED'), 'progress', () => ({ end: { kind: 'accepted', proposedDate: null, kitDay: dayAt(1) } })), note: '“Accepted — we send the kit on … with our DDT.”' },
    { id: 'proposed', label: 'A day proposed, our answer pending', model: recordCase(proposedJob(), 'progress') },
    { id: 'proposed-refused', label: 'A day proposed, we kept ours', model: recordCase(proposedJob('REFUSED'), 'progress') },
    // Documents and messages
    { id: 'documents', label: 'Documents', model: recordCase(backJob(), 'documents'), note: 'The job sheet (a new tab, printed for the bench), our kit DDT, your DDTs, your photos.' },
    { id: 'messages', label: 'Messages', model: recordCase(jobOf(), 'messages'), note: 'The job’s shared thread; “Ask a question” scrolls here.' },
    { id: 'sheet', label: 'Job sheet (new tab, for the bench)', model: (locale) => ({ shell: shellOf(locale, { path: '/jobs', band: { title: words(locale)('sheet.title', { number: 'SC-2026-0012' }) } }), body: { kind: 'sheet', model: { state: 'ready', job: jobOf() } } }) },
    // Who and what
    { id: 'preview', label: 'An office preview', model: recordCase(kitJob(), 'kit', () => ({ facts: { ...FACTS, preview: true } }), { preview: true }), note: 'Every act is held: a preview reads, it never acts.' },
    { id: 'viewer', label: 'A colleague who may only read', model: recordCase(kitJob(), 'kit', () => ({ facts: viewer })) },
    { id: 'loading', label: 'Loading', model: recordCase(null, 'progress', () => ({ state: 'loading' })) },
    { id: 'error', label: 'The job could not be read', model: recordCase(null, 'progress', () => ({ state: 'error' })) },
    { id: 'missing', label: 'Not one of your jobs', model: recordCase(null, 'progress', () => ({ state: 'missing' })) },
  ],
})
