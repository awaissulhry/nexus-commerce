import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, PREFIX } from '../../shared/fixtures'
import type { Job, JobList, JobRun } from './api'
import { JobsCard, type JobsModel } from './view/JobsCard'

/**
 * Made-up scheduled jobs and runs for the design review (B-W2b-415, SCR-601; design admin.security sec:jobs, pop:run-now):
 * invented times, replicas and errors. Design-only.
 */

const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 10, day, hour, minute)).toISOString()
const rid = (n: number) => `0190f0e2-c0c0-7000-8000-${String(n).padStart(12, '0')}`

const run = (n: number, over: Partial<JobRun> = {}): JobRun => ({
  id: rid(n),
  trigger: 'SCHEDULE',
  status: 'SUCCEEDED',
  scheduledAt: at(14, 9, 40),
  startedAt: at(14, 9, 40),
  finishedAt: at(14, 9, 40),
  durationMs: 820,
  error: null,
  ranOn: 'scheduler-demo:4242',
  byPerson: false,
  ...over,
})

const job = (key: string, over: Partial<Job> = {}): Job => ({
  key,
  known: true,
  schedule: '*/5 * * * *',
  timeZone: 'Europe/Rome',
  policy: 'check',
  gate: null,
  switchedOn: null,
  state: 'ok',
  lastRun: run(1),
  lastFinished: run(1),
  nextRunAt: at(14, 9, 45),
  missedAt: null,
  failures7d: 0,
  runs7d: 2016,
  waiting: 0,
  runNow: { held: null },
  ...over,
})

const FAILED_RUN = run(2, { status: 'FAILED', startedAt: at(14, 0, 20), finishedAt: at(14, 0, 21), scheduledAt: at(14, 0, 20), error: 'Error: the database did not answer in time (example).' })

export const DEMO_JOBS: readonly Job[] = [
  job('compliance.certificateExpiry', { schedule: '20 0 * * *', state: 'missed', lastRun: run(3, { startedAt: at(13, 0, 20), finishedAt: at(13, 0, 20) }), lastFinished: run(3, { startedAt: at(13, 0, 20), finishedAt: at(13, 0, 20) }), missedAt: at(13, 23, 20), nextRunAt: at(14, 23, 20), runs7d: 6 }),
  job('invoicing.sdiPoll', { state: 'failing', lastRun: FAILED_RUN, lastFinished: FAILED_RUN, failures7d: 3 }),
  job('files.scanPending', { state: 'stuck', lastRun: run(4, { status: 'RUNNING', finishedAt: null, durationMs: null, startedAt: at(14, 8, 55) }) }),
  job('outbox.lag', { schedule: '* * * * *', nextRunAt: at(14, 9, 41), runs7d: 10080 }),
  job('alerts.evaluate'),
  job('currency.ecbDaily', { schedule: '30 16,18 * * 1-5', gate: 'ecbFeed', switchedOn: false, runNow: { held: 'SWITCHED_OFF' }, nextRunAt: at(16, 15, 30), runs7d: 10 }),
  job('notifications.digest', { schedule: '*/15 * * * *', policy: 'schedule', runNow: { held: 'SCHEDULE_ONLY' } }),
  job('purchasing.confirmationReminders', { schedule: '0 9 * * *', policy: 'schedule', runNow: { held: 'SCHEDULE_ONLY' }, nextRunAt: at(15, 8, 0), runs7d: 7 }),
  job('roles.syncTemplates', { schedule: '15 3 * * *', nextRunAt: at(15, 2, 15), runs7d: 7, waiting: 1, runNow: { held: 'ASKED' } }),
  job('integrations.collectErrors', { schedule: '* * * * *', state: 'never', lastRun: null, lastFinished: null, runs7d: 0 }),
]

const answer = (over: Partial<JobList> = {}): JobList => ({ jobs: [...DEMO_JOBS], outbox: { waiting: 2, dead: 1 }, canRun: true, waitingKnown: true, asOf: at(14, 9, 42), ...over })

function model(over: Partial<JobsModel> = {}): JobsModel {
  return { prefix: PREFIX, list: { answer: answer(), problem: null }, selected: [], confirm: null, history: null, notice: null, ...over }
}

const HISTORY: readonly JobRun[] = [
  run(10, { trigger: 'RUN_NOW', byPerson: true, startedAt: at(14, 9, 30), finishedAt: at(14, 9, 30), scheduledAt: at(14, 9, 30) }),
  FAILED_RUN,
  run(11, { startedAt: at(13, 0, 20), finishedAt: at(13, 0, 21) }),
  run(12, { startedAt: at(12, 0, 20), finishedAt: at(12, 0, 20), durationMs: 184_000 }),
]

function JobsDesign({ model: c }: { model: JobsModel | null }) {
  return inShell('/admin/security', createElement('div', { className: 'fw-adm fw-sec' }, c ? createElement(JobsCard, { model: c }) : null))
}

export const designScreen = defineDesignScreen<JobsModel | null>({
  screen: 'SCR-601',
  title: 'Security & health › Jobs and integrations',
  view: JobsDesign,
  cases: [
    { id: 'normal', label: 'Every job: one missed, one failing, one stuck', model: model(), note: 'Jobs that need a person first. A job that sends at its time or waits for a switch is held with why.' },
    { id: 'selected', label: 'Three ticked: Run 2 now', model: model({ selected: ['compliance.certificateExpiry', 'outbox.lag', 'notifications.digest'] }) },
    { id: 'run-now', label: "pop:run-now — Run 'Certificate expiry check' now?", model: model({ confirm: { keys: ['compliance.certificateExpiry'], busy: false, problem: null } }), note: 'What it does, its last result, that it runs once in the cluster for this business only.' },
    { id: 'run-now-many', label: 'Run 2 now (one left out)', model: model({ selected: ['compliance.certificateExpiry', 'outbox.lag', 'notifications.digest'], confirm: { keys: ['compliance.certificateExpiry', 'outbox.lag', 'notifications.digest'], busy: false, problem: null } }) },
    { id: 'run-now-refused', label: 'Run now refused: the scheduler cannot be reached', model: model({ confirm: { keys: ['outbox.lag'], busy: false, problem: 'problem.unavailable' } }) },
    { id: 'history', label: 'A job’s runs', model: model({ history: { key: 'invoicing.sdiPoll', runs: HISTORY, nextBefore: rid(12), problem: null, loadingMore: false } }), note: 'A Run now by a person, a failed run with its error, older runs.' },
    { id: 'history-switch', label: 'A job waiting for a switch', model: model({ history: { key: 'currency.ecbDaily', runs: [], nextBefore: null, problem: null, loadingMore: false } }) },
    { id: 'history-loading', label: 'Runs loading', model: model({ history: { key: 'outbox.lag', runs: null, nextBefore: null, problem: null, loadingMore: false } }) },
    { id: 'notice', label: 'After Run now', model: model({ notice: { key: 'aih.runNow.done', tone: 'success', params: { count: 1 } } }) },
    { id: 'read-only', label: 'Read only: no right to run', model: model({ list: { answer: answer({ canRun: false }), problem: null } }), note: 'Every box held: an administrator runs jobs.' },
    { id: 'waiting-unknown', label: 'The Run-now list cannot be read', model: model({ list: { answer: answer({ waitingKnown: false, jobs: DEMO_JOBS.map((entry) => ({ ...entry, waiting: null })) }), problem: null } }) },
    { id: 'empty', label: 'No job reported yet', model: model({ list: { answer: answer({ jobs: [] }), problem: null } }) },
    { id: 'loading', label: 'Loading', model: model({ list: { answer: null, problem: null } }) },
    { id: 'error', label: 'Not available', model: model({ list: { answer: null, problem: 'problem.unavailable' } }), note: 'The other sections keep working.' },
    { id: 'no-permission', label: 'No right to see it (absent)', model: null, note: 'Without security.view the section is absent.' },
  ],
})
