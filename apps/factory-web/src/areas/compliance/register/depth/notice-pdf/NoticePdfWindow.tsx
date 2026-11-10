'use client'

import { useCallback, useEffect, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale } from '../../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { failedRead, problemKey, ready, reading, type Read } from '../../../../quality/_shared/model'
import { getNotice, noticePdfBytes, type AuthorityNotice } from '../api'
import { pickLanguage, readerChain } from '../model'
import { NoticePdfView } from './view/NoticePdfView'

/**
 * `/w/<company>/compliance/register/notice?notice=<id>&language=<code>` (SCR-329, a window page: WINDOW_PAGES; design
 * tab:rg-notice-pdf): reads the notice (compliance.register.view), then its PDF in the language asked — a plain link
 * cannot send the company header, so the page reads the bytes (`GET /compliance/authority-notices/:id/pdf?language=`, made
 * on the fly, never stored) into the viewer. A language chosen here stays in the address.
 */
export function NoticePdfWindow() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const locale = useLocale()
  const noticeId = params?.get('notice') ?? ''
  const asked = params?.get('language') ?? null
  const allowed = session.permissions.includes('compliance.register.view')
  const [notice, setNotice] = useState<Read<AuthorityNotice>>(reading())
  const [pdf, setPdf] = useState<Read<Uint8Array> | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!allowed || !noticeId) {
      if (!noticeId) setNotice(failedRead('problem.notFound'))
      return
    }
    const controller = new AbortController()
    setNotice(reading())
    getNotice(api, noticeId, controller.signal)
      .then((read) => setNotice(ready(read)))
      .catch((error: unknown) => !controller.signal.aborted && setNotice(failedRead(problemKey(error))))
    return () => controller.abort()
  }, [api, allowed, noticeId, attempt])

  const value = notice.value
  const languages = value ? Object.keys(value.words) : []
  const language = asked && languages.includes(asked) ? asked : pickLanguage(languages, readerChain(locale))
  useEffect(() => {
    if (!value) return
    const controller = new AbortController()
    setPdf(reading())
    noticePdfBytes(api, value.id, language, controller.signal)
      .then((bytes) => setPdf(ready(bytes)))
      .catch((error: unknown) => !controller.signal.aborted && setPdf(failedRead(problemKey(error))))
    return () => controller.abort()
  }, [api, value, language, attempt])

  const onLanguage = useCallback(
    (next: string) => {
      const search = new URLSearchParams(params?.toString() ?? '')
      search.set('language', next)
      router.replace(`${pathname}?${search.toString()}`, { scroll: false })
    },
    [params, pathname, router],
  )

  return <NoticePdfView model={{ allowed, notice, language, pdf }} actions={{ onLanguage, onRetry: () => setAttempt((n) => n + 1) }} />
}
