'use client'

import { useEffect, useMemo } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale } from '../../../../lib/i18n/provider'
import { useT } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { depthCan, depthFiltersOf, depthSearch, NO_DEPTH_FILTERS, type DepthFilters, type Library } from './model'
import { useLibraryImport } from './use-library-import'
import { usePoms } from './use-poms'
import { useRules } from './use-rules'
import { SizesDepthView } from './view/SizesDepthView'

/**
 * `/w/<company>/products/sizes?view=poms|rules` (B-W2b-240, SCR-345): Points of measure or Grade rules — the address
 * keeps the view, its filters (`?status=&q=&kind=&scale=`), the open rule (`?open=<id>`) and New (`?new=1`). The size
 * scales (no `view`, or `?view=open|archived|all`) stay SizesPage's own container.
 */
// B-W2b-362: the templates view has its own container (../templates/TemplatesList.tsx).
export function SizesDepth({ library }: { library: Exclude<Library, 'scales' | 'templates'> }) {
  return (
    <WithMessages namespaces={['products-sizes-depth']}>
      <Container library={library} />
    </WithMessages>
  )
}

function Container({ library }: { library: Exclude<Library, 'scales' | /* B-W2b-362 */ 'templates'> }) {
  const t = useT('products-sizes-depth')
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const locale = useLocale()
  const filters = useMemo(() => depthFiltersOf(params), [params])
  const can = useMemo(() => depthCan(session.permissions), [session.permissions])
  const prefix = pathname.replace(/\/products\/sizes\/?$/, '')
  const companyId = session.company?.id ?? null
  const companies = useMemo(() => session.companies.map((company) => ({ id: company.id, name: company.name })), [session.companies])
  const openParam = params?.get('open') || null
  const openId = library === 'rules' ? openParam : null
  const askedNew = params?.get('new') === '1'

  const go = (next: Library, nextFilters: DepthFilters, extra: { open?: string | null; new?: boolean } = {}, push = false) => {
    const href = `${pathname}${depthSearch(next, nextFilters, extra)}`
    if (push) router.push(href)
    else router.replace(href)
  }

  const poms = usePoms({
    api,
    filters,
    enabled: library === 'poms',
    can,
    companyId,
    locale,
    words: {
      csvHeader: ['code', 'name', 'kind', 'zone', 'unit', 'tolerance', 'body', 'howTo', 'status'].map((key) => t(`poms.csv.${key}`)),
      kind: (kind) => t(`kind.${kind}`),
      status: (status) => t(`status.${status}`),
    },
  })
  const rules = useRules({
    api,
    filters,
    enabled: library === 'rules',
    openId,
    onOpen: (id) => go('rules', filters, { open: id }, id !== null),
    words: {
      csvHeader: ['code', 'name', 'scale', 'base', 'points', 'steps', 'format', 'specs', 'status'].map((key) => t(`rules.csv.${key}`)),
      format: (format) => t(`format.${format}`),
      status: (status) => t(`status.${status}`),
    },
  })
  const imports = useLibraryImport({ api, permissions: session.permissions, companyId, companies, locale, onApplied: () => (library === 'poms' ? poms.actions.onRetry?.() : rules.actions.onRetry?.()) })

  // `?new=1` (the scale's Grade rules tab, a link) opens New point / New grade rule once; closing it leaves the address.
  useEffect(() => {
    if (!askedNew || !can.manage) return
    if (library === 'poms') poms.actions.onDialog?.({ kind: 'new' })
    else rules.actions.onDialog?.({ kind: 'new' })
  }, [askedNew, library, can.manage])
  // `?open=<id>` on Points of measure (a record link, the search) opens the point's dialog.
  useEffect(() => {
    if (library === 'poms' && openParam) poms.actions.onDialog?.({ kind: 'edit', id: openParam })
  }, [library, openParam])
  const closeNew = () => {
    if (askedNew || (library === 'poms' && openParam)) go(library, filters, { open: openId })
  }

  return (
    <>
      <SizesDepthView
        model={{
          switch: { library, importHeld: imports.held },
          poms: library === 'poms' ? { ...poms.model, prefix, can, filters, companies } : undefined,
          rules: library === 'rules' ? { ...rules.model, prefix, can, filters, companies, companyId } : undefined,
        }}
        actions={{
          switch: {
            onLibrary: (next) => go(next, NO_DEPTH_FILTERS, {}, true),
            onImport: imports.open,
          },
          poms: {
            ...poms.actions,
            onFilters: (next) => go('poms', next),
            onDialog: (next) => {
              if (next === null) closeNew()
              poms.actions.onDialog?.(next)
            },
          },
          rules: {
            ...rules.actions,
            onFilters: (next) => go('rules', next, { open: openId }),
            onDialog: (next) => {
              if (next === null) closeNew()
              rules.actions.onDialog?.(next)
            },
          },
        }}
      />
      {imports.dialog}
    </>
  )
}
