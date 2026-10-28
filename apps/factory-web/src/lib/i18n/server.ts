import { cookies, headers } from 'next/headers'
import { LOCALE_COOKIE, pickLocale, type Locale } from './locales'

/** The request's language before anyone is known: the language cookie, else Accept-Language, else Italian. */
export async function requestLocale(person?: string | null): Promise<Locale> {
  const [jar, list] = await Promise.all([cookies(), headers()])
  return pickLocale({ person, cookie: jar.get(LOCALE_COOKIE)?.value, acceptLanguage: list.get('accept-language') })
}
