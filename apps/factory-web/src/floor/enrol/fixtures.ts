import { defineDesignScreen } from '../../lib/design/design-screen'
import { DEMO_SITE, DEMO_STATION, deviceFrame, onFloor } from '../frame/fixtures'
import { EnrolView, type Binding, type EnrolViewModel } from './view/EnrolView'

/**
 * SCR-020's cases: scan the one-time set-up code, the refusals (one answer for used, expired or another factory's
 * code), "Replace?" on a tablet already set up, what the tablet now is, install and checks with the kiosk guide, done.
 * Made-up device and plant names; no code appears (the view never holds one).
 */

const binding: Binding = { device: 'Tablet taglio 2', site: DEMO_SITE, station: DEMO_STATION, mode: 'cutting', language: 'it', deviceMode: 'STATION', line: null, kiosk: true }
const lineTablet: Binding = { ...binding, device: 'Tablet linea 1', station: null, mode: null, deviceMode: 'LINE', line: 'L1 · Linea 1' }
const board: Binding = { ...binding, device: 'Tabellone linea 1', station: null, mode: null, deviceMode: 'DISPLAY', line: 'L1 · Linea 1' }
const phone: Binding = { ...binding, device: 'Telefono di Ada', station: null, mode: null, deviceMode: 'PHONE', kiosk: false }
const rows = (fullScreen: 'ok' | 'no' | 'unknown', installed: 'ok' | 'no' | 'unknown', pinned: 'ok' | 'no' | 'unknown') =>
  [
    { id: 'fullScreen', state: fullScreen, source: fullScreen === 'unknown' ? 'NOBODY' : 'TABLET' },
    { id: 'installed', state: installed, source: installed === 'unknown' ? 'NOBODY' : 'TABLET' },
    { id: 'pinned', state: pinned, source: pinned === 'unknown' ? 'NOBODY' : 'PERSON' },
  ] as const
const frame = (extra = {}) => deviceFrame('enrol.title', { station: null, ...extra })
const enrol = (step: EnrolViewModel['step'], extra = {}): EnrolViewModel => ({ step, frame: frame(extra) })
const waiting = { camera: 'ok', scanner: 'waiting', sound: 'untested', vibration: 'ok' } as const

export const designScreen = defineDesignScreen<EnrolViewModel>({
  screen: 'SCR-020',
  title: 'Set up this tablet (enrolment)',
  view: onFloor(EnrolView),
  cases: [
    { id: 'scan', label: 'Scan the set-up code', model: enrol({ kind: 'scan' }), note: 'The office shows the QR code (Admin › Devices & printers). Camera, scanner, or "Type the code"; the code is never read aloud.' },
    { id: 'checking', label: 'Checking the code', model: enrol({ kind: 'scan', busy: true }) },
    { id: 'code-invalid', label: 'Code used, expired or another factory\'s', model: enrol({ kind: 'scan', problem: 'codeInvalid' }), note: 'One answer for all three (the API names none).' },
    { id: 'offline', label: 'No network', model: enrol({ kind: 'scan', problem: 'offline' }, { online: false }) },
    { id: 'unavailable', label: 'Server not answering', model: enrol({ kind: 'scan', problem: 'unavailable' }) },
    { id: 'rate-limited', label: 'Too many tries', model: enrol({ kind: 'scan', problem: 'rateLimited' }) },
    {
      id: 'replace',
      label: 'Already set up: replace?',
      model: enrol({ kind: 'replace', current: { device: 'Tablet cucitura 4', station: 'SEW-04 · Linea 2 St 4', site: DEMO_SITE } }, { station: { name: 'SEW-04 · Linea 2 St 4', site: DEMO_SITE } }),
      note: 'Keep it is the main action (the safe default, Enter).',
    },
    { id: 'binding', label: 'What this tablet is now', model: enrol({ kind: 'binding', binding }), note: 'Shown right after the code is traded (the API has no preview of a code). Changed in the office.' },
    { id: 'binding-no-station', label: 'A device with no station', model: enrol({ kind: 'binding', binding: { ...binding, device: 'Palmare magazzino 1', station: null, mode: 'warehouse' } }) },
    {
      id: 'install',
      label: 'Install and check',
      model: enrol({ kind: 'install', binding, install: { app: 'available', storage: 'unknown' }, checks: waiting }),
      note: 'Install (when the browser offers it), keep the data, then the parts: camera, scanner (scan any label), sound (tap), vibration. The kiosk lock is a guide with an honest check.',
    },
    {
      id: 'install-done',
      label: 'Installed, data kept, every part works',
      model: enrol({ kind: 'install', binding, install: { app: 'installed', storage: 'kept' }, checks: { camera: 'ok', scanner: 'ok', sound: 'ok', vibration: 'ok' } }),
    },
    {
      id: 'install-manual',
      label: 'Install from the browser menu; data not kept',
      model: enrol({ kind: 'install', binding, install: { app: 'manual', storage: 'notKept' }, checks: { camera: 'missing', scanner: 'waiting', sound: 'untested', vibration: 'missing' } }),
    },
    { id: 'done', label: 'Ready', model: enrol({ kind: 'done', binding }) },
    { id: 'help', label: 'Help open', model: enrol({ kind: 'scan' }, { helpOpen: true }) },
    // B-W2b-67: the mode the office chose, the kiosk lock guide with its honest check, what each mode says at the end.
    { id: 'binding-line', label: 'A line tablet', model: enrol({ kind: 'binding', binding: lineTablet }), note: 'MES-181: chosen in the office. Anyone of the site signs in; a team leader lands on the Line view.' },
    { id: 'binding-display', label: 'A line board', model: enrol({ kind: 'binding', binding: board }), note: 'Nobody signs in on it.' },
    { id: 'binding-phone', label: 'A personal phone', model: enrol({ kind: 'binding', binding: phone }), note: 'MES-186: one person, no station, never kiosk-locked.' },
    { id: 'kiosk', label: 'Lock the tablet: nothing checked yet', model: enrol({ kind: 'kiosk', binding, check: { rows: rows('no', 'unknown', 'unknown'), homeTest: 'NOT_TESTED' } }), note: 'PLT-227: four pictures (a stand-in for FloorMediaSteps). Continue stays the main action: skipping is fine.' },
    { id: 'kiosk-app', label: 'Lock the tablet: running as the app', model: enrol({ kind: 'kiosk', binding, check: { rows: rows('ok', 'ok', 'unknown'), homeTest: 'NOT_TESTED' } }), note: 'Full screen and Installed are ticks the tablet gives. Pinned stays "Not known": Android does not say.' },
    { id: 'kiosk-stayed', label: 'Lock the tablet: "It stayed"', model: enrol({ kind: 'kiosk', binding, check: { rows: rows('ok', 'ok', 'ok'), homeTest: 'STAYED' } }), note: 'As the person said, never a tick of the tablet: nothing here proves a lock.' },
    { id: 'kiosk-left', label: 'Lock the tablet: "It left"', model: enrol({ kind: 'kiosk', binding, check: { rows: rows('ok', 'ok', 'no'), homeTest: 'LEFT' } }) },
    { id: 'done-line', label: 'Ready: a line tablet', model: enrol({ kind: 'done', binding: lineTablet }) },
    { id: 'done-display', label: 'Ready: a line board', model: enrol({ kind: 'done', binding: board }), note: 'Display mode goes straight to the line board: no sign-in.' },
    { id: 'done-phone', label: 'Ready: a personal phone', model: enrol({ kind: 'done', binding: phone }), note: 'The design\'s words: only you sign in; it never tracks where you are. Step 4 of 4: no kiosk step.' },
  ],
})
