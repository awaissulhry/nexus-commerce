'use client'

import type { ReactNode } from 'react'
import { WithMessages } from '../../../record-panels/i18n'

/**
 * The words of a B-W0-28 Admin page (Documents & numbering, Languages & formats, Connections & API, Import & export,
 * Audit log): the shared Admin text (`admin`: common words, list states, problems, the step-up dialog), the record
 * panels' (`records`), and the page's own catalogue (`messages/<locale>/admin-<page>.json`). Each page's keys start with
 * its own prefix (docs, langs, conn, mail, imp, audit), never one of the part-1 prefixes of `admin`.
 */
export function AdminPageMessages({ namespace, children }: { namespace: AdminPageNamespace; children?: ReactNode }) {
  return <WithMessages namespaces={['admin', 'records', namespace]}>{children}</WithMessages>
}

export const ADMIN_PAGE_NAMESPACES = ['admin-documents', 'admin-languages', 'admin-connections', 'admin-import', 'admin-audit'] as const
export type AdminPageNamespace = (typeof ADMIN_PAGE_NAMESPACES)[number]
