import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { OfficeApprovalViewModel } from './model'
import { OfficeApprovalView } from './view/OfficeApprovalView'

/**
 * SCR-198-office — an office approval opened from its e-mail (PLT-089): made-up company, person and quote only. Each
 * case is one step or end of the quick office sign-in: the sign-in, a refused password, the code, a wrong code, opening,
 * open (the page goes on by itself), already decided, a forwarded mail (another person), no key in the address, a new
 * password first, two-factor to set up first, an error.
 */

function model(overrides: Partial<OfficeApprovalViewModel> = {}): OfficeApprovalViewModel {
  return { stage: { kind: 'sign-in' }, company: 'officina-demo', email: '', code: '', busy: false, problem: null, ...overrides }
}

const HREF = '/w/DEMO/home/approvals?open=0190f0e2-7777-7000-8000-000000000001'

export const designScreen = defineDesignScreen<OfficeApprovalViewModel>({
  screen: 'SCR-198-office',
  title: 'Approve from e-mail (the office’s quick sign-in)',
  view: OfficeApprovalView,
  cases: [
    { id: 'sign-in', label: 'Sign in to open the approval', model: model(), note: 'The company remembered on this device; e-mail and password; the mail approves nothing by itself.' },
    { id: 'sign-in-refused', label: 'Sign-in refused (one answer for every wrong part)', model: model({ email: 'anna@example.com', problem: 'wrongCredentials' }) },
    { id: 'code', label: 'The code from the app (two-factor)', model: model({ stage: { kind: 'code' }, email: 'anna@example.com' }), note: 'One input; pasting a sentence with the code fills it; the sixth digit sends it.' },
    { id: 'code-wrong', label: 'A wrong code', model: model({ stage: { kind: 'code' }, email: 'anna@example.com', code: '', problem: 'wrongCode' }) },
    { id: 'code-busy', label: 'Checking the code', model: model({ stage: { kind: 'code' }, email: 'anna@example.com', code: '123456', busy: true }) },
    { id: 'checking', label: 'Checking the session', model: model({ stage: { kind: 'checking' } }) },
    { id: 'opening', label: 'Opening the approval', model: model({ stage: { kind: 'opening' } }) },
    { id: 'open', label: 'Open: the office page follows', model: model({ stage: { kind: 'open', href: HREF, label: 'Q-2026-0142' } }), note: 'The page goes to Home › Approvals’ review by itself; the link is there if the browser stops it.' },
    { id: 'decided', label: 'Already decided', model: model({ stage: { kind: 'decided', href: HREF, label: 'Q-2026-0142' } }) },
    { id: 'not-valid', label: 'Not for this account (a forwarded mail)', model: model({ stage: { kind: 'not-valid', home: '/w/DEMO/home/approvals' } }), note: 'Open Home › Approvals, or sign out and sign in as the person it was mailed to.' },
    { id: 'missing', label: 'No approval in the address', model: model({ stage: { kind: 'missing' } }) },
    { id: 'change-password', label: 'A new password first', model: model({ stage: { kind: 'change-password' } }) },
    { id: 'setup-2fa', label: 'Two-factor to set up first', model: model({ stage: { kind: 'setup-2fa', href: '/w/DEMO/me#authenticator' } }) },
    { id: 'error', label: 'Error', model: model({ stage: { kind: 'error' } }) },
  ],
})
