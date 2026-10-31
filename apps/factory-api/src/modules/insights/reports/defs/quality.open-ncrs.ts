import { choiceFilter, SITE_FILTER } from '@nexus/factory-domain/insights/reports/definition'
import { QUALITY_NCR_VIEW } from '@nexus/factory-domain/quality/ncr/permissions'
import { listNcrs } from '../../../quality/ncr/reads'
import { dayOf } from '../kit'
import { defineReport } from '../report'

/**
 * Quality › Open nonconformances (Today's "Open nonconformances" and "Containment overdue"; B-W2a-47): every NCR not
 * closed, how old it is and whether its containment is overdue, through the NCR list as the person (quality.ncr.view:
 * their companies and sites). No money; an owner is never a column (one record shows its people, a list does not).
 */

export default defineReport({
  key: 'quality.open-ncrs',
  area: 'quality',
  title: 'Open nonconformances',
  question: 'Which nonconformances are still open, and how old are they?',
  permission: QUALITY_NCR_VIEW,
  needs: null,
  columns: [
    { key: 'ncr', label: 'NCR', kind: 'text' },
    { key: 'title', label: 'Problem', kind: 'text' },
    { key: 'stage', label: 'Stage', kind: 'code', group: true, codes: ['OPEN', 'CONTAINED', 'DECIDED'] },
    { key: 'severity', label: 'Severity', kind: 'code', group: true, codes: ['CRITICAL', 'MAJOR', 'MINOR'] },
    { key: 'source', label: 'Found by', kind: 'code', group: true, codes: ['INSPECTION', 'BUNDLE', 'COMPLAINT', 'RETURN', 'SUPPLIER', 'AUDIT', 'OTHER'] },
    { key: 'defect', label: 'Defect', kind: 'text', group: true },
    { key: 'foundOn', label: 'Found on', kind: 'day' },
    { key: 'ageDays', label: 'Age (days)', kind: 'number' },
    { key: 'containment', label: 'Containment', kind: 'code', group: true, codes: ['OVERDUE', 'ON_TIME'] },
    { key: 'decisionsWaiting', label: 'Decisions waiting', kind: 'number', sum: true },
  ],
  filters: [
    SITE_FILTER,
    choiceFilter('severity', 'Severity', { CRITICAL: 'Critical', MAJOR: 'Major', MINOR: 'Minor' }),
    choiceFilter('overdue', 'Containment', { OVERDUE: 'Overdue only' }),
  ],
  groupBy: null,
  sources: 'Nonconformances, their actions and dispositions',
  definition:
    'Every nonconformance open, contained or decided, newest first. Age counts whole days since it was found; containment overdue = the containment (or an open action) is due before now. Decisions waiting = dispositions that wait for an approval.',
  numbers: ['quality.ncrOpen', 'quality.ncrOverdue'],
  mail: null,
  formats: ['CSV', 'PDF'],
  async read(run) {
    const severity = run.filters.severity as 'CRITICAL' | 'MAJOR' | 'MINOR' | null
    const answer = await listNcrs(run.caller, {
      open: true,
      ...(run.filters.site ? { siteId: run.filters.site } : {}),
      ...(severity ? { severity } : {}),
      ...(run.filters.overdue === 'OVERDUE' ? { overdue: true } : {}),
    })
    return {
      complete: !answer.truncated,
      rows: answer.items.slice(0, run.limit).map((item) => ({
        id: item.id,
        record: { type: 'Nonconformance', id: item.id, label: item.number },
        currency: null,
        cells: {
          ncr: item.number,
          title: item.title,
          stage: item.stage,
          severity: item.severity,
          source: item.source,
          defect: item.defect ? (run.locale === 'it' ? item.defect.labelIt : item.defect.labelEn) : null,
          foundOn: dayOf(item.foundOn),
          ageDays: item.ageDays,
          containment: item.containmentOverdue ? 'OVERDUE' : 'ON_TIME',
          decisionsWaiting: item.decisionsWaiting,
        },
      })),
    }
  },
})
