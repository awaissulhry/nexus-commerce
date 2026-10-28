'use client'

import type { ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { writeCookie } from '../cookies'
import { LOCALE_COOKIE } from './locales'
import { LocaleSwitchProvider } from './provider'

/** The live app's language change: remember it in the language cookie, then render the server's text again. */
export function LocaleSwitchHost({ children }: { children?: ReactNode }) {
  const router = useRouter()
  return (
    <LocaleSwitchProvider
      onChange={(locale) => {
        writeCookie(LOCALE_COOKIE, locale)
        document.documentElement.lang = locale
        router.refresh()
      }}
    >
      {children}
    </LocaleSwitchProvider>
  )
}
