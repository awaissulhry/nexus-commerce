'use client'

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Banner, Card, Field, KeyValue } from '@nexus/ui/components'
import { QrCode } from '@nexus/ui/components/QrCode/index'
import { PageHeader } from '@nexus/ui/patterns'
import { Button, Input, SegmentedControl, Spinner, Tag } from '@nexus/ui/primitives'
import { checkNewPassword, PASSWORD_RULES } from '../../../lib/auth/password-rules'
import { formatDateTime, formatNumber } from '../../../lib/i18n/format'
import { LOCALES, LOCALE_NAMES, isLocale, type Locale } from '../../../lib/i18n/locales'
import { useT } from '../../../lib/i18n/provider'
import { THEME_MODES, type ThemeMode } from '../../../lib/theme/theme'
import { checkCurrentPassword, checkTotpCode, groupedSecret, RECOVERY_LOW, type MeFieldProblem, type MeProblem, type MyProfileViewModel } from '../me-model'
import '../me.css'

/**
 * SCR-007 — my profile & security (PLT-127, PLT-134, PLT-135, PLT-048, PLT-070; A2 §2.1), reached from the person's
 * menu in the top bar (not a sidebar row). Four cards: language and display (the language is the person's, the theme
 * this device's), password, the authenticator app (set-up with a QR code, the recovery codes shown ONCE, switch-off
 * when the role allows it), and this session. The API lists no other session yet (PLT-064 is a later wave): the card
 * says so, and that a new password signs out every other device. Design-system parts only.
 */

export type MeAction =
  | { type: 'locale'; locale: Locale }
  | { type: 'theme'; mode: ThemeMode }
  | { type: 'password-open' }
  | { type: 'password-cancel' }
  | { type: 'password'; current: string; password: string }
  | { type: 'totp-setup' }
  | { type: 'totp-cancel' }
  | { type: 'totp-confirm'; code: string }
  | { type: 'codes-saved' }
  | { type: 'totp-disable-open' }
  | { type: 'totp-disable'; password: string }
  | { type: 'sign-out' }

export interface MyProfileViewProps {
  model: MyProfileViewModel
  /** The page's actions; absent in the design index (forms then only check themselves). */
  onAction?: (action: MeAction) => void
}

type Translate = ReturnType<typeof useT>

export function MyProfileView({ model, onAction }: MyProfileViewProps) {
  const t = useT('me')
  return (
    <div className="fw-me">
      <PageHeader title={t('title')} subtitle={t('subtitle', { name: model.person.displayName, email: model.person.email, tenant: model.tenant })} />
      <div className="fw-me-cards">
        <DisplayCard model={model} onAction={onAction} />
        <AuthenticatorCardView model={model} onAction={onAction} />
        <PasswordCardView model={model} onAction={onAction} />
        <SessionCard model={model} onAction={onAction} />
      </div>
    </div>
  )
}

function ProblemBanner({ problem, t }: { problem?: MeProblem | null; t: Translate }) {
  if (!problem) return null
  return <Banner tone={problem === 'rateLimited' || problem === 'locked' ? 'warning' : 'danger'}>{t(`problem.${problem}`)}</Banner>
}

const busyLabel = (busy: boolean | undefined, label: string) => (
  <>
    {busy && <Spinner size={14} />}
    {label}
  </>
)

/* ── language and display ──────────────────────────────────────────────────────────────────────────────────────── */

function DisplayCard({ model, onAction }: MyProfileViewProps) {
  const t = useT('me')
  const place = { locale: model.locale, timeZone: model.timeZone }
  const sample = `${formatNumber(1234.5, model.locale, { minimumFractionDigits: 2 })} · ${formatDateTime(model.session.createdAt, place)}`
  return (
    <Card header={t('display.title')} description={t('display.description')} headingLevel={2}>
      <div className="fw-me-stack">
        <ProblemBanner problem={model.language?.problem} t={t} />
        <KeyValue
          labelCase="sentence"
          items={[
            {
              label: t('display.language'),
              value: (
                <span className="fw-me-inline">
                  <SegmentedControl
                    ariaLabel={t('display.language')}
                    size="sm"
                    value={model.locale}
                    disabled={model.language?.busy}
                    onChange={(value) => isLocale(value) && value !== model.locale && onAction?.({ type: 'locale', locale: value })}
                    options={LOCALES.map((option) => ({ value: option, label: <span lang={option}>{LOCALE_NAMES[option]}</span> }))}
                  />
                  {model.language?.busy && <Spinner size={14} />}
                </span>
              ),
            },
            {
              label: t('display.theme'),
              value: (
                <SegmentedControl
                  ariaLabel={t('display.theme')}
                  size="sm"
                  wrap
                  value={model.theme}
                  onChange={(value) => onAction?.({ type: 'theme', mode: value as ThemeMode })}
                  options={THEME_MODES.map((mode) => ({ value: mode, label: t(`display.themes.${mode}`) }))}
                />
              ),
            },
            { label: t('display.formats'), value: sample },
            { label: t('display.timeZone'), value: t('display.timeZoneValue', { zone: model.timeZone }) },
          ]}
        />
      </div>
    </Card>
  )
}

/* ── forms ─────────────────────────────────────────────────────────────────────────────────────────────────────── */

/** A form's field problems (from its own check, or the fixtures'), shown under each field; the first takes the focus. */
function useFields(initial: Readonly<Record<string, MeFieldProblem>> | undefined, autoFocus: boolean, order: readonly string[]) {
  const t = useT('me')
  const [problems, setProblems] = useState<Partial<Record<string, MeFieldProblem>>>({ ...initial })
  const refs = useRef<Record<string, HTMLInputElement | null>>({})
  const opened = useRef(false)
  // As the form opens: the focus in its first field with a problem, else its first field.
  useEffect(() => {
    if (!autoFocus || opened.current) return
    opened.current = true
    refs.current[order.find((name) => problems[name]) ?? order[0]]?.focus()
  }, [autoFocus, order, problems])
  return {
    bind: (name: string) => (node: HTMLInputElement | null) => {
      refs.current[name] = node
    },
    text: (name: string) => {
      const problem = problems[name]
      return problem ? t(problem.key, problem.params) : undefined
    },
    clear: (name: string) => {
      if (problems[name]) setProblems((current) => ({ ...current, [name]: undefined }))
    },
    accept: (found: Readonly<Record<string, MeFieldProblem>>) => {
      setProblems(found)
      const first = order.find((name) => found[name])
      if (first) refs.current[first]?.focus()
      return first === undefined
    },
  }
}

/* ── password ──────────────────────────────────────────────────────────────────────────────────────────────────── */

const PASSWORD_FIELDS = ['current', 'password', 'confirmation'] as const

function PasswordCardView({ model, onAction }: MyProfileViewProps) {
  const t = useT('me')
  const card = model.password
  return (
    <Card header={t('password.title')} description={t('password.description')} headingLevel={2} id="password">
      {card.state === 'closed' ? (
        <div className="fw-me-stack">
          {card.done && (
            <Banner tone="success">
              {t('password.done')} {card.done.sessionsEnded > 0 ? t('password.ended', { count: card.done.sessionsEnded }) : ''}
            </Banner>
          )}
          <div className="fw-me-actions">
            <Button onClick={() => onAction?.({ type: 'password-open' })}>{t('password.change')}</Button>
          </div>
        </div>
      ) : (
        <PasswordForm card={card} model={model} onAction={onAction} />
      )}
    </Card>
  )
}

function PasswordForm({ card, model, onAction }: { card: Extract<MyProfileViewModel['password'], { state: 'open' }> } & MyProfileViewProps) {
  const t = useT('me')
  const [values, setValues] = useState({ current: '', password: '', confirmation: '' })
  const fields = useFields(card.fieldErrors, model.autoFocus ?? false, PASSWORD_FIELDS)
  const change = (name: (typeof PASSWORD_FIELDS)[number], value: string) => {
    setValues((current) => ({ ...current, [name]: value }))
    fields.clear(name)
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (card.busy) return
    const found = { ...checkCurrentPassword(values.current), ...checkNewPassword(values, { email: model.person.email, displayName: model.person.displayName }) }
    if (!fields.accept(found)) return
    onAction?.({ type: 'password', current: values.current, password: values.password })
  }
  return (
    <form className="fw-me-stack" onSubmit={submit} noValidate aria-busy={card.busy}>
      <ProblemBanner problem={card.problem} t={t} />
      {/* The account's address, for the browser's password manager. */}
      <input type="email" name="email" autoComplete="username" value={model.person.email} readOnly hidden />
      <Field label={t('password.current')} error={fields.text('current')}>
        <Input ref={fields.bind('current')} name="current-password" type="password" autoComplete="current-password" value={values.current} onChange={(event) => change('current', event.target.value)} />
      </Field>
      <Field label={t('password.new')} hint={t('password.newHint', { min: PASSWORD_RULES.min })} error={fields.text('password')}>
        <Input ref={fields.bind('password')} name="new-password" type="password" autoComplete="new-password" value={values.password} onChange={(event) => change('password', event.target.value)} />
      </Field>
      <Field label={t('password.repeat')} error={fields.text('confirmation')}>
        <Input ref={fields.bind('confirmation')} name="repeat-password" type="password" autoComplete="new-password" value={values.confirmation} onChange={(event) => change('confirmation', event.target.value)} />
      </Field>
      <div className="fw-me-actions">
        <Button type="submit" variant="primary" disabled={card.busy}>
          {busyLabel(card.busy, t('password.submit'))}
        </Button>
        <Button disabled={card.busy} onClick={() => onAction?.({ type: 'password-cancel' })}>
          {t('password.cancel')}
        </Button>
      </div>
    </form>
  )
}

/* ── authenticator app ─────────────────────────────────────────────────────────────────────────────────────────── */

function AuthenticatorCardView({ model, onAction }: MyProfileViewProps) {
  const t = useT('me')
  const card = model.authenticator
  const on = card.state === 'on' || card.state === 'disable' || card.state === 'codes'
  return (
    <Card
      header={t('authenticator.title')}
      description={t('authenticator.description')}
      headingLevel={2}
      id="authenticator"
      headerAction={<Tag tone={on ? 'success' : card.state === 'off' && card.required ? 'warning' : 'neutral'}>{t(on ? 'authenticator.on' : 'authenticator.off')}</Tag>}
    >
      <AuthenticatorBody model={model} onAction={onAction} />
    </Card>
  )
}

function AuthenticatorBody({ model, onAction }: MyProfileViewProps) {
  const t = useT('me')
  const card = model.authenticator
  switch (card.state) {
    case 'off':
      return (
        <div className="fw-me-stack">
          <ProblemBanner problem={card.problem} t={t} />
          {card.turnedOff && <Banner tone="success">{t('authenticator.turnedOff')}</Banner>}
          {card.required && <Banner tone="warning">{t('authenticator.required')}</Banner>}
          <div className="fw-me-actions">
            <Button variant="primary" disabled={card.busy} onClick={() => onAction?.({ type: 'totp-setup' })}>
              {busyLabel(card.busy, t('authenticator.setup'))}
            </Button>
          </div>
        </div>
      )
    case 'setup':
      return <SetupForm card={card} model={model} onAction={onAction} />
    case 'codes':
      return <RecoveryCodes codes={card.recoveryCodes} onAction={onAction} />
    case 'on':
      return (
        <div className="fw-me-stack">
          {card.turnedOn && <Banner tone="success">{t('authenticator.turnedOn')}</Banner>}
          <KeyValue labelCase="sentence" items={[{ label: t('authenticator.recoveryLeft'), value: String(card.recoveryCodesLeft) }]} />
          {card.recoveryCodesLeft <= RECOVERY_LOW && !card.required && <Banner tone="warning">{t('authenticator.recoveryLow')}</Banner>}
          {card.required ? (
            <p className="fw-me-note">{t('authenticator.requiredOn')}</p>
          ) : (
            <div className="fw-me-actions">
              <Button variant="danger-outline" onClick={() => onAction?.({ type: 'totp-disable-open' })}>
                {t('authenticator.disable')}
              </Button>
            </div>
          )}
        </div>
      )
    case 'disable':
      return <DisableForm card={card} model={model} onAction={onAction} />
  }
}

const CODE_FIELDS = ['code'] as const

function SetupForm({ card, model, onAction }: { card: Extract<MyProfileViewModel['authenticator'], { state: 'setup' }> } & MyProfileViewProps) {
  const t = useT('me')
  const [code, setCode] = useState('')
  const fields = useFields(card.fieldErrors, model.autoFocus ?? false, CODE_FIELDS)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (card.busy || !fields.accept(checkTotpCode(code))) return
    onAction?.({ type: 'totp-confirm', code: code.trim() })
  }
  return (
    <form className="fw-me-stack" onSubmit={submit} noValidate aria-busy={card.busy}>
      <ProblemBanner problem={card.problem} t={t} />
      <p className="fw-me-step">{t('authenticator.scan')}</p>
      <div className="fw-me-qr">
        <QrCode
          value={card.otpauthUri}
          code={groupedSecret(card.secret)}
          label={t('authenticator.qrLabel')}
          size={184}
          labels={{ copy: t('qr.copy'), copied: t('qr.copied'), copyFailed: t('qr.copyFailed'), loading: t('qr.loading'), tooLong: t('qr.tooLong') }}
        />
      </div>
      <p className="fw-me-step">{t('authenticator.enter')}</p>
      <Field label={t('authenticator.code')} error={fields.text('code')}>
        <Input
          ref={fields.bind('code')}
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={8}
          value={code}
          onChange={(event) => {
            setCode(event.target.value)
            fields.clear('code')
          }}
        />
      </Field>
      <div className="fw-me-actions">
        <Button type="submit" variant="primary" disabled={card.busy}>
          {busyLabel(card.busy, t('authenticator.confirm'))}
        </Button>
        <Button disabled={card.busy} onClick={() => onAction?.({ type: 'totp-cancel' })}>
          {t('authenticator.cancel')}
        </Button>
      </div>
    </form>
  )
}

function RecoveryCodes({ codes, onAction }: { codes: readonly string[]; onAction?: MyProfileViewProps['onAction'] }) {
  const t = useT('me')
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copyAll = () => {
    const text = codes.join('\n')
    const done = (state: 'copied' | 'failed') => setCopy(state)
    if (!navigator.clipboard) return done('failed')
    navigator.clipboard.writeText(text).then(
      () => done('copied'),
      () => done('failed'),
    )
  }
  return (
    <div className="fw-me-stack">
      <Banner tone="warning" title={t('authenticator.codesTitle')}>
        {t('authenticator.codesBody')}
      </Banner>
      <ol className="fw-me-codes" aria-label={t('authenticator.codesTitle')}>
        {codes.map((code) => (
          <li key={code}>
            <code>{code}</code>
          </li>
        ))}
      </ol>
      <div className="fw-me-actions">
        <Button onClick={copyAll}>{t(copy === 'copied' ? 'authenticator.copied' : 'authenticator.copy')}</Button>
        <Button variant="primary" onClick={() => onAction?.({ type: 'codes-saved' })}>
          {t('authenticator.codesDone')}
        </Button>
      </div>
      <span className="nds-vh" role="status" aria-live="polite">
        {copy === 'copied' ? t('authenticator.copied') : copy === 'failed' ? t('authenticator.copyFailed') : ''}
      </span>
    </div>
  )
}

const DISABLE_FIELDS = ['password'] as const

function DisableForm({ card, model, onAction }: { card: Extract<MyProfileViewModel['authenticator'], { state: 'disable' }> } & MyProfileViewProps) {
  const t = useT('me')
  const [password, setPassword] = useState('')
  const fields = useFields(card.fieldErrors, model.autoFocus ?? false, DISABLE_FIELDS)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (card.busy || !fields.accept(password === '' ? { password: { key: 'field.passwordRequired' } } : {})) return
    onAction?.({ type: 'totp-disable', password })
  }
  return (
    <form className="fw-me-stack" onSubmit={submit} noValidate aria-busy={card.busy}>
      <ProblemBanner problem={card.problem} t={t} />
      <p className="fw-me-note">{t('authenticator.disableBody')}</p>
      <input type="email" name="email" autoComplete="username" value={model.person.email} readOnly hidden />
      <Field label={t('password.title')} error={fields.text('password')}>
        <Input
          ref={fields.bind('password')}
          name="current-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value)
            fields.clear('password')
          }}
        />
      </Field>
      <div className="fw-me-actions">
        <Button type="submit" variant="danger" disabled={card.busy}>
          {busyLabel(card.busy, t('authenticator.disableSubmit'))}
        </Button>
        <Button disabled={card.busy} onClick={() => onAction?.({ type: 'totp-cancel' })}>
          {t('authenticator.cancel')}
        </Button>
      </div>
    </form>
  )
}

/* ── this session ──────────────────────────────────────────────────────────────────────────────────────────────── */

function SessionCard({ model, onAction }: MyProfileViewProps) {
  const t = useT('me')
  const place = { locale: model.locale, timeZone: model.timeZone }
  const when = (value: string): ReactNode => formatDateTime(value, place)
  return (
    <Card header={t('sessions.title')} description={t('sessions.description')} headingLevel={2} id="sessions" headerAction={<Tag tone="info">{t('sessions.thisDevice')}</Tag>}>
      <div className="fw-me-stack">
        <ProblemBanner problem={model.signOut?.problem} t={t} />
        <KeyValue
          labelCase="sentence"
          items={[
            { label: t('sessions.started'), value: when(model.session.createdAt) },
            { label: t('sessions.idle'), value: when(model.session.idleExpiresAt), hint: t('sessions.idleHint') },
            { label: t('sessions.absolute'), value: when(model.session.absoluteExpiresAt) },
          ]}
        />
        <p className="fw-me-note">{t('sessions.others')}</p>
        <div className="fw-me-actions">
          <Button disabled={model.signOut?.busy} onClick={() => onAction?.({ type: 'sign-out' })}>
            {busyLabel(model.signOut?.busy, t('sessions.signOut'))}
          </Button>
        </div>
      </div>
    </Card>
  )
}
