'use client'

import { useMemo } from 'react'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { EVERY_COMPANY, useSheetImport } from '../../../products/styles/import/sheet-import'
import { SheetImportDialog } from '../../../products/styles/import/view/SheetImportDialog'
import { NS } from '../depth/model'
import { ImportButton } from './view/ImportButton'

/** Why an import is held (a `purchasing-suppliers-depth` key), or null. */
export function importHeldOf(permissions: readonly string[], importer: 'parties.parties' | 'purchasing.supplierPrices'): string | null {
  const held = new Set(permissions)
  if (importer === 'parties.parties' && !held.has('parties.manage')) return 'held.manage'
  if (importer === 'purchasing.supplierPrices' && !held.has('purchasing.sources.manage')) return 'held.sources'
  if (!held.has('imports.run') || !held.has('files.upload')) return 'held.importRun'
  return null
}

/**
 * The suppliers' imports (B-W2b-334; design purchasing.suppliers page.h "Import (secondary, W2b)" and rec:Supplier/items/
 * sources "Import price list (W2b, ImportFlow)"): the ONE import wizard of Admin › Import & export (upload → the dry run,
 * nothing written → apply what was seen → the result) on the parties importer with B-W2b-311's supplier columns (kinds,
 * status, lead time, origin; keyed by code; every company by default), or on a supplier's price list
 * (`purchasing.supplierPrices`: approved sources keyed by supplier, material and colour code; in the page's company, the
 * cost grain). Running it needs the importer's right and imports.run + files.upload; applying it imports.apply.
 */
export function SupplierImport({ importer, onApplied, label }: { importer: 'parties.parties' | 'purchasing.supplierPrices'; onApplied: () => void; label?: string }) {
  return (
    <WithMessages namespaces={[NS, 'admin-import', 'admin']}>
      <ImportContainer importer={importer} onApplied={onApplied} label={label} />
    </WithMessages>
  )
}

function ImportContainer({ importer, onApplied, label }: { importer: 'parties.parties' | 'purchasing.supplierPrices'; onApplied: () => void; label?: string | undefined }) {
  const t = useT(NS)
  const locale = useLocale()
  const api = useOfficeApi()
  const session = useOfficeSession()
  const held = useMemo(() => new Set(session.permissions), [session.permissions])
  const rights = useMemo(() => ({ view: held.has('imports.view'), run: held.has('imports.run') && held.has('files.upload'), apply: held.has('imports.apply'), people: false }), [held])
  const companies = useMemo(() => session.companies.map((company) => ({ id: company.id, name: company.name })), [session.companies])
  const why = importHeldOf(session.permissions, importer)
  const sheet = useSheetImport(api, {
    importerKey: importer,
    companyId: importer === 'parties.parties' ? EVERY_COMPANY : (session.company?.id ?? companies[0]?.id ?? EVERY_COMPANY),
    companies,
    everyCompany: t('import.everyCompany'),
    rights,
    locale: locale === 'en' ? 'en' : 'it',
    onApplied,
  })
  return (
    <>
      <ImportButton label={label ?? t(importer === 'parties.parties' ? 'import.suppliers' : 'import.prices')} held={why ? t(why) : null} onOpen={() => (why ? undefined : sheet.open())} />
      {sheet.model && <SheetImportDialog model={sheet.model} actions={sheet.actions} />}
    </>
  )
}
