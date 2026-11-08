import { isLocale, localeOf, type Locale } from '../lib/i18n/locales'

/**
 * The floor app's rules that need no screen and no API (SCR-020, 021, 022, 024, 025; design 02-sections-floor):
 * the station's mode, the home tiles a person may see, the language of the screen, the badge format, the enrolment
 * code of a set-up link, and the worker notice's pages. Pure, so the tests hold them.
 */

// ---- the station's mode (design floor.home "W1 per mode"; back-end need 4: a mode comes from the work centre) ----

export const WORK_CENTRE_KINDS = ['CUTTING', 'SEWING', 'ASSEMBLY', 'FINISHING', 'INSPECTION', 'PACKING', 'SUBCONTRACT'] as const
export type WorkCentreKind = (typeof WORK_CENTRE_KINDS)[number]

export const FLOOR_MODES = ['cutting', 'sewing', 'packing', 'inspection', 'warehouse'] as const
export type FloorMode = (typeof FLOOR_MODES)[number]

/**
 * CUTTING → cutting; SEWING, ASSEMBLY → sewing; FINISHING, PACKING → packing; INSPECTION → inspection. A device with
 * no station is a warehouse device (W1 has no other way to say it); a subcontract station has no floor mode: Scan only.
 * B-W2b-67: a line tablet or a person's own phone with no station is no warehouse device: no station's tiles, no mode.
 */
export function modeOf(station: { workCentreKind: WorkCentreKind } | null, deviceMode?: string | null): FloorMode | null {
  if (station === null) return deviceMode === 'LINE' || deviceMode === 'PHONE' || deviceMode === 'DISPLAY' ? null : 'warehouse'
  switch (station.workCentreKind) {
    case 'CUTTING':
      return 'cutting'
    case 'SEWING':
    case 'ASSEMBLY':
      return 'sewing'
    case 'FINISHING':
    case 'PACKING':
      return 'packing'
    case 'INSPECTION':
      return 'inspection'
    case 'SUBCONTRACT':
      return null
  }
}

// ---- the home tiles (design floor.home "tiles": the station's mode AND the person's permissions, fail closed) ----

export const TILE_KEYS = ['mywork', 'operation', 'cut', /* B-W2b-121 */ 'fabriccut', 'bundles', 'receive', 'pick', /* B-W2a-76 */ 'returnsin', 'kits', 'labels', 'pack', /* B-W2b-115 */ 'incoming', 'final', /* B-W2b-105 */ 'inline', 'machine', /* B-W2b-67 */ 'clock', /* B-W2b-68 */ 'myday', /* B-W2b-145 */ 'training', /* B-W2b-70 */ 'help', /* B-W2b-137 */ 'incident', 'lineview', 'scan'] as const
export type TileKey = (typeof TILE_KEYS)[number]

export interface TileRule {
  readonly key: TileKey
  /** The permission its page's API needs: without it the tile is not shown. */
  readonly permission: string
  /** The modes whose stations show it; every mode for Scan. */
  readonly modes: readonly FloorMode[] | 'all'
  /** B-W2b-67: also on these devices with no station's mode (B-W2b-73: a line tablet and a phone differ, design Modes). */
  readonly devices?: readonly ('LINE' | 'PHONE')[]
  /** Its page exists in this build: only built tiles open; the others say "coming" (never a dead tile). */
  readonly built: boolean
  /** It takes scans that name the worker: held while the worker notice blocks scans. */
  readonly takesScans: boolean
}

/**
 * In the order a station shows them; Scan anything last. Each tile's permission is the one its page's API needs (fail
 * closed). Built: Scan (B-W0-29); Operation, Cut a hide, Bundles, Pick & issue, Final inspection (the floor tasks:
 * SCR-090, 094, 095, 093, 097); Receive (SCR-092); Garment labels (SCR-096). Their pages: `TASK_ROUTES` (tasks/routes.ts).
 */
export const TILE_RULES: readonly TileRule[] = [
  // SCR-089 (B-W2a-74): My work, the station's queue from the published plan (GET /production/dispatch/station asks
  // floor.work). At every station mode; not at the warehouse (a device with no station has no queue: its task inbox is W2b).
  { key: 'mywork', permission: 'floor.work', modes: ['sewing', 'cutting', 'packing', 'inspection'], built: true, takesScans: false },
  // design floor.operation: sewing, cutting, packing; and the inspection bench, where a routing's scanned INSPECTION
  // operation is reported (the scans module wants a station of the operation's kind, else a reason).
  { key: 'operation', permission: 'production.scan', modes: ['sewing', 'cutting', 'packing', 'inspection'], built: true, takesScans: true },
  { key: 'cut', permission: 'production.cut', modes: ['cutting'], built: true, takesScans: true },
  // SCR-182 (B-W2b-121): Fabric cutting at the cutting table, after Cut a hide (design floor.fabriccut Modes: cutting; tile family
  // Cutting): the ticket, the lay, both ends counted, the cut, ply stickers, fabric used, recuts, to sewing. Its API asks production.cut.
  { key: 'fabriccut', permission: 'production.cut', modes: ['cutting'], built: true, takesScans: true },
  { key: 'bundles', permission: 'production.bundles', modes: ['cutting'], built: true, takesScans: true },
  { key: 'receive', permission: 'inventory.receive', modes: ['warehouse'], built: true, takesScans: true },
  { key: 'pick', permission: 'inventory.issue', modes: ['warehouse'], built: true, takesScans: true },
  // SCR-180 / SCR-181 (B-W2a-76): a customer return at the dock (its API asks sales.returns.receive) and subcontract kits
  // out and back (purchasing.subcontract.kit opens the task; Receive back asks .receive inside it). Warehouse tablets only.
  { key: 'returnsin', permission: 'sales.returns.receive', modes: ['warehouse'], built: true, takesScans: true },
  { key: 'kits', permission: 'purchasing.subcontract.kit', modes: ['warehouse'], built: true, takesScans: true },
  // SCR-096: garment labels at the final operation (production.serials: the API's permission; the print goes through it).
  { key: 'labels', permission: 'production.serials', modes: ['packing'], built: true, takesScans: true },
  { key: 'pack', permission: 'shipping.pack', modes: ['packing'], built: true, takesScans: true },
  // SCR-175 (B-W2b-115): Incoming inspection at the inspection bench (design floor.incoming Modes: inspection; tile family Quality,
  // before Final inspection so it stays on Home's first page of an inspection tablet, B-W2b-73); its writes ask
  // quality.incoming.record (floor_inspector). Its scans read a lot's label, a hide tag or an inspection number.
  { key: 'incoming', permission: 'quality.incoming.record', modes: ['inspection'], built: true, takesScans: true },
  { key: 'final', permission: 'quality.inspections.view', modes: ['inspection'], built: true, takesScans: true },
  // SCR-176 (B-W2b-105): In-line inspection at the inspection bench and on a team leader's line tablet (design floor.inline Modes:
  // inspection, supervisor); its writes ask quality.inprocess.record (floor_inspector, team_leader). Its scans read a bundle's ticket.
  { key: 'inline', permission: 'quality.inprocess.record', modes: ['inspection'], devices: ['LINE'], built: true, takesScans: true },
  // SCR-179 (B-W2a-73): a machine problem at every station mode (design floor.machine); its API asks plant.report, which
  // every floor role holds (Owner answer H1). Never held by the worker notice: a safety report names the station instead.
  { key: 'machine', permission: 'plant.report', modes: ['sewing', 'cutting', 'warehouse', 'packing', 'inspection'], built: true, takesScans: false },
  // SCR-170 (B-W2b-67): Clock in & out on every tablet (design floor.clock Modes: a phone; the build also on a line tablet, the
  // lead's own). Not a scan: the worker notice does not hold it; the ATTENDANCE gate does, on its page.
  { key: 'clock', permission: 'floor.work', modes: ['sewing', 'cutting', 'warehouse', 'packing', 'inspection'], devices: ['LINE', 'PHONE'], built: true, takesScans: false },
  // SCR-171 (B-W2b-68): My day at a sewing station and on a person's own phone (design floor.myday Modes); the operator's menu opens it
  // everywhere else. Its figures ask the PIN on the page; floor.work is what its API asks.
  { key: 'myday', permission: 'floor.work', modes: ['sewing'], devices: ['PHONE'], built: true, takesScans: false },
  // SCR-231 (B-W2b-145): Training & PPE sign-off at every station mode and a team leader's line tablet (design floor.training Modes:
  // sewing, cutting, warehouse, packing, inspection, supervisor); floor.work is what its API asks. A badge scanned there is the
  // signer's, never a production scan: the worker notice does not hold it. Online only (a PIN is never queued), said on its page.
  { key: 'training', permission: 'floor.work', modes: ['sewing', 'cutting', 'warehouse', 'packing', 'inspection'], devices: ['LINE'], built: true, takesScans: false },
  // SCR-172 (B-W2b-70): Call for help at every station mode (design floor.help); floor.work sends, and a call always goes out
  // (never held by the worker notice). The frame's Help button opens it from any screen too.
  { key: 'help', permission: 'floor.work', modes: ['sewing', 'cutting', 'warehouse', 'packing', 'inspection'], built: true, takesScans: false },
  // SCR-230 (B-W2b-137): Report an incident at every station mode, a line tablet and a phone (design floor.incident Modes); floor.work
  // reports (anyone at the station, as a help call). Never held by the worker notice; kept on the first page (KEPT_FIRST).
  { key: 'incident', permission: 'floor.work', modes: ['sewing', 'cutting', 'warehouse', 'packing', 'inspection'], devices: ['LINE', 'PHONE'], built: true, takesScans: false },
  // SCR-168 (B-W2b-70): the team leader's Line view, wherever they sign in (design floor.supervisor; floor.lead).
  { key: 'lineview', permission: 'floor.lead', modes: ['sewing', 'cutting', 'warehouse', 'packing', 'inspection'], devices: ['LINE', 'PHONE'], built: true, takesScans: false },
  { key: 'scan', permission: 'floor.work', modes: 'all', built: true, takesScans: true },
]

/** The most tiles on one home screen (A2 §3.1). */
export const MAX_TILES = 6

export type TileHeld = 'notice' | 'coming' | null

export interface HomeTile {
  readonly key: TileKey
  readonly held: TileHeld
}

/**
 * The tiles kept on the first page, last, in TILE_RULES' order: B-W2b-137 Report an incident (it must never fall off a full
 * Home: someone hurt does not look for a More tile; plan §10), B-W2b-70 the Line view (the lead's first job, no other way to it)
 * and Scan anything.
 */
const KEPT_LAST: readonly TileKey[] = ['incident', 'lineview', 'scan']

/**
 * Every tile a person has here: the mode's tiles they hold the permission for, then Scan. With no station's mode, the tiles of
 * that device (`devices`; a subcontract station: Scan only). Held: "Read the notice first" while the notice blocks scans
 * (before "coming": it is the person's to fix), else "coming" for a page not built yet. A person without `floor.work` sees none
 * (nothing to do here). All of them, however many: the scan router reads this list; `tilePage` cuts what one page shows.
 */
export function homeTiles(mode: FloorMode | null, permissions: readonly string[], noticeBlocksScans: boolean, deviceMode?: string | null): HomeTile[] {
  const held = new Set(permissions)
  const onThis = (rule: TileRule) => rule.modes === 'all' || (mode === null ? rule.devices?.some((device) => device === deviceMode) === true : rule.modes.includes(mode))
  const fits = TILE_RULES.filter((rule) => onThis(rule) && held.has(rule.permission) && held.has('floor.work'))
  const kept = fits.filter((rule) => KEPT_LAST.includes(rule.key))
  return [...fits.filter((rule) => !kept.includes(rule)), ...kept].map((rule) => ({ key: rule.key, held: noticeBlocksScans && rule.takesScans ? 'notice' : rule.built ? null : 'coming' }))
}

export interface TilePage {
  readonly tiles: readonly HomeTile[]
  /** This page, from 0 (a page past the end is the last one). */
  readonly page: number
  readonly pages: number
  /** The tiles on the next page: 0 on the last one, where the More tile goes back to the first. */
  readonly more: number
}

/**
 * B-W2b-73 (design floor.home "More than six: a 'More' tile opens a second page of tiles"; factory-domain literacy tilePages):
 * nothing falls off a full Home. Up to six tiles are one page. More: each page holds five and the More tile, the kept tiles on
 * the first.
 */
export function tilePage(tiles: readonly HomeTile[], page: number): TilePage {
  if (tiles.length <= MAX_TILES) return { tiles, page: 0, pages: 1, more: 0 }
  const room = MAX_TILES - 1
  const kept = tiles.filter((tile) => KEPT_LAST.includes(tile.key))
  const rest = tiles.filter((tile) => !kept.includes(tile))
  const sheets: (readonly HomeTile[])[] = [[...rest.slice(0, room - kept.length), ...kept]]
  for (let at = room - kept.length; at < rest.length; at += room) sheets.push(rest.slice(at, at + room))
  const now = Math.min(Math.max(0, page), sheets.length - 1)
  return { tiles: sheets[now]!, page: now, pages: sheets.length, more: sheets[now + 1]?.length ?? 0 }
}

// ---- language (PLT-062: the screen follows the signed-in person; before a sign-in the device's, or the one picked) ----

/** The screen's language: the person's (when we speak it), else the one picked on this screen, else the tenant's, else Italian. */
export function floorLocale(input: { person?: string | null; picked?: string | null; tenant?: string | null }): Locale {
  return localeOf(input.person) ?? (isLocale(input.picked) ? input.picked : null) ?? localeOf(input.tenant) ?? 'it'
}

// ---- badges (factory-domain auth/floor/badge: 128 bits as 26 Crockford base32 characters) ----

const BADGE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const BADGE = new RegExp(`^[${BADGE_ALPHABET}]{26}$`)

/** A scanned code that has the badge's shape (the API decides whether it opens anything). */
export function isBadgeCode(value: string): boolean {
  const code = value.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0')
  return value.length <= 64 && BADGE.test(code)
}

// ---- the set-up link (the Office's QR code: `<web>/floor/enrol#token=<code>`) ----

/** The enrolment code of a scanned or typed set-up link or code; null when it is neither. */
export function enrolmentCodeOf(value: string): string | null {
  const text = value.trim()
  if (text === '') return null
  const hash = text.indexOf('#')
  if (hash >= 0) {
    const token = new URLSearchParams(text.slice(hash + 1)).get('token')
    return token && token.trim() !== '' ? token.trim() : null
  }
  if (/^https?:\/\//i.test(text)) return null
  // `<tenantId>.<siteId>.<enrolmentId>.<secret>`: four parts; the API checks the rest.
  return text.split('.').length === 4 && text.length <= 200 ? text : null
}

// ---- the worker notice (design floor.notice "reader": short pages, Next and Back, the last page acknowledges) ----

/** The longest page, in characters, before a paragraph starts the next one. */
export const NOTICE_PAGE_CHARS = 420

/** The notice's paragraphs (blank-line separated) grouped into short pages; never a paragraph cut in two. */
export function noticePages(body: string): string[] {
  const paragraphs = body
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '')
  const pages: string[][] = []
  let size = 0
  for (const paragraph of paragraphs) {
    const page = pages[pages.length - 1]
    if (page && size + paragraph.length <= NOTICE_PAGE_CHARS && page.length < 2) {
      page.push(paragraph)
      size += paragraph.length
    } else {
      pages.push([paragraph])
      size = paragraph.length
    }
  }
  return pages.length === 0 ? [''] : pages.map((page) => page.join('\n\n'))
}

// ---- the idle sign-out (design frame.idle: the site's idle minutes, a 30-second countdown) ----

export const IDLE_WARN_MS = 30_000

/** When the overlay starts: the site's idle minutes less the countdown (at least one minute of quiet). */
export function idleWarnAfterMs(idleMinutes: number): number {
  const minutes = Number.isFinite(idleMinutes) && idleMinutes > 0 ? idleMinutes : 10
  return Math.max(60_000, minutes * 60_000 - IDLE_WARN_MS)
}

// ---- the new PIN (factory-domain pinProblems decides; the pad says the two rules first and catches a mismatch) ----

export type NewPinProblem = 'length' | 'repeat' | 'run' | null

/** The two rules the screen says before typing (not one digit six times, not digits in a row); the API checks the rest. */
export function newPinProblem(pin: string): NewPinProblem {
  if (!/^\d{6}$/.test(pin)) return 'length'
  if (new Set(pin).size === 1) return 'repeat'
  const steps = new Set<number>()
  for (let index = 1; index < pin.length; index++) steps.add((Number(pin[index]) - Number(pin[index - 1]) + 10) % 10)
  if (steps.size === 1 && (steps.has(1) || steps.has(9))) return 'run'
  return null
}

// ---- sign-in by name (design floor.signin "pick-name": a letter strip jumps the names; no keyboard) ----

/** The first letters the roster's names have, A–Z. */
export function rosterLetters(roster: readonly { name: string }[]): string[] {
  return [...new Set(roster.map((entry) => entry.name.trim().charAt(0).toLocaleUpperCase()).filter(Boolean))].sort((a, b) => a.localeCompare(b))
}
