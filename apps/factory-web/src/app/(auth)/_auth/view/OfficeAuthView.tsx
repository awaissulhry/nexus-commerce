'use client'

import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react'
import Link from 'next/link'
import { Banner, Card, Field } from '@nexus/ui/components'
import { Button, Input, SegmentedControl, Spinner } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../lib/i18n/format'
import { LOCALES, LOCALE_NAMES, isLocale } from '../../../../lib/i18n/locales'
import { useLocale, useLocaleSwitch, useT } from '../../../../lib/i18n/provider'
import { checkNewPassword, PASSWORD_RULES } from '../../../../lib/auth/password-rules'
import { checkCode, checkForgot, checkInvitation, checkSignIn, type AuthProblem, type FieldProblem, type FieldProblems } from '../auth-model'
import '../auth.css'

/**
 * SCR-001 — office sign-in, the authenticator code, a forced new password, a password reset and accepting an
 * invitation (PLT-047, PLT-048, PLT-070, PLT-015). No office chrome: the brand and the language on top, one task in a
 * narrow column, the title above it (Commerce's `/login` and `/accept-invite` are the model), design-system parts only.
 *
 * The view draws ONE screen of the flow from its model and keeps only what the person types (passwords never enter
 * the model). A form checks itself before it asks (`auth-model.ts`): a problem is shown under its field, which gets
 * the focus; what the API refused comes back as `problem` and is shown above the form in the page's own words.
 */

export type AuthScreen =
  | { kind: 'sign-in'; company: string; email: string }
  | { kind: 'code'; email: string; recovery: boolean }
  /** An administrator required a new password; the token is the page's, not the model's. */
  | { kind: 'change'; email: string }
  | { kind: 'forgot'; company: string; email: string }
  | { kind: 'forgot-sent'; email: string }
  /** A new password from a mailed reset link. */
  | { kind: 'reset' }
  | { kind: 'reset-done' }
  | { kind: 'invite-checking' }
  | { kind: 'invite'; tenant: string; email: string; displayName: string; expiresAt: string }
  /**
   * The invitation was accepted: the authenticator app is offered (required by some roles). `noCompany`: the person
   * has no role yet, so there is nothing to open (an administrator gives the roles).
   */
  | { kind: 'invite-done'; mfaRequired: boolean; noCompany?: boolean }
  /** A mailed link that opens nothing: used, expired, replaced or withdrawn (one answer). */
  | { kind: 'link-invalid'; link: 'reset' | 'invite' }
  /** A reset or invitation address without its token. */
  | { kind: 'link-missing' }

export interface OfficeAuthViewModel {
  screen: AuthScreen
  /** What the API refused, or why it could not be asked (`auth:problem.…`). */
  problem?: AuthProblem | null
  /** A request is on its way: the form waits. */
  busy?: boolean
  /** What the form's own check found (the design fixtures show it; the live page finds it on submit). */
  fieldErrors?: Readonly<Record<string, FieldProblem>>
  /** The site's time zone, for the invitation's expiry. */
  timeZone?: string
  /** Put the focus in the form's first empty field when it appears (the live page; not the design index's frames). */
  autoFocus?: boolean
}

export type AuthAction =
  | { type: 'sign-in'; company: string; email: string; password: string }
  | { type: 'code'; code: string }
  | { type: 'recovery'; on: boolean }
  /** From the code step: start again (another person, or a mistyped email). */
  | { type: 'restart' }
  /** A forced or reset password. */
  | { type: 'new-password'; password: string }
  | { type: 'forgot'; company: string; email: string }
  | { type: 'accept'; displayName: string; password: string }
  | { type: 'enrol'; now: boolean }

export interface OfficeAuthViewProps {
  model: OfficeAuthViewModel
  /** The page's flow; absent in the design index (the forms then only check themselves). */
  onAction?: (action: AuthAction) => void
}

const TITLE: Record<AuthScreen['kind'], string> = {
  'sign-in': 'signIn.title',
  code: 'code.title',
  change: 'change.title',
  forgot: 'forgot.title',
  'forgot-sent': 'forgotSent.title',
  reset: 'reset.title',
  'reset-done': 'resetDone.title',
  'invite-checking': 'invite.checking',
  invite: 'invite.title',
  'invite-done': 'inviteDone.title',
  'link-invalid': 'link.resetInvalid.title',
  'link-missing': 'link.missing.title',
}

export function OfficeAuthView({ model, onAction }: OfficeAuthViewProps) {
  const t = useT('auth')
  const locale = useLocale()
  const switchLocale = useLocaleSwitch()
  const { screen } = model
  const title =
    screen.kind === 'invite'
      ? t('invite.title', { tenant: screen.tenant })
      : screen.kind === 'link-invalid' && screen.link === 'invite'
        ? t('link.inviteInvalid.title')
        : t(TITLE[screen.kind])
  const subtitle = subtitleOf(screen, t, locale, model.timeZone)

  return (
    <div className="fw-auth">
      <header className="fw-auth-head">
        <span className="fw-auth-brand">
          <span className="fw-auth-mark" aria-hidden="true">
            F
          </span>
          {t('brand')}
        </span>
        <SegmentedControl
          ariaLabel={t('language')}
          size="sm"
          value={locale}
          onChange={(value) => isLocale(value) && switchLocale?.(value)}
          options={LOCALES.map((option) => ({ value: option, label: <span lang={option}>{LOCALE_NAMES[option]}</span> }))}
        />
      </header>
      <main id="main-content" tabIndex={-1} className="fw-auth-main">
        <div className="fw-auth-column">
          <div className="fw-auth-title">
            <h1>{title}</h1>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <Card padded>
            {/* A form is keyed by its screen, so what the person typed stays while the page answers. */}
            <ScreenBody key={screenKey(screen)} model={model} onAction={onAction} />
          </Card>
        </div>
      </main>
      <footer className="fw-auth-foot">{t('footer')}</footer>
    </div>
  )
}

const screenKey = (screen: AuthScreen) => (screen.kind === 'code' ? `code-${screen.recovery ? 'recovery' : 'app'}` : screen.kind)

function subtitleOf(screen: AuthScreen, t: (key: string, params?: Record<string, string | number>) => string, locale: ReturnType<typeof useLocale>, timeZone?: string): string | null {
  switch (screen.kind) {
    case 'sign-in':
      return t('signIn.subtitle')
    case 'code':
      return t('code.subtitle', { email: screen.email })
    case 'change':
      return t('change.subtitle')
    case 'forgot':
      return t('forgot.subtitle')
    case 'reset':
      return t('reset.subtitle')
    case 'invite':
      return t('invite.subtitle', { email: screen.email, expires: formatDateTime(screen.expiresAt, { locale, timeZone }) })
    default:
      return null
  }
}

function ScreenBody({ model, onAction }: OfficeAuthViewProps) {
  const t = useT('auth')
  const { screen, busy = false } = model
  const form = { busy, errors: model.fieldErrors, autoFocus: model.autoFocus ?? false, onAction }
  const problem = model.problem ? (
    <Banner tone={model.problem === 'rateLimited' ? 'warning' : 'danger'}>{t(`problem.${model.problem}`)}</Banner>
  ) : null

  switch (screen.kind) {
    case 'sign-in':
      return <SignInForm screen={screen} problem={problem} {...form} />
    case 'code':
      return <CodeForm screen={screen} problem={problem} {...form} />
    case 'change':
    case 'reset':
      return (
        <NewPasswordForm
          email={screen.kind === 'change' ? screen.email : null}
          submit={t(screen.kind === 'change' ? 'change.submit' : 'reset.submit')}
          problem={problem}
          {...form}
          after={
            screen.kind === 'change' ? (
              <div className="fw-auth-links">
                <Button variant="link" disabled={busy} onClick={() => onAction?.({ type: 'restart' })}>
                  {t('code.back')}
                </Button>
              </div>
            ) : null
          }
        />
      )
    case 'forgot':
      return <ForgotForm screen={screen} problem={problem} {...form} />
    case 'invite':
      return <InviteForm screen={screen} problem={problem} {...form} />
    case 'forgot-sent':
      return (
        <Result tone="info" body={t('forgotSent.body', { email: screen.email })}>
          <ButtonLink href="/sign-in" variant="secondary" label={t('forgotSent.back')} />
        </Result>
      )
    case 'reset-done':
      return (
        <Result tone="success" body={t('resetDone.body')}>
          <ButtonLink href="/sign-in" variant="primary" label={t('resetDone.action')} />
        </Result>
      )
    case 'invite-checking':
      // The title says what is happening; the spinner only shows it. A failure says why (open the mail's link again).
      return (
        problem ?? (
          <div className="fw-auth-waiting">
            <Spinner size={20} />
          </div>
        )
      )
    case 'invite-done':
      if (screen.noCompany) {
        return (
          <Result tone="info" body={t('problem.noCompany')}>
            <ButtonLink href="/sign-in" variant="secondary" label={t('link.inviteInvalid.action')} />
          </Result>
        )
      }
      return (
        <Result tone={screen.mfaRequired ? 'warning' : 'success'} body={t(screen.mfaRequired ? 'inviteDone.required' : 'inviteDone.optional')}>
          <Button variant="primary" disabled={busy} onClick={() => onAction?.({ type: 'enrol', now: true })}>
            {t('inviteDone.setup')}
          </Button>
          {!screen.mfaRequired && (
            <Button variant="secondary" disabled={busy} onClick={() => onAction?.({ type: 'enrol', now: false })}>
              {t('inviteDone.later')}
            </Button>
          )}
        </Result>
      )
    case 'link-invalid':
      return screen.link === 'reset' ? (
        <Result tone="warning" body={t('link.resetInvalid.body')}>
          <ButtonLink href="/forgot-password" variant="primary" label={t('link.resetInvalid.action')} />
        </Result>
      ) : (
        <Result tone="warning" body={t('link.inviteInvalid.body')}>
          <ButtonLink href="/sign-in" variant="secondary" label={t('link.inviteInvalid.action')} />
        </Result>
      )
    case 'link-missing':
      return (
        <Result tone="warning" body={t('link.missing.body')}>
          <ButtonLink href="/sign-in" variant="secondary" label={t('link.missing.action')} />
        </Result>
      )
  }
}

/* ── forms ─────────────────────────────────────────────────────────────────────────────────────────────────────── */

interface FormProps<S> {
  screen: S
  busy: boolean
  problem: ReactNode
  errors?: Readonly<Record<string, FieldProblem>>
  autoFocus: boolean
  onAction?: (action: AuthAction) => void
}

/** A form's field problems: shown under each field; the first one takes the focus. */
function useFieldProblems<F extends string>(initial: Readonly<Record<string, FieldProblem>> | undefined, order: readonly F[]) {
  const t = useT('auth')
  const [problems, setProblems] = useState<FieldProblems<F>>(() => (initial ?? {}) as FieldProblems<F>)
  const refs = useRef<Partial<Record<F, HTMLInputElement | null>>>({})
  const bind = (name: F) => (node: HTMLInputElement | null) => {
    refs.current[name] = node
  }
  const text = (name: F) => {
    const problem = problems[name]
    return problem ? t(problem.key, problem.params) : undefined
  }
  /** True when the values passed; otherwise shows the problems and focuses the first. */
  const accept = (found: FieldProblems<F>): boolean => {
    setProblems(found)
    const first = order.find((name) => found[name])
    if (first) refs.current[first]?.focus()
    return first === undefined
  }
  const clear = (name: F) => {
    if (problems[name]) setProblems((current) => ({ ...current, [name]: undefined }))
  }
  return { bind, text, accept, clear, refs }
}

/**
 * When `on`, focuses the form's first field with a problem, else its first empty one, once, as it appears: the company
 * remembered on this device sends the person straight to the email.
 */
function useFirstFocus(on: boolean, refs: RefObject<Partial<Record<string, HTMLInputElement | null>>>, order: readonly string[]) {
  const first = useRef(true)
  useEffect(() => {
    if (!on || !first.current) return
    first.current = false
    const fields = order.map((name) => refs.current?.[name]).filter((node): node is HTMLInputElement => Boolean(node))
    ;(fields.find((node) => node.getAttribute('aria-invalid') === 'true') ?? fields.find((node) => node.value === '') ?? fields[0])?.focus()
  }, [on, refs, order])
}

const submitting = (busy: boolean, label: string) => (
  <>
    {busy && <Spinner size={14} />}
    {label}
  </>
)

const SIGN_IN_FIELDS = ['company', 'email', 'password'] as const
const CODE_FIELDS = ['code'] as const
const NEW_PASSWORD_FIELDS = ['password', 'confirmation'] as const
const FORGOT_FIELDS = ['company', 'email'] as const
const INVITE_FIELDS = ['displayName', 'password', 'confirmation'] as const
/** The invitation's name is filled in already: the focus starts at the password. */
const INVITE_FOCUS = ['password', 'confirmation', 'displayName'] as const

function SignInForm({ screen, busy, problem, errors, autoFocus, onAction }: FormProps<Extract<AuthScreen, { kind: 'sign-in' }>>) {
  const t = useT('auth')
  const [values, setValues] = useState({ company: screen.company, email: screen.email, password: '' })
  const order = SIGN_IN_FIELDS
  const fields = useFieldProblems(errors, order)
  useFirstFocus(autoFocus, fields.refs, order)
  const change = (name: (typeof order)[number], value: string) => {
    setValues((current) => ({ ...current, [name]: value }))
    fields.clear(name)
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (busy || !fields.accept(checkSignIn(values))) return
    onAction?.({ type: 'sign-in', ...values })
  }
  return (
    <form className="fw-auth-form" onSubmit={submit} noValidate aria-busy={busy}>
      {problem}
      <Field label={t('signIn.company')} hint={t('signIn.companyHint')} error={fields.text('company')}>
        <Input ref={fields.bind('company')} name="company" autoComplete="organization" autoCapitalize="none" spellCheck={false} value={values.company} onChange={(event) => change('company', event.target.value)} />
      </Field>
      <Field label={t('signIn.email')} error={fields.text('email')}>
        <Input ref={fields.bind('email')} name="email" type="email" autoComplete="username" spellCheck={false} value={values.email} onChange={(event) => change('email', event.target.value)} />
      </Field>
      <Field label={t('signIn.password')} error={fields.text('password')}>
        <Input ref={fields.bind('password')} name="password" type="password" autoComplete="current-password" value={values.password} onChange={(event) => change('password', event.target.value)} />
      </Field>
      <div className="fw-auth-actions">
        <Button type="submit" variant="primary" disabled={busy}>
          {submitting(busy, t('signIn.submit'))}
        </Button>
      </div>
      <TextLink href="/forgot-password" label={t('signIn.forgot')} />
    </form>
  )
}

function CodeForm({ screen, busy, problem, errors, autoFocus, onAction }: FormProps<Extract<AuthScreen, { kind: 'code' }>>) {
  const t = useT('auth')
  const [code, setCode] = useState('')
  const order = CODE_FIELDS
  const fields = useFieldProblems(errors, order)
  useFirstFocus(autoFocus, fields.refs, order)
  const change = (value: string) => {
    setCode(value)
    fields.clear('code')
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (busy || !fields.accept(checkCode(code, screen.recovery))) return
    onAction?.({ type: 'code', code: code.trim() })
  }
  return (
    <form className="fw-auth-form" onSubmit={submit} noValidate aria-busy={busy}>
      {problem}
      <Field label={t(screen.recovery ? 'code.recovery' : 'code.app')} hint={t(screen.recovery ? 'code.recoveryHint' : 'code.appHint')} error={fields.text('code')}>
        {screen.recovery ? (
          <Input ref={fields.bind('code')} name="recovery-code" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={16} value={code} onChange={(event) => change(event.target.value)} />
        ) : (
          <Input ref={fields.bind('code')} name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code} onChange={(event) => change(event.target.value)} />
        )}
      </Field>
      <div className="fw-auth-actions">
        <Button type="submit" variant="primary" disabled={busy}>
          {submitting(busy, t('code.submit'))}
        </Button>
      </div>
      <div className="fw-auth-links">
        <Button variant="link" disabled={busy} onClick={() => onAction?.({ type: 'recovery', on: !screen.recovery })}>
          {t(screen.recovery ? 'code.useApp' : 'code.useRecovery')}
        </Button>
        <Button variant="link" disabled={busy} onClick={() => onAction?.({ type: 'restart' })}>
          {t('code.back')}
        </Button>
      </div>
    </form>
  )
}

function NewPasswordForm({
  email,
  submit: submitLabel,
  busy,
  problem,
  errors,
  autoFocus,
  onAction,
  after,
}: Omit<FormProps<null>, 'screen'> & { email: string | null; submit: string; after?: ReactNode }) {
  const [values, setValues] = useState({ password: '', confirmation: '' })
  const order = NEW_PASSWORD_FIELDS
  const fields = useFieldProblems(errors, order)
  useFirstFocus(autoFocus, fields.refs, order)
  const change = (name: (typeof order)[number], value: string) => {
    setValues((current) => ({ ...current, [name]: value }))
    fields.clear(name)
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (busy || !fields.accept(checkNewPassword(values, { email }))) return
    onAction?.({ type: 'new-password', password: values.password })
  }
  return (
    <form className="fw-auth-form" onSubmit={submit} noValidate aria-busy={busy}>
      {problem}
      <NewPasswordFields values={values} change={change} text={fields.text} bind={fields.bind} />
      <div className="fw-auth-actions">
        <Button type="submit" variant="primary" disabled={busy}>
          {submitting(busy, submitLabel)}
        </Button>
      </div>
      {after}
    </form>
  )
}

type PasswordField = (typeof NEW_PASSWORD_FIELDS)[number]

function NewPasswordFields({
  values,
  change,
  text,
  bind,
}: {
  values: { password: string; confirmation: string }
  change: (name: PasswordField, value: string) => void
  text: (name: PasswordField) => string | undefined
  bind: (name: PasswordField) => (node: HTMLInputElement | null) => void
}) {
  const t = useT('auth')
  return (
    <>
      <Field label={t('newPassword.password')} hint={t('newPassword.hint', { min: PASSWORD_RULES.min })} error={text('password')}>
        <Input ref={bind('password')} name="new-password" type="password" autoComplete="new-password" value={values.password} onChange={(event) => change('password', event.target.value)} />
      </Field>
      <Field label={t('newPassword.repeat')} error={text('confirmation')}>
        <Input ref={bind('confirmation')} name="repeat-password" type="password" autoComplete="new-password" value={values.confirmation} onChange={(event) => change('confirmation', event.target.value)} />
      </Field>
    </>
  )
}

function ForgotForm({ screen, busy, problem, errors, autoFocus, onAction }: FormProps<Extract<AuthScreen, { kind: 'forgot' }>>) {
  const t = useT('auth')
  const [values, setValues] = useState({ company: screen.company, email: screen.email })
  const order = FORGOT_FIELDS
  const fields = useFieldProblems(errors, order)
  useFirstFocus(autoFocus, fields.refs, order)
  const change = (name: (typeof order)[number], value: string) => {
    setValues((current) => ({ ...current, [name]: value }))
    fields.clear(name)
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (busy || !fields.accept(checkForgot(values))) return
    onAction?.({ type: 'forgot', ...values })
  }
  return (
    <form className="fw-auth-form" onSubmit={submit} noValidate aria-busy={busy}>
      {problem}
      <Field label={t('signIn.company')} hint={t('signIn.companyHint')} error={fields.text('company')}>
        <Input ref={fields.bind('company')} name="company" autoComplete="organization" autoCapitalize="none" spellCheck={false} value={values.company} onChange={(event) => change('company', event.target.value)} />
      </Field>
      <Field label={t('signIn.email')} error={fields.text('email')}>
        <Input ref={fields.bind('email')} name="email" type="email" autoComplete="username" spellCheck={false} value={values.email} onChange={(event) => change('email', event.target.value)} />
      </Field>
      <div className="fw-auth-actions">
        <Button type="submit" variant="primary" disabled={busy}>
          {submitting(busy, t('forgot.submit'))}
        </Button>
      </div>
      <TextLink href="/sign-in" label={t('forgot.back')} />
    </form>
  )
}

function InviteForm({ screen, busy, problem, errors, autoFocus, onAction }: FormProps<Extract<AuthScreen, { kind: 'invite' }>>) {
  const t = useT('auth')
  const [values, setValues] = useState({ displayName: screen.displayName, password: '', confirmation: '' })
  const order = INVITE_FIELDS
  const fields = useFieldProblems(errors, order)
  useFirstFocus(autoFocus, fields.refs, INVITE_FOCUS)
  const change = (name: (typeof order)[number], value: string) => {
    setValues((current) => ({ ...current, [name]: value }))
    fields.clear(name)
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (busy || !fields.accept(checkInvitation(values, screen.email))) return
    onAction?.({ type: 'accept', displayName: values.displayName, password: values.password })
  }
  return (
    <form className="fw-auth-form" onSubmit={submit} noValidate aria-busy={busy}>
      {problem}
      {/* The account's address, for the browser's password manager. */}
      <input type="email" name="email" autoComplete="username" value={screen.email} readOnly hidden />
      <Field label={t('invite.name')} hint={t('invite.nameHint')} error={fields.text('displayName')}>
        <Input ref={fields.bind('displayName')} name="name" autoComplete="name" value={values.displayName} onChange={(event) => change('displayName', event.target.value)} />
      </Field>
      <NewPasswordFields values={values} change={change} text={fields.text} bind={fields.bind} />
      <div className="fw-auth-actions">
        <Button type="submit" variant="primary" disabled={busy}>
          {submitting(busy, t('invite.submit'))}
        </Button>
      </div>
    </form>
  )
}

/* ── results and links ─────────────────────────────────────────────────────────────────────────────────────────── */

function Result({ tone, body, children }: { tone: 'info' | 'success' | 'warning'; body: string; children?: ReactNode }) {
  return (
    <div className="fw-auth-form">
      <Banner tone={tone}>{body}</Banner>
      <div className="fw-auth-actions">{children}</div>
    </div>
  )
}

function ButtonLink({ href, label, variant }: { href: string; label: string; variant: 'primary' | 'secondary' }) {
  return (
    <Button asChild variant={variant}>
      <Link href={href}>{label}</Link>
    </Button>
  )
}

function TextLink({ href, label }: { href: string; label: string }) {
  return (
    <div className="fw-auth-links">
      <Button asChild variant="link">
        <Link href={href}>{label}</Link>
      </Button>
    </div>
  )
}
