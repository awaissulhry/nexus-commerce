import { notFound, redirect } from 'next/navigation'
import { serverApi } from '../../../lib/api/server'
import { pickLocale } from '../../../lib/i18n/locales'
import { messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { loadOfficeSession, SIGN_IN_PATH } from '../../../lib/session/server'
import { readMailbox } from './api'
import { LocalMailbox } from './LocalMailbox'
import type { LocalMailboxModel } from './model'

/**
 * `/w/<company>/me/mailbox` — Local mailbox (SCR-007-mailbox; B-W2b-F58), from the person menu on the Owner's local test
 * server. The API keeps the mailbox only on FACTORY_ENV=local; anywhere else it has no such route, and this page is a 404.
 */
export async function MailboxPage({ params }: { params: Promise<{ company: string }> }) {
  const code = decodeURIComponent((await params).company)
  const read = await readMailbox(await serverApi({ company: code }))
  if (read.kind === 'absent') notFound()
  if (read.kind === 'signed_out') redirect(SIGN_IN_PATH)
  const load = await loadOfficeSession(code)
  const locale = pickLocale({ person: load.kind === 'signed_in' ? load.session.user.locale : undefined })
  const model: LocalMailboxModel = read.kind === 'ok' ? { state: 'ok', messages: read.messages } : { state: 'failed', code: read.code }
  return (
    <I18nProvider locale={locale} messages={messagesFor(locale, ['me'])}>
      <LocalMailbox model={model} />
    </I18nProvider>
  )
}
