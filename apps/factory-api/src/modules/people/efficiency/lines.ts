import { toUtcIso } from '@nexus/factory-domain/core/time'
import { HOW_COMPUTED, lineGroupsOf, totalsOf, type LineFigures } from '@nexus/factory-domain/people/efficiency/rules'
import { PEOPLE_EFFICIENCY_VIEW } from '@nexus/factory-domain/people/efficiency/permissions'
import { gateClosedWords } from '@nexus/factory-domain/people/privacy/gate'
import { PEOPLE_FIGURES_VIEW } from '@nexus/factory-domain/people/privacy/permissions'
import { STATION_SITE } from '@nexus/factory-domain/production/labour/rules'
import type { CommandCaller } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { scanSubjectFor } from '../../production/settings/subject'
import { rangeOf, siteFor } from '../attendance/access'
import { may, officeOf } from '../employees/access'
import { holdsFigureRole } from '../privacy/access'
import { legalGateFor } from '../privacy/gate'
import { hideSmallGroups, privacySettingsFor } from '../privacy/groups'
import { refuseAnyPerson, requireLine, type PersonKeys } from './access'
import { PERSON_NOT_ALLOWED } from './person'
import { lineFacts, lineTargets, previousRange, siteLines, type DayRange, type Place, type Reader, type SiteLines } from './store'

/**
 * Line efficiency (B-W2b-44; MES-247, ANA-017; design people.efficiency "Tiles", "Lines over time"): earned against attended
 * minutes per line, side by side with the minutes on standard work and the minutes planned; never per person. Each line and
 * each line's day is a group of its own: under the company's minimum size it shows nothing, and the totals add up only the
 * lines shown. Attended and planned minutes are read only where the site's ATTENDANCE legal gate is on (off: empty, in words);
 * the figures here are groups, so they need no PERFORMANCE gate (Statuto dei Lavoratori art. 4).
 */

const ATTENDANCE_OFF = "Attended minutes are not shown: this site's attendance purpose is off (Statuto dei Lavoratori art. 4 c.2)."
const PROVISIONAL = 'Attended minutes are provisional: some attendance days are not approved yet.'
const HIDDEN_LEFT_OUT = 'Lines with too few people are left out of the totals too.'

interface Query extends PersonKeys {
  readonly siteId: string
  readonly from?: string | undefined
  readonly to?: string | undefined
  readonly lineId?: string | undefined
  readonly compare?: 'previous' | undefined
}

async function lineFiguresFor(db: Reader, place: Place, setup: SiteLines, range: DayRange, now: Date, attendanceOpen: boolean, lineId: string | undefined) {
  const read = await lineFacts(db, place, setup.sources, range, now, attendanceOpen, lineId)
  const groups = lineGroupsOf(read.facts, attendanceOpen, (fact) => fact.lineId ?? '')
  const masked = await hideSmallGroups(db, place.companyId, groups)
  const shown = masked.rows.filter((entry) => !entry.tooFew).map((entry) => entry.row.figures)
  return { masked, tiles: totalsOf(shown, attendanceOpen), traineeDays: read.traineeDays, provisional: read.provisional }
}

/** By code; the row of work on no line last. */
const byLineCode = (a: { readonly line: { readonly code: string } | null }, b: { readonly line: { readonly code: string } | null }): number => (a.line && b.line ? a.line.code.localeCompare(b.line.code) : a.line ? -1 : b.line ? 1 : 0)

/** Whether "One person's figures" may be offered here: nothing about any person. */
async function individualPanel(db: Reader, context: OfficeContext, place: Place, now: Date) {
  if (!(await legalGateFor(db, place.id, 'PERFORMANCE')).open) return { available: false, words: gateClosedWords('PERFORMANCE') }
  if ((await scanSubjectFor(db, place.id)) === 'STATION') return { available: false, words: STATION_SITE.message }
  const where = { companyId: place.companyId, siteId: place.id }
  const settings = await privacySettingsFor(db, place.companyId)
  const available = may(context, PEOPLE_FIGURES_VIEW, where) && (await holdsFigureRole(db as Parameters<typeof holdsFigureRole>[0], context.actorId, settings.figureRoleKeys, where, now))
  return { available, words: available ? "Opened one person at a time, with a purpose: recorded, no comparison with others, no export, no print." : PERSON_NOT_ALLOWED }
}

/** GET /people/efficiency: the tiles, one row per line, what is left out and why. */
export async function overview(caller: CommandCaller, query: Query) {
  const context = officeOf(caller)
  refuseAnyPerson(query)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const site = await siteFor(db, context, query.siteId, [PEOPLE_EFFICIENCY_VIEW])
    const setup = await siteLines(db, site)
    requireLine(setup, query.lineId)
    const range = rangeOf(query, site.timezone, now)
    const attendanceOpen = (await legalGateFor(db, site.id, 'ATTENDANCE')).open
    const current = await lineFiguresFor(db, site, setup, range, now, attendanceOpen, query.lineId)
    const earlier = query.compare === 'previous' ? previousRange(range) : null
    const previous = earlier ? await lineFiguresFor(db, site, setup, earlier, now, attendanceOpen, query.lineId) : null
    const lines = current.masked.rows
      .map(({ row, tooFew, words }) => {
        const line = row.key === '' ? null : (setup.lines.get(row.key) ?? null)
        return { line: line ? { id: line.id, code: line.code, name: line.name } : null, people: row.people ?? null, tooFew, words, figures: row.figures as LineFigures }
      })
      .sort(byLineCode)
    return {
      siteId: site.id,
      from: range.from,
      to: range.to,
      asOf: toUtcIso(now),
      attendance: { open: attendanceOpen, provisional: current.provisional },
      tiles: current.tiles,
      previous: earlier && previous ? { from: earlier.from, to: earlier.to, tiles: previous.tiles } : null,
      lines,
      hiddenGroups: current.masked.hidden,
      traineeDaysLeftOut: current.traineeDays,
      individual: await individualPanel(db, context, site, now),
      how: { formulas: [...HOW_COMPUTED.formulas], sources: [...HOW_COMPUTED.sources], exclusions: [...HOW_COMPUTED.exclusions] },
      words: [...(attendanceOpen ? [] : [ATTENDANCE_OFF]), ...(current.provisional ? [PROVISIONAL] : []), ...(current.masked.hidden > 0 ? [HIDDEN_LEFT_OUT] : [])],
    }
  })
}

/** GET /people/efficiency/trend: per line, per day. Every point is a group of its own: one series per line, never per person. */
export async function trend(caller: CommandCaller, query: Query) {
  const context = officeOf(caller)
  refuseAnyPerson(query)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const site = await siteFor(db, context, query.siteId, [PEOPLE_EFFICIENCY_VIEW])
    const setup = await siteLines(db, site)
    requireLine(setup, query.lineId)
    const range = rangeOf(query, site.timezone, now)
    const attendanceOpen = (await legalGateFor(db, site.id, 'ATTENDANCE')).open
    const read = await lineFacts(db, site, setup.sources, range, now, attendanceOpen, query.lineId)
    const groups = lineGroupsOf(read.facts, attendanceOpen, (fact) => `${fact.lineId ?? ''}|${fact.day}`)
    const masked = await hideSmallGroups(db, site.companyId, groups)
    const targets = await lineTargets(db, site)
    const series = new Map<string, { date: string; tooFew: boolean; figures: LineFigures }[]>()
    for (const { row, tooFew } of masked.rows) {
      const [lineKey = '', date = ''] = row.key.split('|')
      series.set(lineKey, [...(series.get(lineKey) ?? []), { date, tooFew, figures: row.figures as LineFigures }])
    }
    const lines = [...series.entries()]
      .map(([key, points]) => {
        const line = key === '' ? null : (setup.lines.get(key) ?? null)
        return {
          line: line ? { id: line.id, code: line.code, name: line.name } : null,
          targetPercent: line ? (targets.byLine.get(line.id) ?? targets.site) : null,
          points: points
            .sort((a, b) => a.date.localeCompare(b.date))
            .map(({ date, tooFew, figures }) => ({ date, tooFew, efficiency: figures.efficiency, onStandardEfficiency: figures.onStandardEfficiency, earnedMinutes: figures.earnedMinutes, attendedMinutes: figures.attendedMinutes })),
        }
      })
      .sort(byLineCode)
    return { siteId: site.id, from: range.from, to: range.to, lines, words: attendanceOpen ? [] : [ATTENDANCE_OFF] }
  })
}
