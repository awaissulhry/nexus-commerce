import { choiceFilter, SITE_FILTER } from '@nexus/factory-domain/insights/reports/definition'
import { PRODUCTION_REPORTS_VIEW } from '@nexus/factory-domain/production/reports/permissions'
import { DAILY_REPORT_KEY } from '@nexus/factory-domain/production/reports/subscriptions'
import { dailyView, previousWorkingDayOf, readDaily, siteFor } from '../../../production/reports/daily'
import { actorOfRun, runSites } from '../kit'
import { defineReport } from '../report'

/**
 * Production › Daily production (B-W2a-38's report in the pack; MES-301): what each line and work centre made on a day of
 * one site, good, scrapped and reworked, with the line's efficiency, through the production reports' own read
 * (production.reports.view at the site). The same rows the morning e-mail sends (production REPORT_KEYS
 * `production.daily`): its Schedule tab lists those subscriptions. Per line or work centre, never per person; a line of
 * fewer than 5 people has its efficiency hidden (it would be close to each person's).
 */

export default defineReport({
  key: 'production.daily',
  area: 'production',
  title: 'Daily production',
  question: 'What did each line make on the last working day?',
  permission: PRODUCTION_REPORTS_VIEW,
  needs: null,
  columns: [
    { key: 'lane', label: 'Line or work centre', kind: 'text' },
    { key: 'kind', label: 'Kind', kind: 'code', group: true, codes: ['LINE', 'WORK_CENTRE'] },
    { key: 'good', label: 'Good', kind: 'number', sum: true },
    { key: 'scrap', label: 'Scrap', kind: 'number', sum: true },
    { key: 'rework', label: 'Rework', kind: 'number', sum: true },
    { key: 'efficiencyPct', label: 'Efficiency', kind: 'percent', people: true },
  ],
  filters: [SITE_FILTER, choiceFilter('day', 'Day', { LAST_WORKING_DAY: 'Last working day', TODAY: 'Today so far' }, 'LAST_WORKING_DAY')],
  groupBy: null,
  sources: 'Floor scans, work orders, line capacity and the site calendar',
  definition:
    'One site and one day (the first site you see unless you pick one). Good = garments through the line’s last operation; scrap and rework at any of its operations. Efficiency = earned standard minutes ÷ (people × the line’s working minutes), hidden for a line of fewer than 5 people.',
  numbers: ['production.goodLastDay'],
  mail: DAILY_REPORT_KEY,
  formats: ['CSV', 'PDF'],
  async read(run) {
    const sites = await runSites(run, PRODUCTION_REPORTS_VIEW)
    const target = sites[0]
    if (!target) return { complete: true, rows: [] }
    const actor = actorOfRun(run)
    return run.caller.withClient(async (db) => {
      const site = await siteFor(db, actor, PRODUCTION_REPORTS_VIEW, target.id)
      const day = run.filters.day === 'TODAY' ? run.today : await previousWorkingDayOf(db, site.id, run.today)
      const view = dailyView(await readDaily(db, site, day))
      return {
        complete: true,
        range: { from: day, to: day },
        applied: { site: { value: site.id, label: `${site.code} · ${site.name}` } },
        rows: view.lanes.map((lane) => ({
          id: `${lane.kind}:${lane.id}`,
          record: null,
          currency: null,
          people: lane.kind === 'LINE' ? lane.people : undefined,
          cells: { lane: `${lane.code} · ${lane.name}`, kind: lane.kind, good: lane.good, scrap: lane.scrap, rework: lane.rework, efficiencyPct: lane.efficiencyPct },
        })),
      }
    })
  },
})
