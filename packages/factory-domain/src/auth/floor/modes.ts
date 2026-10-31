import type { Issue } from '../../core/errors'
import type { FloorLook } from './literacy'

/**
 * What a floor device is for (B-W2b-52; MES-181 floor modes, MES-186 personal phone enrolment; design floor.enrol
 * "mode", admin.devices "Station & mode"; factory-db floor-auth.prisma Device.mode). The office chooses it at enrolment
 * and may change it later while nobody is signed in on the device; the floor never changes it (the "Device_mode_check"
 * trigger refuses the floor login).
 *
 *   STATION  a station's tablet: one operator signed in, or a crew of up to four with one active (PLT-059). Home first.
 *   LINE     a team leader's tablet for one line: anyone of the site with a floor role signs in; the Line view first.
 *   DISPLAY  a line board (the line TV): nobody signs in; the tablet goes straight to the board of its line.
 *   PHONE    one person's own phone: only that worker signs in on it. It is never kiosk-locked (it is theirs), and it
 *            never reports where it is, its battery or its network (GDPR art. 5(1)(c); the design's words "it never
 *            tracks where you are").
 *
 * A LINE or DISPLAY device shows one line: its own (`lineId`) or its station's. A PHONE names its person
 * (`personalWorkerId`) and sits at no station (a phone moves with its person). Pure: the facts come in.
 */

export const DEVICE_MODES = ['STATION', 'LINE', 'DISPLAY', 'PHONE'] as const
export type DeviceMode = (typeof DEVICE_MODES)[number]

export function isDeviceMode(value: unknown): value is DeviceMode {
  return typeof value === 'string' && (DEVICE_MODES as readonly string[]).includes(value)
}

/** Who signs in on a device of the mode. */
export type SignInRule = 'ANYONE' | 'ONE_PERSON' | 'NOBODY'
/** Where the tablet goes first: Home after a sign-in, the Line view after a sign-in, or the line board without one. */
export type Landing = 'HOME' | 'LINE_VIEW' | 'LINE_BOARD'

export interface ModeRule {
  readonly mode: DeviceMode
  readonly signIn: SignInRule
  readonly landing: Landing
  /** Several workers signed in, one active (PLT-059): station tablets only (the database says the same). */
  readonly crew: boolean
  /** The kiosk lock guide applies (PLT-227): never on a person's own phone. */
  readonly kiosk: boolean
  /** The device's battery and network are kept when it reports them (B-W2a-42): never a person's own phone's. */
  readonly keepsBatteryAndNetwork: boolean
  /** It shows one line (its own or its station's): a line board must have one. */
  readonly showsLine: boolean
  /** Icon and tone first (MES-188): what the mode looks like on a tile, a radio card or a chip. */
  readonly look: FloorLook
}

export const MODE_RULES: Readonly<Record<DeviceMode, ModeRule>> = Object.freeze({
  STATION: { mode: 'STATION', signIn: 'ANYONE', landing: 'HOME', crew: true, kiosk: true, keepsBatteryAndNetwork: true, showsLine: false, look: { icon: 'tablet', tone: 'info' } },
  LINE: { mode: 'LINE', signIn: 'ANYONE', landing: 'LINE_VIEW', crew: false, kiosk: true, keepsBatteryAndNetwork: true, showsLine: true, look: { icon: 'users', tone: 'success' } },
  DISPLAY: { mode: 'DISPLAY', signIn: 'NOBODY', landing: 'LINE_BOARD', crew: false, kiosk: true, keepsBatteryAndNetwork: true, showsLine: true, look: { icon: 'monitor', tone: 'neutral' } },
  PHONE: { mode: 'PHONE', signIn: 'ONE_PERSON', landing: 'HOME', crew: false, kiosk: false, keepsBatteryAndNetwork: false, showsLine: false, look: { icon: 'smartphone', tone: 'warning' } },
} satisfies Record<DeviceMode, ModeRule>)

/** The facts of a device's mode as the office sets them (create or edit), with its station's line. */
export interface ModeFacts {
  readonly mode: DeviceMode
  readonly kind: 'TABLET' | 'HANDHELD' | 'PC'
  readonly stationId: string | null
  /** The line of the device's station (null: no station, or a station on no line). */
  readonly stationLineId: string | null
  readonly lineId: string | null
  readonly personalWorkerId: string | null
}

/** What is wrong with a device's mode, line and person (paths name the body fields; empty when it is fine). */
export function deviceModeProblems(facts: ModeFacts): Issue[] {
  const issues: Issue[] = []
  const rule = MODE_RULES[facts.mode]
  if (facts.lineId !== null && !rule.showsLine) issues.push({ path: 'lineId', message: 'Only a line tablet or a line board shows a line of its own.' })
  if (rule.showsLine && facts.lineId === null && facts.stationLineId === null) {
    issues.push({ path: 'lineId', message: 'A line tablet or a line board shows one line: pick the line, or a station on a line.' })
  }
  if (facts.mode === 'PHONE') {
    if (facts.personalWorkerId === null) issues.push({ path: 'personalWorkerId', message: 'A personal phone is for one person: pick the worker.' })
    if (facts.stationId !== null) issues.push({ path: 'stationId', message: 'A personal phone moves with its person: it sits at no station.' })
    if (facts.kind === 'PC') issues.push({ path: 'kind', message: 'A personal phone is a handheld or a tablet, not a PC.' })
  } else if (facts.personalWorkerId !== null) {
    issues.push({ path: 'personalWorkerId', message: 'Only a personal phone names its person.' })
  }
  return issues
}

/** The line a device shows: a LINE or DISPLAY device its own or its station's; a station's tablet its station's; a phone none. */
export function shownLineOf(device: { readonly mode: DeviceMode; readonly lineId: string | null }, stationLineId: string | null): string | null {
  if (device.mode === 'PHONE') return null
  if (device.mode === 'STATION') return stationLineId
  return device.lineId ?? stationLineId
}

/** Why a worker may not sign in on this device, or null: nobody on a line board; only its person on a phone. */
export interface SignInRefusal {
  readonly code: 'DISPLAY_NO_SIGN_IN' | 'PHONE_OTHER_PERSON'
  readonly message: string
}

export function signInRefusal(device: { readonly mode: DeviceMode; readonly personalWorkerId: string | null }, workerId: string | null): SignInRefusal | null {
  if (device.mode === 'DISPLAY') return { code: 'DISPLAY_NO_SIGN_IN', message: 'This device is a line board: nobody signs in on it.' }
  if (device.mode === 'PHONE' && workerId !== null && workerId !== device.personalWorkerId) {
    return { code: 'PHONE_OTHER_PERSON', message: 'This phone is set up for one person only. Sign in on a station tablet.' }
  }
  return null
}
