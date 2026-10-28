import { redirect } from 'next/navigation'
import { isApiError } from '../../lib/api/errors'
import { fetchOfficeMe, type OfficeMe } from '../../lib/api/office'
import { serverApi } from '../../lib/api/server'
import { pickLocale } from '../../lib/i18n/locales'
import { messagesFor } from '../../lib/i18n/messages'
import { I18nProvider } from '../../lib/i18n/provider'
import { SIGN_IN_PATH } from '../../lib/session/server'
import { MyProfile } from './MyProfile'

/**
 * `/w/<company>/me` — my profile & security (SCR-007), from the person's menu in the top bar. The office layout has
 * checked the session; this page reads the person in full (`GET /auth/office/me`: the two-factor state, the recovery
 * codes left, this session's times), in the person's language with the page's own text (`me`).
 */
export async function MePage({ params }: { params: Promise<{ company: string }> }) {
  const { company } = await params
  let me: OfficeMe | null = null
  let failure: string | undefined
  try {
    me = await fetchOfficeMe(await serverApi({ company: decodeURIComponent(company) }))
  } catch (error) {
    if (!isApiError(error)) throw error
    if (error.kind === 'signed_out') redirect(SIGN_IN_PATH)
    failure = error.code
  }
  const locale = pickLocale({ person: me?.user.locale })
  return (
    <I18nProvider locale={locale} messages={messagesFor(locale, ['me'])}>
      <MyProfile me={me} failure={failure} />
    </I18nProvider>
  )
}
