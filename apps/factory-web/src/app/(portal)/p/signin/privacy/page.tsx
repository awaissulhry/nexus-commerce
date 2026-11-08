import type { Metadata } from 'next'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { requestLocale } from '../../../../../lib/i18n/server'
import { PortalSignIn } from '../../../../../portal/signin/PortalSignIn'

type Search = Promise<Record<string, string | string[] | undefined>>

export async function generateMetadata(): Promise<Metadata> {
  const locale = await requestLocale()
  return { title: createTranslator(locale, messagesFor(locale, ['portal-signin'])['portal-signin'] ?? {})('meta.privacyTitle') }
}

/**
 * `/p/signin/privacy?company=<company id>` — the company's privacy notice (GDPR arts. 13, 14), opened from the sign-in in a
 * new tab so the code step stays open (design portal.signin › privacy notice).
 */
export default async function PortalSignInPrivacyPage({ searchParams }: { searchParams: Search }) {
  const company = (await searchParams).company
  const companyId = typeof company === 'string' && /^[0-9a-fA-F-]{36}$/.test(company) ? company.toLowerCase() : null
  return <PortalSignIn start={{ kind: 'privacy', companyId }} />
}
