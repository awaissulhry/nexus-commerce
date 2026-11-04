import { PLANT_VIEW } from '@nexus/factory-domain/plant/permissions'
import { CHECK_OUTCOMES, type CheckOutcome } from '@nexus/factory-domain/plant/statutory/rules'
import { listResults } from '../../../modules/plant/statutory/reads'
import { defineExportSource } from '../source'

/**
 * Plant › Maintenance › Preventive & statutory checks › Check register (`/plant/preventive`, the register's list frame
 * `plant.preventive.register` of SCR-266; B-W2b-142 on B-W2b-124's read; QHS-205, D.Lgs. 81/2008 art. 71): every result as
 * the register shows it, newest first, through the module's own read (plant.view over its sites): day, machine, site,
 * check with its law, who did it (the outside body or the inspector, in words), outcome with remarks and what it corrects
 * or is corrected by, the report files on record (else missing), the job a failed check made, next due, kept until. The
 * address is the list's own (web areas/plant/preventive model.ts): `?missing=1` (the tile "Reports missing"),
 * `?outcome=`, `?siteId=`. No money, no worker anywhere.
 */

type Row = Awaited<ReturnType<typeof listResults>>['results'][number]
type Query = { readonly siteId?: string; readonly outcome?: CheckOutcome; readonly reportMissing?: boolean }

const fill = (template: string, params: Readonly<Record<string, string>>): string => template.replace(/\{(\w+)\}/g, (all, name: string) => (name in params ? params[name]! : all))

export const checkRegister = defineExportSource<Query, Row>({
  listKey: 'plant.preventive.register',
  permission: PLANT_VIEW,
  page: '/plant/preventive',
  query(address) {
    const siteId = address.get('siteId') ?? ''
    const outcome = address.get('outcome') ?? ''
    return {
      ...(/^[0-9a-f-]{36}$/i.test(siteId) ? { siteId } : {}),
      ...((CHECK_OUTCOMES as readonly string[]).includes(outcome) ? { outcome: outcome as CheckOutcome } : {}),
      ...(address.get('missing') === '1' ? { reportMissing: true } : {}),
    }
  },
  async read(caller, query, cursor, limit) {
    const page = await listResults(caller, { ...query, limit: Math.min(limit, 500), ...(cursor ? { cursor } : {}) })
    return { rows: page.results, next: page.nextCursor }
  },
  columns: {
    performedOn: { value: (row) => ({ day: row.performedOn }) },
    machine: { value: (row) => row.machine.assetNumber },
    site: { value: (row) => `${row.site.code} · ${row.site.name}` },
    check: { value: (row, words) => `${words('lang') === 'it' ? row.checkType.labelIt : row.checkType.labelEn} — ${row.checkType.legalBasis}` },
    by: { value: (row) => row.performedBy },
    outcome: {
      value: (row, words) =>
        [
          words(`outcome.${row.outcome}`),
          row.remarks,
          row.corrects ? fill(words('corrects'), { date: row.corrects.performedOn }) : null,
          row.correctedBy ? fill(words('correctedBy'), { date: row.correctedBy.performedOn }) : null,
        ]
          .filter(Boolean)
          .join(' · '),
    },
    report: { value: (row, words) => (row.reports.length > 0 ? row.reports.map((file) => file.originalName).join(', ') : words(row.reportOnFile ? 'report.byCorrected' : row.inForce ? 'report.missing' : 'report.none')) },
    job: { value: (row) => row.jobs.map((job) => job.number).join(', ') },
    nextDue: { value: (row) => (row.nextDueOn ? { day: row.nextDueOn } : null) },
    keptUntil: { value: (row) => ({ day: row.keptUntil }) },
  },
  words: {
    it: {
      lang: 'it',
      'outcome.PASSED': 'Positivo',
      'outcome.PASSED_WITH_REMARKS': 'Positivo con osservazioni',
      'outcome.FAILED': 'Negativo',
      corrects: 'corregge l’esito del {date}',
      correctedBy: 'corretto dall’esito del {date}',
      'report.byCorrected': 'Sull’esito che corregge',
      'report.missing': 'Mancante',
      'report.none': '—',
    },
    en: {
      lang: 'en',
      'outcome.PASSED': 'Passed',
      'outcome.PASSED_WITH_REMARKS': 'Passed with remarks',
      'outcome.FAILED': 'Failed',
      corrects: 'corrects the result of {date}',
      correctedBy: 'corrected by the result of {date}',
      'report.byCorrected': 'On the result it corrects',
      'report.missing': 'Missing',
      'report.none': '—',
    },
  },
})
