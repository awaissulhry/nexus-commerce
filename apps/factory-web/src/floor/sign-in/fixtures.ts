import { defineDesignScreen } from '../../lib/design/design-screen'
import { DEMO_OPERATOR, deviceFrame, onFloor, signedInFrame } from '../frame/fixtures'
import { SignInView, type SignInViewModel } from './view/SignInView'

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

export const designScreen = defineDesignScreen<SignInViewModel>({
  screen: 'SCR-021',
  title: 'Floor sign-in (badge, name + PIN)',
  view: onFloor(SignInView),
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
  ],
})
