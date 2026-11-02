import { defineDesignScreen } from '../../lib/design/design-screen'
import { createElement } from 'react'
import type { CrewView } from '../api'
import { DEMO_OPERATOR, deviceFrame, onFloor, signedInFrame } from '../frame/fixtures'
import { SignInView, type SignInViewModel } from './view/SignInView'
import { WelcomeView, type WelcomeViewModel } from './view/WelcomeView'

/**
 * SCR-021's cases with made-up names: badge (with or without the PIN, Owner answer F1), the name tiles, the PIN pad and
 * its one uniform refusal, the new PIN after a reset, switching person, the pop-ups. No PIN and no badge code appears
 * anywhere (the view never holds one).
 */

const ROSTER = ['Ada Demo', 'Bea Esempio', 'Carlo Prova', 'Chiara Demo', 'Dario Esempio', 'Elena Prova', 'Luca Demo', 'Marta Esempio', 'Nadia Prova', 'Omar Demo', 'Pietro Esempio', 'Sara Prova'].map(
  (name, index) => ({ id: `0190f0e2-3333-7000-8000-0000000000${String(index + 10)}`, name }),
)

const signIn = (extra: Partial<SignInViewModel> = {}): SignInViewModel => ({ frame: deviceFrame('signIn.title'), step: { kind: 'badge' }, badgeOnly: false, roster: ROSTER, ...extra })
const pin = (extra: Partial<SignInViewModel> = {}, forName: string | null = null) => signIn({ step: { kind: 'pin', forName }, ...extra })
const change = (stage: 'current' | 'new' | 'repeat', extra: Partial<SignInViewModel> = {}) =>
  signIn({ frame: signedInFrame('signIn.title', { showHome: false }), step: { kind: 'change', stage }, ...extra })

const member = (workerId: string, displayName: string, active: boolean): CrewView['members'][number] => ({ workerId, displayName, locale: 'it', active, joinedAt: '2026-10-29T06:00:00.000Z', look: { icon: active ? 'user-check' : 'user', tone: active ? 'success' : 'neutral' } })
const crewOf = (...members: CrewView['members']): CrewView => ({ id: '0190f0e2-3333-7000-8000-000000000099', startedAt: '2026-10-29T06:00:00.000Z', max: 4, members })
const LUCA = member('0190f0e2-3333-7000-8000-000000000016', 'Luca Demo', false)
const MARTA = member('0190f0e2-3333-7000-8000-000000000017', 'Marta Esempio', false)
const welcome = (card: WelcomeViewModel['card'], extra: Partial<WelcomeViewModel> = {}): SignInCase => ({ welcome: { frame: signedInFrame('signIn.welcome.frameTitle', { showHome: false }), card, ...extra } })
const NOTE = {
  id: '0190f0e2-3333-7000-8000-000000000031',
  shiftDate: '2026-10-29',
  shiftLabel: 'Mattina',
  topics: [
    { topic: 'MACHINES', tone: 'warning', labelIt: 'Macchine', labelEn: 'Machines' },
    { topic: 'HALF_DONE_BUNDLES', tone: 'warning', labelIt: 'Mazzi a metà', labelEn: 'Half-done bundles' },
  ],
  text: 'La macchina di SEW-03 perde filo; due fasci a metà in postazione 4.',
}
const OPEN_ITEM = { bundleId: '0190f0e2-3333-7000-8000-000000000041', bundleCode: 'B-000123', operation: { id: '0190f0e2-3333-7000-8000-000000000042', seq: 30, name: 'Cucitura colletto' }, state: 'PAUSED', mine: true, pausedAtClockOut: true }

type SignInCase = SignInViewModel | { welcome: WelcomeViewModel }

function SignInDesign({ model, ...rest }: { model: SignInCase; children?: unknown }) {
  void rest
  return 'welcome' in model ? createElement(WelcomeView, { model: model.welcome }) : createElement(SignInView, { model })
}

export const designScreen = defineDesignScreen<SignInCase>({
  screen: 'SCR-021',
  title: 'Floor sign-in (badge, name + PIN; crew; welcome cards)',
  view: onFloor(SignInDesign),
  cases: [
    { id: 'badge', label: 'Scan your badge (badge + PIN site)', model: signIn(), note: 'Default site setting: the PIN pad follows the badge. A badge typed by hand is refused (scan only).' },
    { id: 'badge-only', label: 'Scan your badge (badge alone, Owner answer F1)', model: signIn({ badgeOnly: true }), note: 'The site\'s FloorSettings.badgeOnlySignIn: the scan is all (0 taps). The PIN is asked later to sign and to open My day.' },
    { id: 'signed-out-idle', label: 'After an idle sign-out', model: signIn({ signedOut: 'idle' }) },
    { id: 'signed-out-ended', label: 'After a shift end or the office ended it', model: signIn({ signedOut: 'ended' }) },
    { id: 'badge-refused', label: 'Badge alone refused', model: signIn({ badgeOnly: true, problem: 'wrong' }), note: 'One answer for an unknown, revoked or locked badge (the API names no reason).' },
    { id: 'pin-badge', label: 'PIN after the badge', model: pin(), note: 'Dots only; the sixth digit sends. Digits, Backspace and Esc work from a keyboard.' },
    { id: 'pin-name', label: 'PIN after picking a name', model: pin({}, 'Luca Demo'), note: 'A sign-in by name always needs the PIN.' },
    { id: 'pin-wrong', label: 'Wrong PIN (one answer)', model: pin({ problem: 'wrong' }, 'Luca Demo'), note: 'The same words for a wrong PIN and a locked person; the tablet stays free for the next one.' },
    { id: 'pin-busy', label: 'Checking the PIN', model: pin({ busy: true }, 'Luca Demo') },
    { id: 'rate-limited', label: 'Too many tries on this tablet', model: pin({ problem: 'rateLimited' }) },
    { id: 'unavailable', label: 'Server not answering', model: signIn({ problem: 'unavailable' }) },
    { id: 'names', label: 'Pick your name', model: signIn({ step: { kind: 'names', letter: null } }), note: 'The site\'s active workers with a PIN, A–Z; a letter strip, no keyboard. Initials, no photos.' },
    { id: 'names-letter', label: 'Names from one letter', model: signIn({ step: { kind: 'names', letter: 'C' } }) },
    { id: 'names-empty', label: 'Nobody set up yet', model: signIn({ step: { kind: 'names', letter: null }, roster: [] }) },
    { id: 'forgot', label: 'Forgot your PIN?', model: pin({ forgotOpen: true }, 'Luca Demo') },
    { id: 'language', label: 'Language for this screen', model: signIn({ frame: deviceFrame('signIn.title', { languageOpen: true }) }), note: 'Each language in its own words; after sign-in the screen follows the person.' },
    { id: 'change-current', label: 'New PIN: the office\'s PIN first', model: change('current'), note: 'After a reset, signed in with a badge alone: the PIN the office gave is asked first.' },
    { id: 'change-new', label: 'New PIN: type it', model: change('new') },
    { id: 'change-repeat', label: 'New PIN: again', model: change('repeat') },
    { id: 'change-mismatch', label: 'New PIN: not the same twice', model: change('new', { changeProblem: 'mismatch' }) },
    { id: 'change-refused', label: 'New PIN: refused by the rules', model: change('new', { changeProblem: 'refused' }) },
    {
      id: 'switch',
      label: 'Switch person: the next one\'s PIN',
      model: pin({ frame: signedInFrame('signIn.switch.frameTitle'), switchingFrom: DEMO_OPERATOR }),
      note: 'A badge scanned on a signed-in tablet (badge + PIN site): the next person types their PIN; the one signed in stays until then.',
    },
    // B-W2b-67: the kiosk's button, the crew (PLT-059), the welcome cards (MES-033, MES-117).
    { id: 'clock-button', label: 'Clock in or out, with nobody signed in', model: signIn({ badgeOnly: true, clock: { closed: false } }), note: 'Opens the kiosk (SCR-170): one scan clocks, no sign-in.' },
    { id: 'clock-closed', label: 'The clock is closed at this site', model: signIn({ badgeOnly: true, clock: { closed: true } }), note: 'The ATTENDANCE gate is off: the button is held and says why, on screen.' },
    { id: 'crew-left', label: 'Crew: the active one left', model: signIn({ frame: deviceFrame('signIn.title', { crew: crewOf({ ...LUCA }, { ...MARTA }) }) }), note: 'Who stays signed in; a tap on a chip asks that person\'s PIN or badge. Their badge alone also takes the tablet back.' },
    {
      id: 'crew-strip',
      label: 'Crew: four on the tablet, Add a person held',
      model: signIn({ frame: signedInFrame('signIn.title', { crew: crewOf(member('0190f0e2-3333-7000-8000-000000000010', 'Ada Demo', true), { ...LUCA }, { ...MARTA }, member('0190f0e2-3333-7000-8000-000000000021', 'Sara Prova', false)), showHome: false }) }),
      note: 'PLT-059: up to four chips, the active one with a bar and the word Now, on Home, the clock and here; hidden with one person. Every action books to the active person.',
    },
    { id: 'crew-add', label: 'Crew: add a person', model: signIn({ frame: signedInFrame('signIn.crew.frameTitle'), crewStep: 'join', badgeOnly: true }), note: 'The first person added opens the crew. Up to four; every action books to the active one.' },
    { id: 'crew-add-refused', label: 'Crew: this person cannot join', model: signIn({ frame: signedInFrame('signIn.crew.frameTitle'), crewStep: 'join', badgeOnly: true, problem: 'crew' }) },
    { id: 'crew-switch', label: 'Crew: a member takes the tablet', model: pin({ frame: signedInFrame('signIn.crew.frameTitle'), crewStep: 'switch' }, 'Luca Demo'), note: 'A tap on their chip, then their badge or PIN.' },
    { id: 'welcome-reading', label: 'Welcome: reading', model: welcome(null) },
    { id: 'welcome-handover', label: 'Welcome: the line\'s handover note', model: welcome({ kind: 'handover', line: 'Linea 1', notes: [NOTE] }), note: 'MES-033: new since your last shift; one Seen. Nothing is stored per person.' },
    { id: 'welcome-continue', label: 'Welcome: continue after a clock-out', model: welcome({ kind: 'continue', item: OPEN_ITEM }), note: 'MES-117: Continue resumes it and opens it on Operation.' },
    { id: 'welcome-continue-refused', label: 'Welcome: it cannot continue', model: welcome({ kind: 'continue', item: OPEN_ITEM }, { refused: true }) },
  ],
})
