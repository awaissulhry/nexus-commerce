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
 */
export function modeOf(station: { workCentreKind: WorkCentreKind } | null): FloorMode | null {
  if (station === null) return 'warehouse'
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

export const TILE_KEYS = ['operation', 'cut', 'bundles', 'receive', 'pick', 'labels', 'pack', 'final', 'scan'] as const
export type TileKey = (typeof TILE_KEYS)[number]

export interface TileRule {
  readonly key: TileKey
  /** The permission its page's API needs: without it the tile is not shown. */
  readonly permission: string
  /** The modes whose stations show it; every mode for Scan. */
  readonly modes: readonly FloorMode[] | 'all'
  /** Its page exists in this build: only built tiles open; the others say "coming" (never a dead tile). */
  readonly built: boolean
  /** It takes scans that name the worker: held while the worker notice blocks scans. */
  readonly takesScans: boolean
}

/**
 * In the order a station shows them; Scan anything last. Each tile's permission is the one its page's API needs (fail
 * closed). Built: Scan (B-W0-29); Operation, Cut a hide, Bundles, Pick & issue, Final inspection (the floor tasks:
 * SCR-090, 094, 095, 093, 097). Their pages: `TASK_ROUTES` (tasks/routes.ts).
 */
export const TILE_RULES: readonly TileRule[] = [
  // design floor.operation: sewing, cutting, packing; and the inspection bench, where a routing's scanned INSPECTION
  // operation is reported (the scans module wants a station of the operation's kind, else a reason).
  { key: 'operation', permission: 'production.scan', modes: ['sewing', 'cutting', 'packing', 'inspection'], built: true, takesScans: true },
  { key: 'cut', permission: 'production.cut', modes: ['cutting'], built: true, takesScans: true },
  { key: 'bundles', permission: 'production.bundles', modes: ['cutting'], built: true, takesScans: true },
  { key: 'receive', permission: 'inventory.receive', modes: ['warehouse'], built: false, takesScans: true },
  { key: 'pick', permission: 'inventory.issue', modes: ['warehouse'], built: true, takesScans: true },
  { key: 'labels', permission: 'print.labels', modes: ['packing'], built: false, takesScans: true },
  { key: 'pack', permission: 'shipping.pack', modes: ['packing'], built: false, takesScans: true },
  { key: 'final', permission: 'quality.inspections.view', modes: ['inspection'], built: true, takesScans: true },
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
 * The tiles a person sees at a station: the mode's tiles they hold the permission for, then Scan. Held: "Read the
 * notice first" while the notice blocks scans (before "coming": it is the person's to fix), else "coming" for a page
 * not built yet. A person without `floor.work` sees none (nothing to do here).
 */
export function homeTiles(mode: FloorMode | null, permissions: readonly string[], noticeBlocksScans: boolean): HomeTile[] {
  const held = new Set(permissions)
  return TILE_RULES.filter((rule) => (rule.modes === 'all' || (mode !== null && rule.modes.includes(mode))) && held.has(rule.permission) && held.has('floor.work'))
    .slice(0, MAX_TILES)
    .map((rule) => ({ key: rule.key, held: noticeBlocksScans && rule.takesScans ? 'notice' : rule.built ? null : 'coming' }))
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
