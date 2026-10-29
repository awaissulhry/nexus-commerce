'use client'

import { Banner } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../lib/i18n/provider'
import type { BulkNotice } from './bulk-model'
import type { AdminPageNamespace } from './messages'
import './list.css'

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

/**
 * One notice (a receipt or a refusal) of a B-W0-28 page, in the page's words, with a way to put it away. After a bulk
 * action it lists each refused row by name (`nameOf`) with its problem in words.
 */
export function PageNotice({ namespace, notice, onDismiss, nameOf }: { namespace: AdminPageNamespace; notice: BulkNotice | null | undefined; onDismiss?: () => void; nameOf?: (id: string) => string }) {
  const words = useWords(namespace)
  const t = useT('admin')
  if (!notice) return null
  const refused = notice.refusedIds ?? []
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
    >
      {refused.length > 0 && (
        <ul className="fw-adm-bulk-refused">
          {refused.map((entry) => (
            <li key={entry.id}>
              {nameOf?.(entry.id) ?? entry.id}: {words(entry.problem)}
            </li>
          ))}
        </ul>
      )}
    </Banner>
  )
}
