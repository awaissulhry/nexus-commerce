import type { FloorLook } from './literacy'
import { MODE_RULES, type DeviceMode } from './modes'

/**
 * The kiosk lock guide (B-W2b-52; PLT-227; design floor.enrol "Lock the tablet to the app", admin.devices enrol step 3
 * "what to do next (kiosk lock guide)"): four illustrated steps that pin the floor app on an Android tablet (screen
 * pinning, or the lock-task mode a managed tablet has), then an honest check.
 *
 * Honest (anatomy 4.4: the UI never claims what it does not know): the tablet can tell whether the app runs full screen
 * and whether it is installed; Android does not tell a web app whether the screen is pinned. So the pinning row is never
 * a tick the tablet made: it is "not known" until the person pressed Home and said what happened ("it stayed" / "it
 * left"), and then it is shown as said by the person, never as checked. `lockedKnown` stays false: nothing here proves
 * a lock. The guide applies to station tablets, line tablets and line boards, never to a person's own phone.
 */

export const KIOSK_STEPS = [
  /** Install the floor app on the home screen (one button, or the browser's menu › Add to home screen). */
  { id: 'install', look: { icon: 'download', tone: 'info' } },
  /** Android Settings › Security › App pinning (or Screen pinning): on, with "Ask for PIN before unpinning". */
  { id: 'pinning-on', look: { icon: 'settings', tone: 'neutral' } },
  /** Open the floor app from its icon: it runs full screen. */
  { id: 'open-app', look: { icon: 'maximize', tone: 'success' } },
  /** Recent apps › the floor app's icon › Pin. */
  { id: 'pin-app', look: { icon: 'pin', tone: 'warning' } },
] as const satisfies readonly { readonly id: string; readonly look: FloorLook }[]

export type KioskStepId = (typeof KIOSK_STEPS)[number]['id']

/** What the person says after pressing Home: the app stayed, it left, or they did not test it. */
export const KIOSK_HOME_TESTS = ['STAYED', 'LEFT', 'NOT_TESTED'] as const
export type KioskHomeTest = (typeof KIOSK_HOME_TESTS)[number]

/** What the tablet reports after the guide: what it could check itself (null: its browser does not say) and the Home test. */
export interface KioskReport {
  readonly fullScreen: boolean | null
  readonly installed: boolean | null
  readonly homeTest: KioskHomeTest
}

export type KioskRowState = 'ok' | 'no' | 'unknown'

export interface KioskRow {
  readonly id: 'fullScreen' | 'installed' | 'pinned'
  readonly state: KioskRowState
  /** Who knows it: the tablet checked it, the person said it, or nobody does. */
  readonly source: 'TABLET' | 'PERSON' | 'NOBODY'
  readonly look: FloorLook
}

export interface KioskCheck {
  readonly rows: readonly KioskRow[]
  /** Always false: Android does not tell a web app whether it is pinned (press Home to test it). */
  readonly lockedKnown: false
  /** Everything the tablet could check passed and the person said the app stayed on Home. */
  readonly looksLocked: boolean
}

const LOOK: Readonly<Record<KioskRowState, FloorLook>> = Object.freeze({
  ok: { icon: 'check', tone: 'success' },
  no: { icon: 'x', tone: 'danger' },
  unknown: { icon: 'help-circle', tone: 'neutral' },
})

const tabletRow = (id: 'fullScreen' | 'installed', value: boolean | null): KioskRow => {
  const state: KioskRowState = value === null ? 'unknown' : value ? 'ok' : 'no'
  return { id, state, source: value === null ? 'NOBODY' : 'TABLET', look: LOOK[state] }
}

/** The honest check of a tablet's report. */
export function kioskCheck(report: KioskReport): KioskCheck {
  const pinned: KioskRowState = report.homeTest === 'STAYED' ? 'ok' : report.homeTest === 'LEFT' ? 'no' : 'unknown'
  const rows: KioskRow[] = [
    tabletRow('fullScreen', report.fullScreen),
    tabletRow('installed', report.installed),
    { id: 'pinned', state: pinned, source: report.homeTest === 'NOT_TESTED' ? 'NOBODY' : 'PERSON', look: LOOK[pinned] },
  ]
  return { rows, lockedKnown: false, looksLocked: rows.every((row) => row.state === 'ok') }
}

/** The kiosk lock guide applies to a device of this mode (never a person's own phone). */
export const kioskApplies = (mode: DeviceMode): boolean => MODE_RULES[mode].kiosk
