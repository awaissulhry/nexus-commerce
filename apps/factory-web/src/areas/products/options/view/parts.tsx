'use client'

import { Banner } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { Notice } from '../../library/model'

/**
 * The parts the list and the record of Options & rules share (B-W2b-242), from design-system parts only; nothing here
 * fetches.
 */

/** What the last action did: this page's words, or a problem in the libraries' words (`problem.*`); Dismiss. */
export function ResultBanner({ notice, onDismiss }: { notice: Notice | null; onDismiss?: () => void }) {
  const t = useT('products-options')
  const tl = useT('library')
  if (!notice) return null
  const words = notice.key.startsWith('problem.') ? tl(notice.key, notice.params) : t(notice.key, notice.params)
  return (
    <Banner
      tone={notice.tone}
      title={words}
      action={
        onDismiss ? (
          <Button size="sm" variant="quiet" onClick={onDismiss}>
            {tl('common.dismiss')}
          </Button>
        ) : undefined
      }
    />
  )
}

/** The API's words ({ it, en }) in the page's language. */
export function useSay(): (words: { it: string; en: string } | null | undefined) => string {
  const locale = useLocale()
  return (words) => (words ? (locale === 'it' ? words.it : words.en) : '')
}
