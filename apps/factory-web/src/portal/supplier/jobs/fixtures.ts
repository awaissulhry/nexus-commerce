import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { Locale } from '../../../lib/i18n/locales'
import { listBandOf } from './band'
import { FACTS, jobsRead, newJob, PREFIX, ROWS, shellOf, TODAY, words } from './design-data'
import { ACCEPT_DRAFT, DECLINE_DRAFT, type PersonFacts } from './model'
import { JobsCase, type JobsCaseBuilder } from './view/JobsCase'
import type { JobsListViewModel } from './view/JobsListView'

/**
 * SCR-192 › Jobs (design portal.supplier.jobs: sec:chips, sec:job-cards, pop:accept-job, pop:decline-job; B-W2b-181),
 * MADE-UP data only: the New jobs (the default chip), every chip, selected jobs with the bulk actions, the accept pop-up
 * (as asked, another day), the decline pop-up, the bulk accept and its result, nothing yet, nothing matching, loading, an
 * error, offline with the last read, an office preview, a colleague who may not answer, and the page for a person without
 * it. Measure at 390 first (a workshop is on a phone), then 1440 and 1920.
 */

function listModel(over: Partial<JobsListViewModel> = {}): JobsListViewModel {
  return { state: 'ready', read: jobsRead(), chip: null, q: '', prefix: PREFIX, today: TODAY, selected: [], facts: FACTS, updates: 0, accept: null, decline: null, bulk: null, notice: null, offlineSince: null, ...over }
}

function listCase(build: (locale: Locale) => { model?: Partial<JobsListViewModel>; preview?: boolean }): JobsCaseBuilder {
  return (locale) => {
    const t = words(locale)
    const { model = {}, preview = false } = build(locale)
    const list = listModel(model)
    const read = list.read
    return {
      shell: shellOf(locale, {
        path: '/jobs',
        preview,
        band: listBandOf({ t, locale, asOf: read?.asOf ?? null, toAccept: read?.counts.toAccept ?? 0, onNewChip: read?.chip === 'NEW', acceptHeld: preview ? t('held.preview') : null, rows: read?.items.length ?? 0 }),
      }),
      body: { kind: 'list', model: list },
    }
  }
}

const ALL = (chip: (typeof ROWS)[number]['chip']) => jobsRead(chip)
const accepting = (over: Partial<NonNullable<JobsListViewModel['accept']>> = {}): JobsListViewModel['accept'] => ({ number: 'SC-2026-0012', job: newJob(), loading: false, draft: ACCEPT_DRAFT, today: TODAY, person: 'Rosa Prova', busy: false, heldReason: null, problem: null, ...over })
const viewer: PersonFacts = { ...FACTS, mayAct: { approve: false, comment: false, upload: false } }

export const designScreen = defineDesignScreen<JobsCaseBuilder>({
  screen: 'SCR-192',
  title: 'Workshop Jobs (portal.supplier.jobs)',
  view: JobsCase,
  cases: [
    { id: 'normal', label: 'New jobs to accept (the default chip)', model: listCase(() => ({})), note: 'Chips with counts; on a phone each job is a big card with ONE button (Accept or decline). The band accepts the new jobs. No price anywhere.' },
    { id: 'kit', label: 'Kit to confirm', model: listCase(() => ({ model: { chip: 'KIT', read: ALL('KIT') } })), note: 'The card’s one button opens the job on Kit received.' },
    { id: 'work', label: 'In progress (one late)', model: listCase(() => ({ model: { chip: 'WORK', read: ALL('WORK') } })), note: 'Finished of total as a progress bar; the due-back countdown; late in red; a proposed day under it; waiting for our kit has no button.' },
    { id: 'back', label: 'Ready to send back', model: listCase(() => ({ model: { chip: 'BACK', read: ALL('BACK') } })) },
    { id: 'done', label: 'Done', model: listCase(() => ({ model: { chip: 'DONE', read: ALL('DONE') } })) },
    { id: 'selected', label: 'Two jobs selected', model: listCase(() => ({ model: { selected: [ROWS[0]!.id, ROWS[1]!.id] } })), note: 'The bulk actions take the search’s place: “Accept 2 of 2 as asked” and Export 2.' },
    { id: 'accept', label: 'Pop-up: accept as asked', model: listCase(() => ({ model: { accept: accepting() } })), note: 'The job, its pieces per size, the kit day and the due-back day; Enter accepts; Esc closes and gives the focus back.' },
    { id: 'accept-move', label: 'Pop-up: propose another day', model: listCase(() => ({ model: { accept: accepting({ draft: { mode: 'move', proposedDate: '', reason: '' }, heldReason: { key: 'accept.held.date' } }) } })), note: 'Accept is held until the day and the reason are given.' },
    { id: 'accept-loading', label: 'Pop-up: reading the job', model: listCase(() => ({ model: { accept: accepting({ job: null, loading: true, heldReason: { key: 'held.reading' } }) } })) },
    { id: 'accept-refused', label: 'Pop-up: the job changed meanwhile', model: listCase(() => ({ model: { accept: accepting({ problem: { key: 'problem.changed' } }) } })) },
    { id: 'decline', label: 'Pop-up: decline', model: listCase(() => ({ model: { decline: { number: 'SC-2026-0012', draft: DECLINE_DRAFT, tried: false, busy: false, heldReason: { key: 'decline.held.reason' }, problem: null } } })) },
    { id: 'decline-other', label: 'Pop-up: decline for another reason', model: listCase(() => ({ model: { decline: { number: 'SC-2026-0012', draft: { reason: 'OTHER', note: '' }, tried: true, busy: false, heldReason: { key: 'decline.held.note' }, problem: null } } })), note: '“Other” needs a few words.' },
    { id: 'bulk', label: 'Pop-up: accept the new jobs as asked', model: listCase(() => ({ model: { bulk: { jobs: ROWS.slice(0, 2), person: 'Rosa Prova', busy: false, heldReason: null, result: null } } })) },
    { id: 'bulk-result', label: 'Pop-up: the result', model: listCase(() => ({ model: { bulk: { jobs: ROWS.slice(0, 2), person: 'Rosa Prova', busy: false, heldReason: null, result: { accepted: 1, refused: 1 } } } })), note: 'One command per job; a refused one is counted, nothing is hidden.' },
    { id: 'accepted', label: 'After an answer', model: listCase(() => ({ model: { notice: { tone: 'success', words: { key: 'end.acceptedKitOf', params: { number: 'SC-2026-0012', date: TODAY } } } } })) },
    { id: 'empty', label: 'No jobs right now', model: listCase(() => ({ model: { read: { ...jobsRead('NEW', []), chips: jobsRead().chips.map((chip) => ({ ...chip, count: 0 })), counts: { toAccept: 0, kitToConfirm: 0, readyToSendBack: 0, late: 0 } } } })) },
    { id: 'chip-empty', label: 'Nothing under a chip', model: listCase(() => ({ model: { chip: 'KIT', read: jobsRead('KIT', []) } })) },
    { id: 'no-match', label: 'Nothing matches the search', model: listCase(() => ({ model: { q: 'SC-9999', read: jobsRead('NEW', []) } })) },
    { id: 'loading', label: 'Loading', model: listCase(() => ({ model: { state: 'loading', read: null } })) },
    { id: 'error', label: 'The list could not be read', model: listCase(() => ({ model: { state: 'error', read: null } })), note: 'A failed read is never drawn as an empty list.' },
    { id: 'offline', label: 'No connection', model: listCase(() => ({ model: { offlineSince: TODAY + 'T08:42:00Z', facts: { ...FACTS, offline: true } } })), note: '“No connection — showing what was loaded at …”; every button that sends is held with the reason.' },
    { id: 'updates', label: 'Changes waiting', model: listCase(() => ({ model: { updates: 2 } })), note: 'Rows never move under the cursor: “2 updates · Show”.' },
    { id: 'preview', label: 'An office preview', model: listCase(() => ({ preview: true, model: { facts: { ...FACTS, preview: true } } })), note: 'Every button is held: a preview reads, it never acts.' },
    { id: 'viewer', label: 'A colleague who may not answer', model: listCase(() => ({ model: { facts: viewer } })), note: '“Your access lets you read our jobs, not answer them: ask your admin.”' },
    {
      id: 'no-access',
      label: 'Not part of the person’s access',
      model: (locale) => ({ shell: shellOf(locale, { path: '/jobs', band: { title: words(locale)('list.title') } }), body: { kind: 'noAccess', admins: ['Anna Esempio'] } }),
      note: 'A typed or old address: who to ask, and Home. Not in the navigation (fails closed).',
    },
  ],
})
