import { defineDesignScreen } from '../../../lib/design/design-screen'
import { OfficeAuthView, type AuthScreen, type OfficeAuthViewModel } from './view/OfficeAuthView'

/**
 * SCR-001's cases with made-up data: a made-up company sign-in name and example.com addresses; no password appears
 * anywhere (the view never holds one in its model).
 */

const EMAIL = 'alex.demo@example.com'
const signIn = (extra: Partial<Extract<AuthScreen, { kind: 'sign-in' }>> = {}): AuthScreen => ({ kind: 'sign-in', company: '', email: '', ...extra })
const remembered = signIn({ company: 'demo' })
const filled = signIn({ company: 'demo', email: EMAIL })
const code = (recovery = false): AuthScreen => ({ kind: 'code', email: EMAIL, recovery })
const invite: AuthScreen = { kind: 'invite', tenant: 'Officina Demo', email: 'nuovo.collega@example.com', displayName: 'Nuovo Collega', expiresAt: '2026-11-04T09:00:00.000Z' }

export const designScreen = defineDesignScreen<OfficeAuthViewModel>({
  screen: 'SCR-001',
  title: 'Office sign-in & password reset',
  view: OfficeAuthView,
  cases: [
    { id: 'sign-in', label: 'Sign in (empty)', model: { screen: signIn() }, note: 'Company sign-in name, email, password. Language on top; nothing of the office.' },
    {
      id: 'sign-in-remembered',
      label: 'Company remembered on this device',
      model: { screen: remembered },
      note: 'The company is kept in a page cookie after a sign-in; the live page puts the focus on the email.',
    },
    {
      id: 'sign-in-fields',
      label: 'Form check before sending',
      model: { screen: signIn({ email: 'alex.demo' }), fieldErrors: { company: { key: 'field.companyRequired' }, email: { key: 'field.emailFormat' }, password: { key: 'field.passwordRequired' } } },
      note: 'Problems under their fields; the first takes the focus. Nothing is sent.',
    },
    {
      id: 'sign-in-wrong',
      label: 'Wrong or locked (one answer)',
      model: { screen: filled, problem: 'wrongCredentials' },
      note: 'The API answers an unknown company, unknown email, wrong password and locked account the same way: the page names all three and the lock, never which one.',
    },
    { id: 'sign-in-rate-limited', label: 'Too many tries', model: { screen: filled, problem: 'rateLimited' } },
    { id: 'sign-in-suspended', label: 'Suspended account', model: { screen: filled, problem: 'suspended' }, note: 'Told only after a right password (the API\'s rule).' },
    { id: 'sign-in-unavailable', label: 'API not answering', model: { screen: filled, problem: 'unavailable' } },
    { id: 'sign-in-busy', label: 'Signing in', model: { screen: filled, busy: true } },
    { id: 'no-company', label: 'No company yet', model: { screen: filled, problem: 'noCompany' }, note: 'Signed in, but no company to open.' },
    { id: 'code', label: 'Code required', model: { screen: code() }, note: 'After a right password, for a person with the authenticator app.' },
    { id: 'code-wrong', label: 'Wrong code', model: { screen: code(), problem: 'wrongCode' } },
    { id: 'code-recovery', label: 'Recovery code', model: { screen: code(true) }, note: 'Without the phone: one of the 10 codes shown once at set-up.' },
    {
      id: 'code-recovery-format',
      label: 'Recovery code: form check',
      model: { screen: code(true), fieldErrors: { code: { key: 'field.recoveryFormat' } } },
    },
    { id: 'change', label: 'New password required', model: { screen: { kind: 'change', email: EMAIL } }, note: 'An administrator required a new password: set here, then signed in at once.' },
    {
      id: 'change-fields',
      label: 'New password: form check',
      model: { screen: { kind: 'change', email: EMAIL }, fieldErrors: { password: { key: 'field.passwordShort', params: { min: 12 } } } },
    },
    { id: 'change-expired', label: 'New password: time ran out', model: { screen: filled, problem: 'changeExpired' }, note: 'The 15 minutes for the new password ran out: back to sign-in.' },
    { id: 'forgot', label: 'Forgot password', model: { screen: { kind: 'forgot', company: 'demo', email: '' } } },
    { id: 'forgot-sent', label: 'Reset link sent', model: { screen: { kind: 'forgot-sent', email: EMAIL } }, note: 'The same answer for every address (the API\'s rule).' },
    { id: 'reset', label: 'New password from the link', model: { screen: { kind: 'reset' } } },
    {
      id: 'reset-mismatch',
      label: 'New password: not the same twice',
      model: { screen: { kind: 'reset' }, fieldErrors: { confirmation: { key: 'field.repeatMismatch' } } },
    },
    { id: 'reset-refused', label: 'New password refused by the API', model: { screen: { kind: 'reset' }, problem: 'passwordRefused' }, note: 'A well-known password: only the API knows the list.' },
    { id: 'reset-done', label: 'Password set', model: { screen: { kind: 'reset-done' } } },
    { id: 'reset-invalid', label: 'Reset link used or expired', model: { screen: { kind: 'link-invalid', link: 'reset' } } },
    { id: 'invite-checking', label: 'Invitation: opening', model: { screen: { kind: 'invite-checking' } } },
    { id: 'invite-unavailable', label: 'Invitation: API not answering', model: { screen: { kind: 'invite-checking' }, problem: 'unavailable' } },
    { id: 'invite', label: 'Invitation', model: { screen: invite }, note: 'Name filled in by the inviter; the person sets a password.' },
    { id: 'invite-busy', label: 'Invitation: joining', model: { screen: invite, busy: true } },
    { id: 'invite-expired', label: 'Invitation used, expired or withdrawn', model: { screen: { kind: 'link-invalid', link: 'invite' } } },
    { id: 'invite-done', label: 'Joined: authenticator offered', model: { screen: { kind: 'invite-done', mfaRequired: false } } },
    { id: 'invite-done-required', label: 'Joined: authenticator required', model: { screen: { kind: 'invite-done', mfaRequired: true } }, note: 'A role with two-factor: nothing opens until it is set up.' },
    {
      id: 'invite-done-no-role',
      label: 'Joined without a role yet',
      model: { screen: { kind: 'invite-done', mfaRequired: false, noCompany: true } },
      note: 'Invited without roles: the account exists, nothing to open until an administrator gives a role.',
    },
    { id: 'link-missing', label: 'Link without its token', model: { screen: { kind: 'link-missing' } } },
  ],
})
