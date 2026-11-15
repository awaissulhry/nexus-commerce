'use client'

import { useCallback } from 'react'
import { useT } from '../../../../../lib/i18n/provider'

/**
 * The templates' words (B-W2b-432): a key of `admin-templates` (`tpl.…`), else the shared Admin one (`problem.…`: a read or
 * write that failed for a reason every Admin page says the same way). Never shows a key.
 */
export function useTplWords() {
  const own = useT('admin-templates')
  const admin = useT('admin')
  return useCallback(
    (key: string, params?: Readonly<Record<string, string | number>>) => {
      const text = own(key, params)
      return text === key ? admin(key, params) : text
    },
    [own, admin],
  )
}
