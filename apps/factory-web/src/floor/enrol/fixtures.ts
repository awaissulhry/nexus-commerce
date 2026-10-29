import { defineDesignScreen } from '../../lib/design/design-screen'
import { DEMO_SITE, DEMO_STATION, deviceFrame, onFloor } from '../frame/fixtures'
import { EnrolView, type Binding, type EnrolViewModel } from './view/EnrolView'

/**
 * SCR-020's cases: scan the one-time set-up code, the refusals (one answer for used, expired or another factory's
 * code), "Replace?" on a tablet already set up, what the tablet now is, install and checks with the kiosk guide, done.
 * Made-up device and plant names; no code appears (the view never holds one).
 */

const binding: Binding = { device: 'Tablet taglio 2', site: DEMO_SITE, station: DEMO_STATION, mode: 'cutting', language: 'it' }
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
  ],
})
