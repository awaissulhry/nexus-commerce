'use client'

import { createContext, useContext, type ReactNode } from 'react'
import type { ColDef } from '@nexus/ui/grid'
import { NO_SCOPE, siteNameOf, type OfficeScope } from './scope-model'

/**
 * B-W2b-05 (PLT-008): the Office shell gives every page the top bar's company and site (`useOfficeScope`). A page that
 * reads the site puts `scope.siteId` in its reads (their effect's dependencies), so a switch in the top bar reads the
 * page again in place; the list frame's saved views keep their keys (the site is never part of a view's key).
 */

export interface OfficeScopeValue extends OfficeScope {
  /** Choose a site (null = all sites); remembered for this person. */
  setSite: (site: string | null) => void
}

const NONE: OfficeScopeValue = { ...NO_SCOPE, setSite: () => undefined }
const ScopeContext = createContext<OfficeScopeValue>(NONE)

export function OfficeScopeProvider({ value, children }: { value: OfficeScopeValue; children?: ReactNode }) {
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>
}

/** The company and site this page works in (outside the Office shell: no company, no site). */
export function useOfficeScope(): OfficeScopeValue {
  return useContext(ScopeContext)
}

/**
 * The list's Site column while "All sites" is chosen (design: "'All sites' adds a Site column and chip on lists"), else
 * null. `siteOf` reads a row's site id; the header is the page's words ("Site from the top bar" is said by the chip).
 */
export function siteColumn<T>(scope: OfficeScope, siteOf: (row: T) => string | null | undefined, headerName: string): ColDef<T> | null {
  if (!scope.allSites) return null
  return {
    colId: 'scope.site',
    headerName,
    valueGetter: (params) => (params.data ? (siteNameOf(scope, siteOf(params.data)) ?? '') : ''),
    minWidth: 120,
    flex: 0,
  }
}
