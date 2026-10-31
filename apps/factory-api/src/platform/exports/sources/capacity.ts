import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { decimalText, type ExportLocale } from '@nexus/factory-domain/views/exports'
import { officeContextOf } from '../../../modules/planning/access'
import { capacity } from '../../../modules/planning/capacity/capacity'
import type { CapacityLaneView, CapacityQuery } from '../../../modules/planning/capacity/contract'
import { listSettings } from '../../../modules/planning/settings/settings'
import { defineExportSource, type ExportColumn } from '../source'

/**
 * Planning › Capacity & load (SCR-123, `/planning/capacity`): the export of the list as the screen shows it, one row per
 * line and work centre of a site. The address is the screen's (apps/factory-web areas/planning/capacity model.ts
 * controlsOf): `?site=` (a site of the screen's company the person plans, else the first by code, as the screen picks it
 * from GET /planning/settings), `?from=` `?to=` (days; default: the API's, today and four weeks on), `?bucket=DAY|WEEK|
 * MONTH|PLAN` (default WEEK), `?tile=over|free|most` (the lanes the tile shows); `?cell=` only opens a dialog. Read
 * through planning's own capacity read (planning.view over the site); a bad period is the read's own refusal in words.
 * Not paged: every lane of the site.
 *
 * The bucket columns are the screen's `b:<bucket key>` (`b:2026-W45`, `b:2026-11-02`, `b:2026-11`): one per bucket of the
 * period, so they are answered by name (a column id the period's buckets name) beside the fixed lane, whole period and
 * row end. Each load cell says booked of available standard minutes and the load, as the screen's load bar does. Per line
 * and work centre only: no person, no money (the row end's "people" is the lane's capacity count, never a worker).
 */

type Lane = CapacityLaneView & { readonly locale: ExportLocale }
type Load = { readonly availableMinutes: string; readonly bookedMinutes: string; readonly loadPct: string | null; readonly overMinutes: string; readonly workingDays?: number }

const TILES = ['over', 'free', 'most'] as const
type Tile = (typeof TILES)[number]
const BUCKETS = ['DAY', 'WEEK', 'MONTH', 'PLAN'] as const
type Bucket = (typeof BUCKETS)[number]
const DAY = /^\d{4}-\d{2}-\d{2}$/
const BUCKET_COLUMN = /^b:(\d{4}-(?:W\d{2}|\d{2}(?:-\d{2})?))$/

interface Query {
  readonly site: string | null
  readonly from: string | null
  readonly to: string | null
  readonly bucket: Bucket
  readonly tile: Tile | null
}

const fill = (template: string, params: Readonly<Record<string, string | number>>): string => template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''))
const plural = (key: string, count: number): string => `${key}_${count === 1 ? 'one' : 'other'}`
const number = (value: string | number, locale: ExportLocale): string => decimalText(String(value), locale)

/** A load as the screen's load bar says it: "1240 / 2400 min · 52%" (+ over), no working time, or booked alone. */
function loadText(load: Load, locale: ExportLocale, words: (code: string) => string): string {
  const available = Number(load.availableMinutes)
  const booked = Number(load.bookedMinutes)
  if (!(available > 0)) {
    const none = words(load.workingDays === 0 ? 'load.closed' : 'load.none')
    return booked > 0 ? `${none} · ${fill(words('load.booked'), { booked: number(load.bookedMinutes, locale) })}` : none
  }
  const parts = [fill(words('load.minutes'), { booked: number(load.bookedMinutes, locale), available: number(load.availableMinutes, locale) })]
  if (load.loadPct !== null) parts.push(fill(words('load.percent'), { pct: number(load.loadPct, locale) }))
  if (Number(load.overMinutes) > 0) parts.push(fill(words('load.over'), { over: number(load.overMinutes, locale) }))
  return parts.join(' · ')
}

/** The lanes a tile shows (the screen's lanesOf): over 100 % this week, with free minutes in the period, the most loaded lane. */
function lanesOf(answer: Awaited<ReturnType<typeof capacity>>, tile: Tile | null): CapacityLaneView[] {
  const thisWeek = (lane: CapacityLaneView) => lane.cells.find((cell) => cell.from <= answer.today && answer.today <= cell.to) ?? null
  switch (tile) {
    case 'over':
      return answer.lanes.filter((lane) => Number(thisWeek(lane)?.loadPct ?? 0) > 100)
    case 'free':
      return answer.lanes.filter((lane) => Number(lane.overall.availableMinutes) > Number(lane.overall.bookedMinutes))
    case 'most': {
      const most = answer.tiles.mostLoadedThisWeek
      return most ? answer.lanes.filter((lane) => lane.kind === most.kind && lane.id === most.id) : []
    }
    default:
      return [...answer.lanes]
  }
}

/** The column of one bucket (`b:<key>`): the lane's cell of that bucket. */
const bucketColumn = (key: string): ExportColumn<Lane> => ({
  value: (lane, words) => {
    const cell = lane.cells.find((entry) => entry.key === key)
    return cell ? loadText(cell, lane.locale, words) : null
  },
})

const FIXED: Record<string, ExportColumn<Lane>> = {
  lane: {
    value: (lane, words) => [lane.name, lane.code, words(`kind.${lane.kind}`), lane.kind === 'WORK_CENTRE' && lane.workCentreKind ? lane.workCentreKind : null].filter((part): part is string => !!part).join(' · '),
  },
  overall: { value: (lane, words) => loadText(lane.overall, lane.locale, words) },
  end: {
    value: (lane, words) => {
      const efficiency = fill(words('lane.efficiencyShort'), { efficiency: number(lane.efficiencyPct, lane.locale) })
      const people = fill(words(plural(`lane.peopleShort.${lane.kind}`, lane.people)), { people: String(lane.people) })
      const pattern = lane.pattern.source === 'DEFAULT' ? words('lane.patternDefault') : fill(words('lane.pattern'), { name: lane.pattern.name })
      return [efficiency, people, pattern].join(' · ')
    },
  },
}

/**
 * The columns: the fixed ones, and any `b:<bucket key>` asked for (the engine finds a column by Object.hasOwn and reads
 * it by name; the bucket columns are not listed by Object.keys, which names the fixed three).
 */
const COLUMNS = new Proxy(FIXED, {
  getOwnPropertyDescriptor(target, property) {
    if (typeof property === 'string' && !Object.hasOwn(target, property) && BUCKET_COLUMN.test(property)) {
      return { value: bucketColumn(property.slice(2)), writable: false, enumerable: false, configurable: true }
    }
    return Reflect.getOwnPropertyDescriptor(target, property)
  },
  has(target, property) {
    return (typeof property === 'string' && BUCKET_COLUMN.test(property)) || Reflect.has(target, property)
  },
  get(target, property, receiver) {
    if (typeof property === 'string' && !Object.hasOwn(target, property) && BUCKET_COLUMN.test(property)) return bucketColumn(property.slice(2))
    return Reflect.get(target, property, receiver)
  },
})

export const capacityLoad = defineExportSource<Query, Lane>({
  listKey: 'planning.capacity',
  permission: PLANNING_VIEW,
  query(address) {
    const day = (name: string) => {
      const value = address.get(name) ?? ''
      return DAY.test(value) ? value : null
    }
    const bucket = address.get('bucket') ?? ''
    const tile = address.get('tile') ?? ''
    return {
      site: address.get('site') || null,
      from: day('from'),
      to: day('to'),
      bucket: (BUCKETS as readonly string[]).includes(bucket) ? (bucket as Bucket) : 'WEEK',
      tile: (TILES as readonly string[]).includes(tile) ? (tile as Tile) : null,
    }
  },
  async read(caller, query, _cursor, _limit, options) {
    const locale: ExportLocale = options?.locale ?? 'it'
    const context = officeContextOf(caller)
    // The screen's sites: the ones it plans, of its company, by code; the asked one, else the first.
    const sites = (await listSettings(caller, context.companyId ? { companyId: context.companyId } : {})).sites.map((entry) => entry.site).sort((a, b) => a.code.localeCompare(b.code))
    const siteId = sites.find((site) => site.id === query.site)?.id ?? sites[0]?.id ?? null
    if (!siteId) return { rows: [], next: null }
    const ask: CapacityQuery = { siteId, ...(query.from ? { from: query.from } : {}), ...(query.to ? { to: query.to } : {}), bucket: query.bucket }
    const answer = await capacity(caller, ask)
    return { rows: lanesOf(answer, query.tile).map((lane) => ({ ...lane, locale })), next: null }
  },
  columns: COLUMNS,
  words: {
    it: {
      'kind.LINE': 'Linea',
      'kind.WORK_CENTRE': 'Centro di lavoro',
      'lane.efficiencyShort': 'Efficienza {efficiency}%',
      'lane.peopleShort.LINE_one': '{people} persona',
      'lane.peopleShort.LINE_other': '{people} persone',
      'lane.peopleShort.WORK_CENTRE_one': '{people} postazione',
      'lane.peopleShort.WORK_CENTRE_other': '{people} postazioni',
      'lane.pattern': '{name}',
      'lane.patternDefault': 'Turni predefiniti (nessun calendario)',
      'load.minutes': '{booked} / {available} min',
      'load.percent': '{pct}%',
      'load.over': '+{over} min oltre',
      'load.none': 'Orario di lavoro non impostato',
      'load.closed': 'Nessun orario di lavoro',
      'load.booked': '{booked} min prenotati',
    },
    en: {
      'kind.LINE': 'Line',
      'kind.WORK_CENTRE': 'Work centre',
      'lane.efficiencyShort': '{efficiency}% efficiency',
      'lane.peopleShort.LINE_one': '{people} person',
      'lane.peopleShort.LINE_other': '{people} people',
      'lane.peopleShort.WORK_CENTRE_one': '{people} station',
      'lane.peopleShort.WORK_CENTRE_other': '{people} stations',
      'lane.pattern': '{name}',
      'lane.patternDefault': 'Default shifts (no calendar)',
      'load.minutes': '{booked} / {available} min',
      'load.percent': '{pct}%',
      'load.over': '+{over} min over',
      'load.none': 'No working time set',
      'load.closed': 'No working time',
      'load.booked': '{booked} min booked',
    },
  },
})
