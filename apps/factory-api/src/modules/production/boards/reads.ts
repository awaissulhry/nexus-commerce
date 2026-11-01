import type { FastifyRequest } from 'fastify'
import { MODE_RULES } from '@nexus/factory-domain/auth/floor/modes'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { boardNoteOf } from '@nexus/factory-domain/production/boards/board'
import { heatMap } from '@nexus/factory-domain/production/boards/heatmap'
import { hourLabel } from '@nexus/factory-domain/production/boards/targets'
import { PRODUCTION_BOARDS_REASON, PRODUCTION_BOARDS_VIEW } from '@nexus/factory-domain/production/boards/permissions'
import { BOARD_REFUSALS } from '@nexus/factory-domain/production/boards/targets'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { requireDevice, shownLine } from '../../../platform/auth/floor/device'
import { siteScope } from '../../../platform/auth/floor/store'
import type { OfficeAuth } from '../../../platform/auth/sessions/office-auth'
import { asSystem } from '../../../platform/outbox/system'
import { devicePlaceOf } from '../calls/store'
import { assertMay, contextOf, knownLine, may, officeOf, readerOf, refuse, type BoardContext } from './access'
import { hourView, lineDays, shiftView, stationStates, totalsView, waitingOfSite } from './facts'
import { activeLinesOf, notesOf, reasonWordsOf, siteRow, siteView, type LineRow, type Reader } from './store'

/**
 * The line boards' reads (B-W2b-50; MES-161, MES-162, MES-166, ANA-007):
 *
 *   GET /production/boards/hourly?siteId&lineId&date   hour by hour (production.boards.view; office, and the team leader's
 *                                                      floor device for its line): per line its hours with pieces,
 *                                                      target, short, calls and the reason given; the totals so far, the
 *                                                      pace and the shift; the downtime reasons to pick from
 *   GET /production/boards/heatmap?siteId              the bundles waiting at each operation across the site's lines
 *                                                      (production.boards.view; office)
 *   GET /production/boards/tv?lineId                   the line TV board (production.boards.view): the office's preview in
 *                                                      a new tab; a signed-in floor device for its line
 *   GET /production/boards/display                     the same board for a DISPLAY device with nobody signed in (MES-166):
 *                                                      the device token alone (like GET /floor/device), its own line
 *
 * Line and team totals only, never a person (Statuto dei Lavoratori art. 4; Owner answer F2): no worker is read, no
 * figure per station but its call and machine state, no money.
 */

const nowOf = () => serverClock.now()

/** The site and day an office read asks for, or a floor device's own. */
async function siteOfQuery(db: Reader, siteId: string) {
  const site = await siteRow(db, siteId)
  if (!site) throw new NotFoundError('Site not found.')
  return site
}

/** The line a floor device shows: its own (a LINE or DISPLAY device), else its station's. */
async function floorLineId(caller: CommandCaller, context: BoardContext): Promise<string | null> {
  if (context.audience !== 'floor') return null
  return (await caller.withClient((db) => devicePlaceOf(db, context.deviceId))).lineId
}

export interface HourlyQuery {
  readonly siteId?: string | undefined
  readonly lineId?: string | undefined
  readonly date?: BusinessDate | undefined
}

/** GET /production/boards/hourly. */
export async function hourlyBoard(caller: CommandCaller, query: HourlyQuery) {
  const context = contextOf(caller)
  const now = nowOf()
  let lines: LineRow[]
  let siteId: string
  const lineId = query.lineId ?? (await floorLineId(caller, context))
  if (lineId) {
    const line = await knownLine(caller, context, lineId, PRODUCTION_BOARDS_VIEW)
    if (query.siteId && query.siteId !== line.siteId) throw new NotFoundError('Line not found.')
    lines = [line]
    siteId = line.siteId
  } else {
    if (!query.siteId) throw new ValidationError(context.audience === 'floor' ? 'This tablet shows no line: name the line.' : 'Name the site or the line.', [{ path: 'querystring/siteId', message: 'Name the site or the line.' }])
    siteId = query.siteId
    const site = await caller.withClient((db) => siteRow(db, query.siteId!))
    if (!site) throw new NotFoundError('Site not found.')
    assertMay(context, PRODUCTION_BOARDS_VIEW, { companyId: site.companyId, siteId: site.id }, 'Site')
    lines = await caller.withClient((db) => activeLinesOf(db, site.id))
  }
  return readerOf(caller, context).withClient(async (db) => {
    const site = await siteOfQuery(db, siteId)
    const today = businessDate(now, site.timezone)
    const day = query.date ?? today
    const { days, reasons } = await lineDays(db, site, lines, day, now)
    return {
      asOf: toUtcIso(now),
      site: siteView(site),
      day,
      today,
      lines: days.map((entry) => ({
        line: { id: entry.line.id, code: entry.line.code, name: entry.line.name },
        shift: shiftView(entry.shift),
        hours: entry.rows.map((row) => hourView(row, reasons)),
        totals: totalsView(entry.totals),
        canGiveReason: may(context, PRODUCTION_BOARDS_REASON, { companyId: entry.line.companyId, siteId: entry.line.siteId }),
      })),
      reasons: [...reasons.values()].filter((reason) => reason.active).map((reason) => ({ ...reasonWordsOf(reasons, reason.code), needsDetail: reason.needsDetail })),
    }
  })
}

/** GET /production/boards/heatmap (office). */
export async function wipHeatmap(caller: CommandCaller, query: { readonly siteId: string }) {
  const context = officeOf(caller)
  const now = nowOf()
  return caller.withClient(async (db) => {
    const site = await siteOfQuery(db, query.siteId)
    assertMay(context, PRODUCTION_BOARDS_VIEW, { companyId: site.companyId, siteId: site.id }, 'Site')
    const lines = await activeLinesOf(db, site.id)
    const { waiting, capped, stuckLimitHours } = await waitingOfSite(db, site.id, now)
    const map = heatMap(waiting, lines.map((line) => line.id))
    const extra = map.rows.filter((row) => row.lineId !== null && !lines.some((line) => line.id === row.lineId)).map((row) => row.lineId!)
    const names = new Map([...lines, ...(extra.length ? await db.line.findMany({ where: { id: { in: extra } }, select: { id: true, code: true, name: true } }) : [])].map((line) => [line.id, { id: line.id, code: line.code, name: line.name }]))
    return {
      asOf: toUtcIso(now),
      site: siteView(site),
      columns: [...map.columns],
      rows: map.rows.map((row) => ({ line: row.lineId ? (names.get(row.lineId) ?? null) : null, bundles: row.bundles, pieces: row.pieces, stuck: row.stuck, cells: [...row.cells] })),
      max: map.max,
      stuckLimitHours,
      capped,
    }
  })
}

/** The board of one line (the TV), read as `db` reads (the office as itself, the floor and the display in the tenant's system view). */
async function boardOf(db: Reader, line: LineRow, now: Date) {
  const site = (await siteRow(db, line.siteId))!
  const day = businessDate(now, site.timezone)
  const { days, reasons } = await lineDays(db, site, [line], day, now)
  const lineDay = days[0]!
  const { waiting, capped } = await waitingOfSite(db, site.id, now, line.id)
  const map = heatMap(
    waiting.filter((bundle) => bundle.lineId === line.id),
    [line.id],
  )
  const row = map.rows.find((entry) => entry.lineId === line.id)!
  const note = boardNoteOf(await notesOf(db, line.id, day))
  return {
    asOf: toUtcIso(now),
    line: { id: line.id, code: line.code, name: line.name },
    site: siteView(site),
    day,
    shift: shiftView(lineDay.shift),
    output: {
      ...totalsView(lineDay.totals),
      hours: lineDay.rows.map((hour) => ({
        hour: hour.hour,
        label: hourLabel(hour.hour),
        state: hour.state,
        done: hour.done,
        targetPieces: hour.target?.targetPieces ?? null,
        short: hour.short,
        // The code's words only: the typed words of a reason stay in the office and the line view.
        reason: hour.target?.row.shortReasonCode ? reasonWordsOf(reasons, hour.target.row.shortReasonCode) : null,
      })),
    },
    stations: await stationStates(db, line.id),
    wip: {
      bundles: row.bundles,
      pieces: row.pieces,
      stuck: row.stuck,
      operations: map.columns.map((column, index) => ({ ...row.cells[index]!, name: column.name })),
      capped,
    },
    quality: lineDay.quality,
    note: note ? { shiftLabel: note.shiftLabel, topics: [...note.topics], text: note.text, at: toUtcIso(note.updatedAt) } : null,
  }
}

/** GET /production/boards/tv: the office's preview of a line's TV, or a signed-in floor device's line. */
export async function tvBoard(caller: CommandCaller, query: { readonly lineId?: string | undefined }) {
  const context = contextOf(caller)
  const lineId = query.lineId ?? (await floorLineId(caller, context))
  if (!lineId) throw new ValidationError(context.audience === 'floor' ? 'This tablet shows no line: name the line.' : 'Name the line.', [{ path: 'querystring/lineId', message: 'Name the line.' }])
  const line = await knownLine(caller, context, lineId, PRODUCTION_BOARDS_VIEW)
  return readerOf(caller, context).withClient((db) => boardOf(db, line, nowOf()))
}

/**
 * GET /production/boards/display (MES-166, ANA-007): the line TV of a DISPLAY device, with nobody signed in (B-W2b-52: a
 * DISPLAY device never has a floor session). The device token alone (`requireDevice`, as GET /floor/device), only a
 * DISPLAY device (another one signs in and reads GET /production/boards/tv), only the line it shows (`shownLine`). Read in
 * the tenant's system view, pinned to the device's site: the board's line totals and nothing else.
 */
export async function displayBoard(auth: OfficeAuth, request: FastifyRequest) {
  const { device, token } = await requireDevice(auth, request)
  if (MODE_RULES[device.mode].landing !== 'LINE_BOARD') refuse(BOARD_REFUSALS.NOT_A_BOARD)
  const shown = await auth.database.withScope(siteScope(token), (client) => shownLine(client, device))
  if (!shown) refuse(BOARD_REFUSALS.NO_LINE)
  // The server clock, as every board read (the office's preview shows the same instant's figures).
  const now = nowOf()
  const board = await asSystem(auth.database, token.tenantId, String(request.id), async (db) => {
    const line = await db.line.findUnique({ where: { id: shown!.id }, select: { id: true, companyId: true, siteId: true, code: true, name: true, status: true } })
    if (!line || line.siteId !== token.siteId) refuse(BOARD_REFUSALS.NO_LINE)
    return boardOf(db, line!, now)
  })
  return { ...board, device: { id: device.id, name: device.name, mode: 'DISPLAY' as const } }
}
