import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_COMPANIES, OWNER_PERMISSIONS } from '../../../../shell/design-data'
import { STEP_UP_CLOSED } from '../../shared/model'
import { inShell } from '../../shared/fixtures'
import { designScreen as privacyScreen } from '../fixtures'
import { LOADING, privacyCan, type PrivacyViewModel } from '../model'
import { DepthDutiesView } from '../requests/DepthDuties'
import { PrivacyView } from '../view/PrivacyView'
import type { RetentionList, Rule, Sweep } from './api'
import { draftOfRule, newRuleDraft, retentionCan, type RetentionViewModel } from './model'
import { RetentionView } from './view/RetentionView'

/**
 * SCR-662 Admin › Privacy › Retention rules with made-up data: the seed's kind of rules (every period made up and said
 * UNVERIFIED), invented sweeps. Drawn where it lives: the fifth list of Privacy & notices (SCR-086).
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const [demo, esempio] = DEMO_COMPANIES as unknown as [{ id: string; code: string; name: string }, { id: string; code: string; name: string }]
const at = (day: number, hour = 2, minute = 50) => new Date(Date.UTC(2026, 10, day, hour - 1, minute)).toISOString()

const MANAGER = [...OWNER_PERMISSIONS, 'privacy.view', 'privacy.manage', 'privacy.requests.view', 'privacy.requests.manage', 'privacy.erase', 'privacy.retention.manage']
const VIEWER = [...OWNER_PERMISSIONS, 'privacy.view']

const may = { allowed: true, held: null }
const no = (code: NonNullable<Rule['actions']['change']['held']>['code']) => ({ allowed: false, held: { code } })

function sweep(n: number, extra: Partial<Sweep>): Sweep {
  return { id: uid('2626', n), ruleId: uid('2525', n), mode: 'REPORT', keepMonths: 12, thenAction: 'DELETE', cutoffOn: '2025-11-14', status: 'DONE', startedAt: at(14), finishedAt: at(14, 2, 51), due: 0, applied: 0, held: 0, failed: 0, heldWhy: null, failures: [], requestedBy: null, ...extra }
}

function rule(n: number, extra: Partial<Rule>): Rule {
  const active = extra.active ?? true
  const applyOn = extra.applyOn ?? false
  return {
    id: uid('2525', n),
    key: `retention:${extra.recordType ?? 'ReportRun'}:all`,
    company: null,
    recordType: 'ReportRun',
    known: true,
    keepMonths: 12,
    thenAction: 'DELETE',
    legalReason: 'GDPR art. 5(1)(e): only as long as needed to answer questions about a report.',
    active,
    applyOn,
    applyOnAt: null,
    applyOnBy: null,
    unverified: true,
    holdsAll: null,
    version: 1,
    lastSweep: null,
    actions: { change: may, switchOff: active ? may : no('SWITCHED_OFF'), switchOn: active ? no('ACTIVE') : may, applyOn: !active ? no('SWITCHED_OFF') : applyOn ? no('APPLYING') : may, applyOff: !active ? no('SWITCHED_OFF') : applyOn ? may : no('NOT_APPLYING'), sweepNow: active ? may : no('SWITCHED_OFF') },
    ...extra,
  }
}

const RULES: Rule[] = [
  rule(1, { recordType: 'CronRun', keepMonths: 3, legalReason: 'Security log practice: 3 months of job runs to trace a failure.', applyOn: true, applyOnAt: at(10, 11, 0), applyOnBy: { id: uid('3333', 1), name: 'Alex Demo' }, lastSweep: sweep(1, { mode: 'APPLY', keepMonths: 3, due: 214, applied: 214, cutoffOn: '2026-08-14' }), actions: { change: may, switchOff: may, switchOn: no('ACTIVE'), applyOn: no('APPLYING'), applyOff: may, sweepNow: may } }),
  rule(2, { recordType: 'ExportJob', company: demo, keepMonths: 3, legalReason: 'Exports are files of personal data: 3 months.', active: false, holdsAll: { code: 'NEVER_DELETED' }, actions: { change: no('NO_ACTION'), switchOff: no('SWITCHED_OFF'), switchOn: may, applyOn: no('SWITCHED_OFF'), applyOff: no('SWITCHED_OFF'), sweepNow: no('SWITCHED_OFF') } }),
  rule(3, { recordType: 'InboundEmail', company: demo, keepMonths: 24, thenAction: 'ANONYMISE', legalReason: 'Mails answered: 2 years for follow-ups and claims.', holdsAll: null, lastSweep: sweep(3, { keepMonths: 24, thenAction: 'ANONYMISE', due: 37, held: 0, cutoffOn: '2024-11-14' }) }),
  rule(4, { recordType: 'IntegrationErrorItem', company: demo, keepMonths: 6, legalReason: 'Closed errors: 6 months to see a pattern again.', lastSweep: sweep(4, { keepMonths: 6, due: 12, cutoffOn: '2026-05-14' }) }),
  rule(5, { recordType: 'Invoice', company: demo, keepMonths: 120, thenAction: 'ARCHIVE', legalReason: 'c.c. art. 2220: 10 years; DPR 633/72 art. 39.', holdsAll: { code: 'ARCHIVE_STAYS' }, lastSweep: sweep(5, { status: 'FAILED', keepMonths: 120, thenAction: 'ARCHIVE', failures: [{ code: 'DB_REFUSED', recordId: null }] }) }),
  rule(6, { recordType: 'ReportRun', lastSweep: sweep(6, { due: 41 }) }),
]

const LIST: RetentionList = {
  rules: RULES,
  types: [
    { recordType: 'ReportRun', companyScoped: false, actions: ['DELETE'], holdsAll: null },
    { recordType: 'CronRun', companyScoped: false, actions: ['DELETE'], holdsAll: null },
    { recordType: 'IntegrationErrorItem', companyScoped: true, actions: ['DELETE'], holdsAll: null },
    // B-W2b-GF1 (F54): the sweep may anonymise a settled mail (the Owner's decision of 15 Nov 2026).
    { recordType: 'InboundEmail', companyScoped: true, actions: ['ANONYMISE'], holdsAll: null },
    { recordType: 'ExportJob', companyScoped: true, actions: [], holdsAll: { code: 'NEVER_DELETED' } },
    { recordType: 'Invoice', companyScoped: true, actions: ['ARCHIVE'], holdsAll: { code: 'ARCHIVE_STAYS' } },
  ],
  ledgers: [{ recordType: 'AuditLog' }, { recordType: 'ReadLog' }, { recordType: 'SecurityEvent' }, { recordType: 'StepUpAttempt' }],
  datedPurges: [
    { key: 'measurementPhotos', job: 'sales.measurementPhotos', recordType: 'StoredFile' },
    { key: 'portalCodes', job: 'portal.purgeCodes', recordType: 'PortalSignInCode' },
    { key: 'linkDrafts', job: 'links.purgeDrafts', recordType: 'LinkDraft' },
    { key: 'largeUploads', job: 'files.expireLargeUploads', recordType: 'FileUploadSession' },
    { key: 'exportFiles', job: 'exports.expire', recordType: 'ExportJob' },
    { key: 'accessPackages', job: 'privacy.purgePackages', recordType: 'StoredFile' },
  ],
  keptForGood: ['DataRequest', 'ErasureRecord', 'RetentionRule', 'RetentionSweep'],
  sweep: { schedule: '50 2 * * *' },
}

const SWEEPS: Sweep[] = [sweep(11, { mode: 'APPLY', keepMonths: 3, due: 214, applied: 214, cutoffOn: '2026-08-14', startedAt: at(14) }), sweep(12, { keepMonths: 3, due: 214, cutoffOn: '2026-08-13', startedAt: at(13), requestedBy: { id: uid('3333', 1), name: 'Alex Demo' } }), sweep(13, { status: 'FAILED', keepMonths: 3, startedAt: at(12), failures: [{ code: 'DB_REFUSED', recordId: null }] })]

type Case = { model: RetentionViewModel; permissions: readonly string[] }

function base(extra: Partial<RetentionViewModel> = {}, permissions: readonly string[] = MANAGER): Case {
  return {
    permissions,
    model: { can: retentionCan(permissions), companyId: demo.id, companies: [demo, esempio].map((company) => ({ id: company.id, name: company.name })), list: { value: LIST, problem: null }, selected: [], busyRule: null, updates: 0, timeZone: 'Europe/Rome', dialog: null, stepUp: STEP_UP_CLOSED, notice: null, ...extra },
  }
}

const PAGE = privacyScreen.cases.find((item) => item.id === 'owner')!.model.model

function RetentionDesign({ model }: { model: Case }) {
  const page: PrivacyViewModel = { ...PAGE, can: privacyCan(model.permissions), view: 'retention' }
  const rules = model.model.list.value?.rules ?? []
  return inShell(
    '/admin/privacy',
    createElement(PrivacyView, {
      model: page,
      slots: {
        retention: createElement(RetentionView, { model: model.model }),
        duties: createElement(DepthDutiesView, { model: { requests: page.can.requests ? { open: 6, late: 1 } : null, retention: { rules: rules.filter((entry) => entry.active).length, applying: rules.filter((entry) => entry.active && entry.applyOn).length } } }),
      },
    }),
    model.permissions,
  )
}

const ruleById = (n: number) => RULES.find((entry) => entry.id === uid('2525', n))!

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-662',
  title: 'Retention rules',
  view: RetentionDesign,
  cases: [
    { id: 'normal', label: 'Administrator: the rules, one applying', model: base(), note: 'Every period UNVERIFIED; Job runs applies (switched on with a fresh code); the rest only report; Exports off and held (never deleted). Below: the ledgers kept for good (never purged), the dated purges, what is kept for good.' },
    { id: 'selected', label: 'Three selected: Sweep 2 now', model: base({ selected: [uid('2525', 1), uid('2525', 4), uid('2525', 6)] }), note: 'The applying rule is left out of a batch (said under the list).' },
    { id: 'rule-new', label: 'Add a rule', model: base({ dialog: { kind: 'rule', draft: { ...newRuleDraft(demo.id), recordType: 'IntegrationErrorItem', thenAction: 'DELETE', keepMonths: '6' }, busy: false, problem: null } }), note: 'What the sweep does with it, in words; UNVERIFIED said.' },
    { id: 'rule-shorten', label: 'Change: a shorter period asks a fresh code', model: base({ dialog: { kind: 'rule', draft: { ...draftOfRule(ruleById(3)), keepMonths: '12' }, busy: false, problem: null } }), note: '"Shortening needs the Owner (fresh code)."' },
    { id: 'rule-no-action', label: 'Add a rule: a type no sweep may change', model: base({ dialog: { kind: 'rule', draft: { ...newRuleDraft(demo.id), recordType: 'ExportJob', keepMonths: '3' }, busy: false, problem: null } }), note: 'Add held with why: the rule could only report.' },
    { id: 'apply', label: 'Switch on to apply?', model: base({ dialog: { kind: 'apply', ruleId: uid('2525', 6), busy: false, problem: null } }), note: 'ActionConfirm with an acknowledgement; then the fresh code.' },
    { id: 'apply-step-up', label: 'Switch on: the fresh code', model: base({ dialog: { kind: 'apply', ruleId: uid('2525', 6), busy: true, problem: null }, stepUp: { open: true, busy: false, sentence: 'dp.stepUp.apply', problem: null } }) },
    { id: 'sweeps', label: 'A rule\'s sweeps', model: base({ dialog: { kind: 'sweeps', ruleId: uid('2525', 1), sweeps: { value: SWEEPS, problem: null } } }) },
    { id: 'sweeps-failed', label: 'The sweeps did not load', model: base({ dialog: { kind: 'sweeps', ruleId: uid('2525', 1), sweeps: { value: null, problem: 'dp.problem.unavailable' } } }) },
    { id: 'swept', label: 'Swept: a report, nothing changed', model: base({ notice: { tone: 'success', key: 'dp.ret.done.swept', params: { type: 'ReportRun' } } }) },
    { id: 'updates', label: 'Changed meanwhile: "1 update · Show"', model: base({ updates: 1 }) },
    { id: 'read-only', label: 'privacy.view only: every step held', model: base({}, VIEWER), note: 'No Add a rule; the row menu says the right each step needs.' },
    { id: 'empty', label: 'No rule yet', model: base({ list: { value: { ...LIST, rules: [] }, problem: null } }) },
    { id: 'loading', label: 'Loading', model: base({ list: LOADING }) },
    { id: 'error', label: 'The rules did not load', model: base({ list: { value: null, problem: 'dp.problem.unavailable' } }) },
  ],
})
