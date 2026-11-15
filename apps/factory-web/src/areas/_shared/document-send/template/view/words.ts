'use client'

import { useCallback } from 'react'
import { useT } from '../../../../../lib/i18n/provider'

/** The catalogues the send panel's language and template parts speak (theirs, then the send dialog's own). */
export const SEND_TEMPLATE_NAMESPACES = ['admin-templates', 'send'] as const

/** A key of `admin-templates` (`tpl.…`, B-W2b-432), else of the send dialog's `send`. Never shows a key. */
export function useSendWords() {
  const own = useT('admin-templates')
  const send = useT('send')
  return useCallback(
    (key: string, params?: Readonly<Record<string, string | number>>) => {
      const text = own(key, params)
      return text === key ? send(key, params) : text
    },
    [own, send],
  )
}
