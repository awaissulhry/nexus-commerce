'use client'

import { useEffect, useMemo, useRef } from 'react'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { EVERY_COMPANY, useSheetImport } from '../../../products/styles/import/sheet-import'
import { DEPTH_NS } from '../depth/model'
import { PriceListImportView } from './view/PriceListImportView'

/** Why Import prices is held (a `sales-prices-depth` key), or null: price list work and an import's rights. */
export function importHeldOf(permissions: readonly string[]): string | null {
  const held = new Set(permissions)
  if (!held.has('pricelists.manage')) return 'import.held.manage'
  if (!held.has('money.price')) return 'import.held.price'
  if (!held.has('imports.run') || !held.has('files.upload')) return 'import.held.run'
  return null
}

export interface PriceListImportProps {
  /** The rows' company: the list's (null: a list of every company), or the page's company on the list page. */
  companyId: string | null
  /** Open the wizard at once (the record's ⋯ "Import prices"); `onClose` when it closes. */
  open?: boolean
  onClose?: () => void
  /** The band's button (the list page): held with its reason, it opens the wizard. */
  button?: boolean
  /** After a job applied something (the screen reads its prices again). */
  onApplied?: () => void
}

/**
 * The container of Import prices (B-W2b-343; design sales.pricelists pop:pricelists.import "ImportFlow: preview of changes
 * per row", band "Import (W2b)"): one import job on B-W2b-325's importer `sales.priceLists` (keyed by list code, style,
 * colourway and first day; the rows go into each list's DRAFT) through the shared sheet import (upload → the dry run,
 * nothing written → apply what was seen → the result). The job's company is the list's (a list of every company: every
 * company). Running it needs pricelists.manage, the price grain and imports.run + files.upload; applying it imports.apply.
 */
export function PriceListImport(props: PriceListImportProps) {
  return (
    <WithMessages namespaces={[DEPTH_NS, 'admin-import', 'admin']}>
      <ImportContainer {...props} />
    </WithMessages>
  )
}

function ImportContainer({ companyId, open: openNow, onClose, button, onApplied }: PriceListImportProps) {
  const t = useT(DEPTH_NS)
  const locale = useLocale()
  const api = useOfficeApi()
  const session = useOfficeSession()
  const held = useMemo(() => new Set(session.permissions), [session.permissions])
  const rights = useMemo(() => ({ view: held.has('imports.view'), run: held.has('imports.run') && held.has('files.upload'), apply: held.has('imports.apply'), people: false }), [held])
  const companies = useMemo(() => session.companies.map((company) => ({ id: company.id, name: company.name })), [session.companies])
  const importHeld = importHeldOf(session.permissions)
  const sheet = useSheetImport(api, {
    importerKey: 'sales.priceLists',
    companyId: companyId ?? EVERY_COMPANY,
    companies,
    everyCompany: t('import.everyCompany'),
    rights,
    locale: locale === 'en' ? 'en' : 'it',
    onApplied,
  })
  const opened = useRef(false)
  useEffect(() => {
    if (openNow && !opened.current && !importHeld) {
      opened.current = true
      sheet.open()
    }
    // Once, when asked to open.
  }, [openNow, importHeld])
  const wasOpen = useRef(false)
  useEffect(() => {
    if (sheet.model) wasOpen.current = true
    else if (wasOpen.current) {
      wasOpen.current = false
      onClose?.()
    }
  }, [sheet.model, onClose])
  return (
    <PriceListImportView
      model={{ held: importHeld, sheet: sheet.model, button: !!button, refusedOpen: !!openNow && !!importHeld }}
      onOpen={() => {
        if (!importHeld) sheet.open()
      }}
      onDismiss={onClose}
      actions={sheet.actions}
    />
  )
}
