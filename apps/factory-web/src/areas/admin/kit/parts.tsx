'use client'

import { Banner } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../lib/i18n/provider'
import type { Notice } from '../shared/model'
import type { AdminPageNamespace } from './messages'

/**
 * Words of a B-W0-28 page that may come from two catalogues: the page's own keys (`docs.…`, `langs.…`) from its
 * namespace, and the shared Admin keys (`problem.…`, `stepUp.…`, `common.…`) from `admin`. Never shows a key.
 */
export function useWords(namespace: AdminPageNamespace) {
  const own = useT(namespace)
  const admin = useT('admin')
  return (key: string, params?: Readonly<Record<string, string | number>>) => {
    const text = own(key, params)
    return text === key ? admin(key, params) : text
  }
}

/** One notice (a receipt or a refusal) of a B-W0-28 page, in the page's words, with a way to put it away. */
export function PageNotice({ namespace, notice, onDismiss }: { namespace: AdminPageNamespace; notice: Notice | null | undefined; onDismiss?: () => void }) {
  const words = useWords(namespace)
  const t = useT('admin')
  if (!notice) return null
  return (
    <Banner
      tone={notice.tone}
      title={words(notice.key, notice.params)}
      action={
        onDismiss ? (
          <Button size="sm" variant="quiet" onClick={onDismiss}>
            {t('common.dismiss')}
          </Button>
        ) : undefined
      }
    />
  )
}
