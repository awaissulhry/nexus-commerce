'use client'

import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { Link2Off, MailQuestion } from 'lucide-react'
import { Banner, Card, Field } from '@nexus/ui/components'
import { CodeInput, codeFromText } from '@nexus/ui/components/CodeInput/index'
import { EndState } from '@nexus/ui/components/EndState/index'
import { Button, Checkbox, Input, RadioCard, SegmentedControl, Skeleton, Spinner } from '@nexus/ui/primitives'
import { brandingAttrs, checkBranding, type BrandingTokens } from '@nexus/ui/tokens/branding'
import { densityAttrs } from '@nexus/ui/tokens/density'
import '@nexus/ui/styles/branding.css'
import { useDsLabels } from '../../../lib/i18n/ds-labels'
import { LOCALES, LOCALE_NAMES, isLocale, type Locale } from '../../../lib/i18n/locales'
import { useLocale, useLocaleSwitch, useT } from '../../../lib/i18n/provider'
import { emailProblem, firstVisitProblems, SUMMARIES, waitParts, type AccessProblem, type CodeProblem, type EndedReason, type Summaries } from '../model'
import '../signin.css'

/**
 * SCR-026 — the portal's Sign in (B-W2b-164; PLT-050, PLT-066, SCM-092; design portal.signin). No frame: no rail, no
 * search, no bottom bar before sign-in. At the top WHOSE portal it is (the company's logo — the dark one in the dark
 * theme — and the portal's name, its accent only where it passes its contrast check) and the language; in the middle ONE
 * step at a time: the work e-mail, the code from the e-mail (or the mailed link's Continue), the first visit (name,
 * language, e-mail summaries, the portal terms once); at the foot never a dead end: "the portal is by invitation", whom
 * to ask, the company's privacy notice in a new tab and its legal block (c.c. art. 2250). Comfortable density.
 *
 * The view draws ONE screen of the flow from its model and keeps only what the person types; the container
 * (PortalSignIn.tsx) talks to the API. A form checks itself before it asks; what the API refused comes back in the model
 * in the page's own words.
 */

export interface LegalBlock {
  name: string
  lines: readonly string[]
}

/** Whose portal it is: the branding tokens (the portal's name in `name`), the company, whom to ask, the legal block. */
export interface SignInBrand extends BrandingTokens {
  companyId: string
  companyName: string
  contactEmail: string | null
  legal: Readonly<Record<Locale, LegalBlock>> | null
}

export type SignInScreen =
  /** Reading whose portal this is. */
  | { kind: 'loading' }
  /** The address names no portal (`none`), or one we do not know (`not-found`). */
  | { kind: 'unknown'; reason: 'none' | 'not-found' }
  | { kind: 'email'; email: string }
  /** `resendAt`: when "Send a new code" opens (epoch ms). */
  | { kind: 'code'; email: string; resendAt: number | null }
  | { kind: 'link-checking' }
  /** `email` null: the link could not be read first (Continue still works). */
  | { kind: 'link'; company: string | null; email: string | null }
  | { kind: 'link-dead' }
  | {
      kind: 'first-visit'
      displayName: string
      /** The person chose no summaries yet: the first visit asks. */
      asksSummaries: boolean
      terms: { state: 'loading' } | { state: 'failed' } | { state: 'ready'; label: string; body: string; locale: string; languageReady: boolean }
    }
  /** Signed in: the portal is opening. */
  | { kind: 'opening' }
  /** The privacy notice in its own tab. */
  | { kind: 'privacy'; notice: { state: 'loading' } | { state: 'failed' } | { state: 'missing' } | { state: 'ready'; label: string; body: string; locale: string; languageReady: boolean } }

export type SignInBanner = { kind: 'ended'; reason: EndedReason } | { kind: 'paused'; problem: AccessProblem; endedOn: string | null }

export type SignInProblem = 'sendFailed' | 'signInFailed' | 'saveFailed' | 'termsChanged' | 'checkFailed'

export interface PortalSignInViewModel {
  /** Whose portal: null while unknown; `brandFailed`: the branding could not be read (the name in text, DS colours). */
  brand: SignInBrand | null
  brandFailed?: boolean
  screen: SignInScreen
  banner?: SignInBanner | null
  problem?: SignInProblem | null
  /** The code step's refusal. */
  code?: CodeProblem | null
  /** The current step's button waits until then (epoch ms): too many requests. */
  waitUntil?: number | null
  /** "Send a new code" waits until then (epoch ms): too many e-mails asked. */
  resendWaitUntil?: number | null
  /** The browser has no network: the steps' buttons are held. */
  offline?: boolean
  busy?: boolean
  /** The page proves it is a person (proof of work, only after suspicious traffic). */
  checking?: boolean
  /** A new code was sent on the code step. */
  resent?: boolean
  resending?: boolean
  /** What the form's own check found (the design cases show it; the live page finds it on submit). */
  fieldErrors?: { email?: 'required' | 'format'; name?: 'required' | 'tooLong'; terms?: 'required' }
  /** Focus the step's first field when it appears (the live page; not the design index's frames). */
  autoFocus?: boolean
}

export type SignInAction =
  | { type: 'send'; email: string }
  | { type: 'code'; code: string }
  | { type: 'resend' }
  | { type: 'other-email' }
  | { type: 'continue' }
  | { type: 'new-link' }
  | { type: 'first-visit'; displayName: string; locale: Locale; summaries: Summaries }
  | { type: 'retry' }
  | { type: 'hide-banner' }

export interface PortalSignInViewProps {
  model: PortalSignInViewModel
  /** The page's flow; absent in the design index (the forms then only check themselves). */
  onAction?: (action: SignInAction) => void
}

const noSubscription = () => () => {}

/**
 * True once the page runs in the browser past hydration (false in the server render and while hydrating): what depends on
 * the clock is drawn only then, so the server's HTML and the browser's first render never differ by the seconds between them.
 */
function useInBrowser(): boolean {
  return useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  )
}

/** The time, ticking each second while something waits (the held button's words count down); null before the browser runs. */
function useNow(waiting: boolean): number | null {
  const browser = useInBrowser()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!waiting) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [waiting])
  return browser ? now : null
}

/** True after about a second: "Still loading…" under a skeleton. */
function useSlow(active: boolean): boolean {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!active) {
      setSlow(false)
      return
    }
    const timer = window.setTimeout(() => setSlow(true), 1000)
    return () => window.clearTimeout(timer)
  }, [active])
  return slow
}

export function PortalSignInView({ model, onAction }: PortalSignInViewProps) {
  const t = useT('portal-signin')
  const locale = useLocale()
  const switchLocale = useLocaleSwitch()
  const brand = model.brand ? checkBranding(model.brand) : null
  const kind = model.screen.kind
  const wide = kind === 'first-visit' || kind === 'privacy'
  const showLanguage = kind !== 'first-visit' && kind !== 'opening'
  const portalName = brand?.name || model.brand?.companyName || null

  return (
    <div className="fw-psi" {...densityAttrs('comfortable')} {...(brand ? brandingAttrs(brand) : {})}>
      <header className="fw-psi-head">
        <BrandMark brand={brand} name={portalName} loading={kind === 'loading' && !model.brand} />
        {showLanguage && (
          <SegmentedControl
            ariaLabel={t('head.language')}
            size="sm"
            value={locale}
            onChange={(value) => isLocale(value) && switchLocale?.(value)}
            options={LOCALES.map((option) => ({ value: option, label: <span lang={option}>{LOCALE_NAMES[option]}</span> }))}
          />
        )}
      </header>

      <main id="main-content" className="fw-psi-main" tabIndex={-1}>
        <div className={`fw-psi-column${wide ? ' wide' : ''}`}>
          {model.banner && <SignInBannerView banner={model.banner} brand={model.brand} onAction={onAction} />}
          <Screen model={model} portalName={portalName} onAction={onAction} />
        </div>
      </main>

      {/* Before sign-in the foot is the way out (by invitation, whom to ask, the notice); after it only the legal block. */}
      <HelpFoot brand={model.brand} help={kind !== 'privacy' && kind !== 'first-visit' && kind !== 'opening'} />
    </div>
  )
}

function BrandMark({ brand, name, loading }: { brand: (BrandingTokens & { name: string }) | null; name: string | null; loading: boolean }) {
  const t = useT('portal-signin')
  if (loading) return <Skeleton width={180} height={28} />
  const split = Boolean(brand?.logoDarkUrl && brand.logoDarkUrl !== brand.logoUrl)
  return (
    <div className="fw-psi-brand">
      {/* The logo is decoration beside the name in text: the theme is the `.dark` class, the dark logo a second image. */}
      {brand?.logoUrl && (
        <>
          <img className={`fw-psi-logo${split ? ' for-light' : ''}`} src={brand.logoUrl} alt="" />
          {split && <img className="fw-psi-logo for-dark" src={brand.logoDarkUrl!} alt="" />}
        </>
      )}
      <span className="fw-psi-brand-name">{name ?? t('head.portal')}</span>
    </div>
  )
}

function SignInBannerView({ banner, brand, onAction }: { banner: SignInBanner; brand: SignInBrand | null; onAction?: (action: SignInAction) => void }) {
  const t = useT('portal-signin')
  const company = brand?.companyName ?? t('head.portal')
  const hide = (
    <Button size="sm" variant="ghost" onClick={() => onAction?.({ type: 'hide-banner' })}>
      {t('ended.hide')}
    </Button>
  )
  // Esc hides a banner the focus is in (the e-mail field then takes the focus back).
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onAction?.({ type: 'hide-banner' })
    }
  }
  if (banner.kind === 'ended') {
    return (
      <div className="fw-psi-banner" onKeyDown={onKeyDown}>
        <Banner tone="info" title={t('ended.title')} action={hide}>
          {t(`ended.${banner.reason}`)}
        </Banner>
      </div>
    )
  }
  const contact = brand?.contactEmail ?? t('paused.contactPerson', { company })
  const words =
    banner.problem === 'ENDED' && !banner.endedOn
      ? t('paused.ENDED_undated', { company, contact })
      : t(`paused.${banner.problem}`, { company, contact, date: banner.endedOn ?? '' })
  const ended = banner.problem === 'ENDED' || banner.problem === 'INVITATION_ENDED'
  return (
    <div className="fw-psi-banner" onKeyDown={onKeyDown}>
      <Banner
        tone="warning"
        title={t(ended ? 'paused.endedTitle' : 'paused.title')}
        action={
          brand?.contactEmail ? (
            <Button size="sm" asChild>
              <a href={`mailto:${brand.contactEmail}`}>{t('paused.write')}</a>
            </Button>
          ) : (
            hide
          )
        }
      >
        {words}
      </Banner>
    </div>
  )
}

function Screen({ model, portalName, onAction }: { model: PortalSignInViewModel; portalName: string | null; onAction?: (action: SignInAction) => void }) {
  const t = useT('portal-signin')
  const ds = useDsLabels()
  const { screen } = model
  const slow = useSlow(screen.kind === 'loading' || screen.kind === 'link-checking')

  switch (screen.kind) {
    case 'loading':
      return (
        <Card padded className="fw-psi-card" aria-busy="true">
          <div className="fw-psi-skeleton">
            <Skeleton width="60%" height={24} />
            <Skeleton width="90%" height={14} />
            <Skeleton height={44} />
            <Skeleton height={44} />
          </div>
          {slow && (
            <p className="fw-psi-slow" role="status">
              {t('head.stillLoading')}
            </p>
          )}
        </Card>
      )
    case 'unknown':
      return (
        <Card padded className="fw-psi-card">
          <EndState tone="info" icon={<MailQuestion aria-hidden />} title={t('unknown.title')} body={t(`unknown.${screen.reason === 'none' ? 'none' : 'notFound'}`)} headingLevel={1} focusOnMount={model.autoFocus ?? false} labels={ds.endState} />
        </Card>
      )
    case 'email':
      return <EmailStep key="email" model={model} screen={screen} portalName={portalName} onAction={onAction} />
    case 'code':
      return <CodeStep key="code" model={model} screen={screen} onAction={onAction} />
    case 'link-checking':
      return (
        <Card padded className="fw-psi-card" aria-busy="true">
          <p className="fw-psi-status" role="status">
            <Spinner size={16} /> {t('link.checking')}
          </p>
          {slow && <p className="fw-psi-slow">{t('head.stillLoading')}</p>}
        </Card>
      )
    case 'link':
      return <LinkStep model={model} screen={screen} portalName={portalName} onAction={onAction} />
    case 'link-dead':
      return (
        <Card padded className="fw-psi-card">
          <EndState
            tone="warning"
            icon={<Link2Off aria-hidden />}
            title={t('link.deadTitle')}
            body={t('link.deadBody')}
            headingLevel={1}
            focusOnMount={model.autoFocus ?? false}
            actions={[{ label: t('link.newLink'), variant: 'primary', onClick: () => onAction?.({ type: 'new-link' }) }]}
            labels={ds.endState}
          />
        </Card>
      )
    case 'first-visit':
      return <FirstVisit key="first" model={model} screen={screen} portalName={portalName} onAction={onAction} />
    case 'opening':
      return (
        <Card padded className="fw-psi-card">
          <p className="fw-psi-status" role="status">
            <Spinner size={16} /> {t('opening')}
          </p>
        </Card>
      )
    case 'privacy':
      return <PrivacyNotice model={model} screen={screen} onAction={onAction} />
  }
}

/** The words of a held step: no network, else a wait (counting down). */
function useHeld(model: PortalSignInViewModel, until: number | null | undefined = model.waitUntil): string | null {
  const t = useT('portal-signin')
  const now = useNow(Boolean(until && until > Date.now()))
  if (model.offline) return t('email.offline')
  if (until && now !== null && until > now) {
    const { unit, count } = waitParts(until - now)
    return t(`wait.${unit}`, { count })
  }
  return null
}

function EmailStep({ model, screen, portalName, onAction }: { model: PortalSignInViewModel; screen: Extract<SignInScreen, { kind: 'email' }>; portalName: string | null; onAction?: (action: SignInAction) => void }) {
  const t = useT('portal-signin')
  const [email, setEmail] = useState(screen.email)
  const [checked, setChecked] = useState<'required' | 'format' | null>(null)
  const [touched, setTouched] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const held = useHeld(model)
  const problem = checked ?? model.fieldErrors?.email ?? null
  useEffect(() => setEmail(screen.email), [screen.email])
  // A hidden banner gives the focus back to the field.
  const hadBanner = useRef(Boolean(model.banner))
  useEffect(() => {
    if (hadBanner.current && !model.banner) input.current?.focus()
    hadBanner.current = Boolean(model.banner)
  }, [model.banner])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const found = emailProblem(email)
    setChecked(found)
    if (found) return input.current?.focus()
    if (held || model.busy || model.checking) return
    onAction?.({ type: 'send', email: email.trim() })
  }

  return (
    <Card padded className="fw-psi-card">
      <form className="fw-psi-form" onSubmit={submit} noValidate>
        <div className="fw-psi-title">
          <h1>{portalName ? t('email.title', { portal: portalName }) : t('email.titleAnonymous')}</h1>
          <p>{t('email.lead')}</p>
        </div>
        {model.problem === 'sendFailed' && <Banner tone="danger">{t('email.failed')}</Banner>}
        {model.problem === 'checkFailed' && <Banner tone="danger">{t('check.failed')}</Banner>}
        <Field label={t('email.label')} hint={t('email.hint')} error={problem ? t(`email.${problem}`) : undefined}>
          <Input
            ref={input}
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            spellCheck={false}
            value={email}
            autoFocus={model.autoFocus && !model.banner}
            onChange={(event) => {
              setEmail(event.currentTarget.value)
              if (checked) setChecked(touched ? emailProblem(event.currentTarget.value) : null)
            }}
            onBlur={() => {
              setTouched(true)
              if (email.trim() !== '') setChecked(emailProblem(email))
            }}
          />
        </Field>
        <div className="fw-psi-actions">
          <Button type="submit" variant="primary" block heldReason={held ?? (model.busy || model.checking ? t('email.sending') : null)}>
            {model.busy || model.checking ? <Spinner size={14} /> : null}
            {model.busy || model.checking ? t('email.sending') : t('email.submit')}
          </Button>
          {held && <p className="fw-psi-held">{held}</p>}
          {model.checking && (
            <p className="fw-psi-status" role="status">
              {t('check.running')}
            </p>
          )}
        </div>
      </form>
    </Card>
  )
}

function CodeStep({ model, screen, onAction }: { model: PortalSignInViewModel; screen: Extract<SignInScreen, { kind: 'code' }>; onAction?: (action: SignInAction) => void }) {
  const t = useT('portal-signin')
  const ds = useDsLabels()
  const [code, setCode] = useState('')
  const held = useHeld(model)
  const resendHeld = useHeld(model, model.resendWaitUntil)
  // "Send a new code" counts down to an instant: drawn in the browser only (its words are the browser's clock).
  const browser = useInBrowser()
  const problem = model.code ?? null
  const fieldHeld = model.offline ? t('code.offline') : problem?.kind === 'triedOut' ? t('code.triedOut') : problem?.kind === 'expired' ? t('code.expired') : held
  const busy = Boolean(model.busy || model.checking)
  const send = (value: string) => {
    if (value.length === 6 && !fieldHeld && !busy) onAction?.({ type: 'code', code: value })
  }
  // A refused code empties the boxes for the next try (the words stay until a digit is typed).
  useEffect(() => {
    if (problem?.kind === 'wrong' || problem?.kind === 'format') setCode('')
  }, [problem])
  // Design: a 6-digit code pasted anywhere on this step fills it; Esc goes back to step 1 (the address kept).
  const current = useRef({ send, onAction })
  current.current = { send, onAction }
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('.nds-code') || target?.matches?.('input, textarea')) return
      const found = codeFromText(event.clipboardData?.getData('text/plain') ?? '', 6)
      if (found.length !== 6) return
      event.preventDefault()
      setCode(found)
      current.current.send(found)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !(event.target as HTMLElement | null)?.closest('.fw-psi-banner')) current.current.onAction?.({ type: 'other-email' })
    }
    document.addEventListener('paste', onPaste)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('paste', onPaste)
      document.removeEventListener('keydown', onKey)
    }
  }, [])

  const signInHeld = fieldHeld ?? (busy ? t('code.checking') : code.length < 6 ? t('code.incomplete') : null)

  return (
    <Card padded className="fw-psi-card">
      <form
        className="fw-psi-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          send(code)
        }}
      >
        <div className="fw-psi-title">
          <h1>{t('code.title')}</h1>
          <p className="fw-psi-sent" role="status">
            {t('code.sent', { email: screen.email })}
          </p>
          <p>{t('code.lead')}</p>
        </div>
        {model.problem === 'signInFailed' && <Banner tone="danger">{t('code.failed')}</Banner>}
        {model.problem === 'checkFailed' && <Banner tone="danger">{t('check.failed')}</Banner>}
        <CodeInput
          value={code}
          onChange={setCode}
          onComplete={send}
          label={t('code.label')}
          hint={t('code.hint')}
          error={problem?.kind === 'wrong' ? t('code.wrong') : problem?.kind === 'format' ? t('code.format') : null}
          triesLeft={problem?.kind === 'wrong' ? problem.triesLeft : null}
          heldReason={fieldHeld}
          busy={busy && !fieldHeld}
          autoFocus={model.autoFocus}
          resend={{ availableAt: browser ? screen.resendAt : null, onResend: () => onAction?.({ type: 'resend' }), busy: model.resending, sent: model.resent, heldReason: resendHeld }}
          labels={ds.codeInput}
          countdownLabels={ds.countdown}
        />
        <div className="fw-psi-actions">
          <Button type="submit" variant="primary" block heldReason={signInHeld}>
            {t('code.submit')}
          </Button>
          {model.checking && (
            <p className="fw-psi-status" role="status">
              {t('check.running')}
            </p>
          )}
          <Button variant="link" onClick={() => onAction?.({ type: 'other-email' })}>
            {t('code.otherEmail')}
          </Button>
        </div>
      </form>
    </Card>
  )
}

function LinkStep({ model, screen, portalName, onAction }: { model: PortalSignInViewModel; screen: Extract<SignInScreen, { kind: 'link' }>; portalName: string | null; onAction?: (action: SignInAction) => void }) {
  const t = useT('portal-signin')
  const held = useHeld(model)
  const busy = Boolean(model.busy || model.checking)
  return (
    <Card padded className="fw-psi-card">
      <form
        className="fw-psi-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (!held && !busy) onAction?.({ type: 'continue' })
        }}
      >
        <div className="fw-psi-title">
          <h1>{t('link.title', { company: screen.company ?? portalName ?? t('head.portal') })}</h1>
          {screen.email && <p>{t('link.as', { company: screen.company ?? portalName ?? t('head.portal'), email: screen.email })}</p>}
        </div>
        {model.problem === 'signInFailed' && <Banner tone="danger">{t('link.failed')}</Banner>}
        {model.problem === 'checkFailed' && <Banner tone="danger">{t('check.failed')}</Banner>}
        <div className="fw-psi-actions">
          {/* Enter presses Continue: the button has the focus when the step appears. */}
          <Button type="submit" variant="primary" block autoFocus={model.autoFocus} heldReason={held ?? (busy ? t('code.checking') : null)}>
            {busy ? <Spinner size={14} /> : null}
            {t('link.continue')}
          </Button>
          {held && <p className="fw-psi-held">{held}</p>}
          {model.checking && (
            <p className="fw-psi-status" role="status">
              {t('check.running')}
            </p>
          )}
        </div>
        <p className="fw-psi-note">{t('link.why')}</p>
      </form>
    </Card>
  )
}

const SUMMARY_WORDS: Record<Summaries, { title: string; hint: string }> = {
  INSTANT: { title: 'first.instant', hint: 'first.instantHint' },
  DAILY: { title: 'first.daily', hint: 'first.dailyHint' },
  WEEKLY: { title: 'first.weekly', hint: 'first.weeklyHint' },
}

function FirstVisit({
  model,
  screen,
  portalName,
  onAction,
}: {
  model: PortalSignInViewModel
  screen: Extract<SignInScreen, { kind: 'first-visit' }>
  portalName: string | null
  onAction?: (action: SignInAction) => void
}) {
  const t = useT('portal-signin')
  const locale = useLocale()
  const switchLocale = useLocaleSwitch()
  const [name, setName] = useState(screen.displayName)
  const [summaries, setSummaries] = useState<Summaries>('DAILY')
  const [accepted, setAccepted] = useState(false)
  const [checked, setChecked] = useState<ReturnType<typeof firstVisitProblems> | null>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const acceptBox = useRef<HTMLInputElement>(null)
  const held = useHeld(model)
  const company = model.brand?.companyName ?? portalName ?? t('head.portal')
  const problems = checked ?? (model.fieldErrors ? { name: model.fieldErrors.name, terms: model.fieldErrors.terms } : {})
  const terms = screen.terms
  // The terms shown changed (another language, a newer version): the yes was for the other text.
  const shownTerms = terms.state === 'ready' ? `${terms.locale}:${terms.label}` : terms.state
  useEffect(() => setAccepted(false), [shownTerms])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const found = firstVisitProblems({ displayName: name, accepted })
    setChecked(found)
    if (found.name) return nameInput.current?.focus()
    if (found.terms) return acceptBox.current?.focus()
    if (held || model.busy || terms.state !== 'ready') return
    onAction?.({ type: 'first-visit', displayName: name.trim(), locale, summaries })
  }

  return (
    <Card padded className="fw-psi-card">
      <form className="fw-psi-form" onSubmit={submit} noValidate>
        <div className="fw-psi-title">
          <h1>{t('first.title', { portal: portalName ?? company })}</h1>
          <p>{t('first.lead')}</p>
        </div>
        {model.problem === 'saveFailed' && <Banner tone="danger">{t('first.failed')}</Banner>}
        {model.problem === 'termsChanged' && <Banner tone="warning">{t('first.termsChanged')}</Banner>}
        <div className="fw-psi-grid">
          <Field label={t('first.name')} hint={t('first.nameHint', { company })} error={problems.name ? t(problems.name === 'required' ? 'first.nameRequired' : 'first.nameTooLong') : undefined}>
            <Input ref={nameInput} name="name" autoComplete="name" maxLength={160} value={name} autoFocus={model.autoFocus} onChange={(event) => setName(event.currentTarget.value)} />
          </Field>
          <div className="fw-psi-field">
            <span className="fw-psi-label" id="fw-psi-language">
              {t('first.language')}
            </span>
            <SegmentedControl
              ariaLabel={t('first.language')}
              value={locale}
              onChange={(value) => isLocale(value) && switchLocale?.(value)}
              options={LOCALES.map((option) => ({ value: option, label: <span lang={option}>{LOCALE_NAMES[option]}</span> }))}
            />
            <span className="fw-psi-hint">{t('first.languageHint')}</span>
          </div>
        </div>

        {screen.asksSummaries && (
          <fieldset className="fw-psi-fieldset">
            <legend className="fw-psi-label">{t('first.summaries')}</legend>
            <p className="fw-psi-hint">{t('first.summariesHint')}</p>
            <div className="fw-psi-choices">
              {SUMMARIES.map((value) => (
                <RadioCard
                  key={value}
                  name="summaries"
                  value={value}
                  checked={summaries === value}
                  selected={summaries === value}
                  onChange={() => setSummaries(value)}
                  title={t(SUMMARY_WORDS[value].title)}
                  description={t(SUMMARY_WORDS[value].hint)}
                />
              ))}
            </div>
          </fieldset>
        )}

        <section className="fw-psi-terms" aria-labelledby="fw-psi-terms-title">
          <div className="fw-psi-terms-head">
            <h2 id="fw-psi-terms-title">{t('first.terms')}</h2>
            {terms.state === 'ready' && <span className="fw-psi-hint">{t('first.termsVersion', { label: terms.label })}</span>}
          </div>
          {terms.state === 'loading' && (
            <p className="fw-psi-status" role="status">
              <Spinner size={14} /> {t('first.termsLoading')}
            </p>
          )}
          {terms.state === 'failed' && (
            <Banner
              tone="danger"
              action={
                <Button size="sm" onClick={() => onAction?.({ type: 'retry' })}>
                  {t('first.termsRetry')}
                </Button>
              }
            >
              {t('first.termsFailed')}
            </Banner>
          )}
          {terms.state === 'ready' && (
            <>
              {!terms.languageReady && <p className="fw-psi-hint">{t('first.termsLanguage', { language: t(`language.${terms.locale === 'en' ? 'en' : 'it'}`) })}</p>}
              {/* The text the yes is for (its SHA-256 goes back with it); a box of its own that scrolls by keyboard too. */}
              <div className="fw-psi-terms-text" tabIndex={0} role="region" aria-labelledby="fw-psi-terms-title" lang={terms.locale}>
                {terms.body}
              </div>
              <Checkbox
                ref={acceptBox}
                checked={accepted}
                onChange={(event) => setAccepted(event.currentTarget.checked)}
                label={t('first.accept', { company })}
                aria-invalid={problems.terms ? true : undefined}
                aria-describedby={problems.terms ? 'fw-psi-terms-error' : undefined}
              />
              {problems.terms && (
                <p className="fw-psi-error" id="fw-psi-terms-error">
                  {t('first.acceptRequired')}
                </p>
              )}
            </>
          )}
          {model.brand && (
            <p className="fw-psi-note">
              <a href={privacyHref(model.brand.companyId)} target="_blank" rel="noopener noreferrer">
                {t('first.privacy', { company })}
              </a>{' '}
              <span className="fw-psi-hint">({t('first.newTab')})</span>
            </p>
          )}
        </section>

        <div className="fw-psi-actions">
          <Button type="submit" variant="primary" block heldReason={held ?? (model.busy ? t('first.saving') : terms.state !== 'ready' ? t('first.termsLoading') : null)}>
            {model.busy ? <Spinner size={14} /> : null}
            {model.busy ? t('first.saving') : t('first.submit')}
          </Button>
          {held && <p className="fw-psi-held">{held}</p>}
        </div>
      </form>
    </Card>
  )
}

function PrivacyNotice({ model, screen, onAction }: { model: PortalSignInViewModel; screen: Extract<SignInScreen, { kind: 'privacy' }>; onAction?: (action: SignInAction) => void }) {
  const t = useT('portal-signin')
  const company = model.brand?.companyName ?? null
  const { notice } = screen
  const slow = useSlow(notice.state === 'loading')
  return (
    <Card padded className="fw-psi-card">
      <div className="fw-psi-form">
        <div className="fw-psi-title">
          <h1>{company ? t('privacy.title', { company }) : t('privacy.titleAnonymous')}</h1>
          {notice.state === 'ready' && <p>{notice.label}</p>}
        </div>
        {notice.state === 'loading' && (
          <div className="fw-psi-skeleton" aria-busy="true">
            <Skeleton width="80%" height={14} />
            <Skeleton width="95%" height={14} />
            <Skeleton width="70%" height={14} />
            {slow && (
              <p className="fw-psi-slow" role="status">
                {t('head.stillLoading')}
              </p>
            )}
          </div>
        )}
        {notice.state === 'failed' && (
          <Banner
            tone="danger"
            action={
              <Button size="sm" onClick={() => onAction?.({ type: 'retry' })}>
                {t('privacy.retry')}
              </Button>
            }
          >
            {t('privacy.failed')}
          </Banner>
        )}
        {notice.state === 'missing' && <p>{company ? t('privacy.missing', { company }) : t('privacy.missingAnonymous')}</p>}
        {notice.state === 'ready' && (
          <>
            {!notice.languageReady && <p className="fw-psi-hint">{t('privacy.language', { language: t(`language.${notice.locale === 'en' ? 'en' : 'it'}`) })}</p>}
            <div className="fw-psi-notice" lang={notice.locale}>
              {notice.body}
            </div>
          </>
        )}
        <p className="fw-psi-note">{t('privacy.close')}</p>
      </div>
    </Card>
  )
}

/** The company's privacy notice, opened beside the sign-in (the code step stays open in its tab). */
const privacyHref = (companyId: string): string => `/p/signin/privacy?company=${encodeURIComponent(companyId)}`

function HelpFoot({ brand, help }: { brand: SignInBrand | null; help: boolean }): ReactNode {
  const t = useT('portal-signin')
  const locale = useLocale()
  const legal = brand?.legal?.[locale] ?? null
  return (
    <footer className="fw-psi-foot">
      {help && (
        <p className="fw-psi-invite">
          {brand ? (brand.contactEmail ? t('foot.invite', { company: brand.companyName }) : t('foot.inviteNoContact', { company: brand.companyName })) : t('foot.inviteAnonymous')}
          {brand?.contactEmail && (
            <>
              {' '}
              <a href={`mailto:${brand.contactEmail}`}>{brand.contactEmail}</a>
            </>
          )}
        </p>
      )}
      {brand && help && (
        <p>
          <a href={privacyHref(brand.companyId)} target="_blank" rel="noopener noreferrer">
            {t('foot.privacy', { company: brand.companyName })}
          </a>{' '}
          <span className="fw-psi-hint">({t('foot.newTab')})</span>
        </p>
      )}
      {legal && (
        <section className="fw-psi-legal" aria-label={t('foot.legal')}>
          <p className="fw-psi-legal-name">{legal.name}</p>
          {legal.lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </section>
      )}
    </footer>
  )
}
