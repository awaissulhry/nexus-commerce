'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ServerCrash } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import type { OfficeMe } from '../../lib/api/office'
import { writeCookie } from '../../lib/cookies'
import { LOCALE_COOKIE, type Locale } from '../../lib/i18n/locales'
import { useT } from '../../lib/i18n/provider'
import { useOfficeApi } from '../../lib/session/context'
import { useTheme } from '../../lib/theme/use-theme'
import { changePassword, confirmTotp, disableTotp, setLocale, signOutHere, startTotpSetup } from './me-api'
import { authenticatorAtRest, profileModel, type AuthenticatorCard, type MeProblem, type MyProfileViewModel, type PasswordCard } from './me-model'
import { MyProfileView, type MeAction } from './view/MyProfileView'

/**
 * The live SCR-007: the person from `GET /auth/office/me` (loaded by the page), drawn by `MyProfileView`. The cards
 * rest on what the API says; a flow (a form open, the set-up, the codes shown once) is this component's own state.
 * After a change the API keeps (language, two-factor), the server's pages load again (`router.refresh()`), so the
 * office speaks the new language and, once two-factor is on, shows the areas the person's roles open.
 */
export function MyProfile({ me, failure }: { me: OfficeMe | null; failure?: string }) {
  return me ? <Profile me={me} /> : <ProfileUnavailable code={failure ?? 'internal'} />
}

function Profile({ me }: { me: OfficeMe }) {
  const router = useRouter()
  const api = useOfficeApi()
  const { mode, setTheme } = useTheme()
  const [language, setLanguage] = useState<{ busy?: boolean; problem?: MeProblem; pending?: Locale }>({})
  const [password, setPassword] = useState<PasswordCard>({ state: 'closed' })
  const [authenticator, setAuthenticator] = useState<AuthenticatorCard | null>(null)
  const [signOut, setSignOut] = useState<MyProfileViewModel['signOut']>()

  // The new language is the page's once the server's pages came back in it.
  useEffect(() => {
    if (language.pending && me.user.locale === language.pending) setLanguage({})
  }, [me.user.locale, language.pending])

  const base = profileModel(me, mode)
  const model: MyProfileViewModel = {
    ...base,
    locale: language.pending ?? base.locale,
    language: { busy: language.busy, problem: language.problem },
    password,
    authenticator: authenticator ?? authenticatorAtRest(me.mfa),
    signOut,
    autoFocus: true,
  }
  const required = me.mfa.required

  const onAction = async (action: MeAction) => {
    switch (action.type) {
      case 'locale': {
        setLanguage({ busy: true, pending: action.locale })
        const answer = await setLocale(api, action.locale)
        if (!answer.ok) return setLanguage({ problem: answer.problem })
        writeCookie(LOCALE_COOKIE, action.locale)
        return router.refresh()
      }
      case 'theme':
        return setTheme(action.mode)
      case 'password-open':
        return setPassword({ state: 'open' })
      case 'password-cancel':
        return setPassword({ state: 'closed' })
      case 'password': {
        setPassword({ state: 'open', busy: true })
        const answer = await changePassword(api, action)
        return setPassword(answer.ok ? { state: 'closed', done: { sessionsEnded: answer.value.sessionsEnded } } : { state: 'open', problem: answer.problem })
      }
      case 'totp-setup': {
        setAuthenticator({ state: 'off', required, busy: true })
        const answer = await startTotpSetup(api)
        return setAuthenticator(answer.ok ? { state: 'setup', ...answer.value } : { state: 'off', required, problem: answer.problem })
      }
      case 'totp-cancel':
        return setAuthenticator(null)
      case 'totp-confirm': {
        const setup = model.authenticator
        if (setup.state !== 'setup') return
        setAuthenticator({ ...setup, busy: true, problem: null })
        const answer = await confirmTotp(api, action.code)
        if (!answer.ok) return setAuthenticator({ ...setup, busy: false, problem: answer.problem })
        setAuthenticator({ state: 'codes', recoveryCodes: answer.value.recoveryCodes })
        // Two-factor is proved on this session now: the office's areas appear.
        return router.refresh()
      }
      case 'codes-saved': {
        const shown = model.authenticator
        return setAuthenticator({ state: 'on', required, recoveryCodesLeft: shown.state === 'codes' ? shown.recoveryCodes.length : me.mfa.recoveryCodesLeft, turnedOn: true })
      }
      case 'totp-disable-open':
        return setAuthenticator({ state: 'disable' })
      case 'totp-disable': {
        setAuthenticator({ state: 'disable', busy: true })
        const answer = await disableTotp(api, action.password)
        if (!answer.ok) return setAuthenticator({ state: 'disable', problem: answer.problem })
        setAuthenticator({ state: 'off', required, turnedOff: true })
        return router.refresh()
      }
      case 'sign-out': {
        setSignOut({ busy: true })
        const answer = await signOutHere(api)
        // As the top bar's sign-out: the sign-in page (lib/session/server SIGN_IN_PATH, a server-only module).
        if (answer.ok || answer.problem === 'signedOut') return router.replace('/sign-in')
        return setSignOut({ problem: answer.problem })
      }
    }
  }

  return <MyProfileView model={model} onAction={(action) => void onAction(action)} />
}

/** The person could not be read (the API went away between the office's check and this page). */
function ProfileUnavailable({ code }: { code: string }) {
  const t = useT('shell')
  const router = useRouter()
  return (
    <EmptyState
      icon={<ServerCrash size={28} aria-hidden />}
      title={t('unavailable.api.title')}
      description={t('unavailable.api.body', { code })}
      action={<Button onClick={() => router.refresh()}>{t('unavailable.api.action')}</Button>}
    />
  )
}
