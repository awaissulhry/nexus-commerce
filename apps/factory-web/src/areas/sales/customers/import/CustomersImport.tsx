'use client'

import { useMemo } from 'react'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { EVERY_COMPANY, useSheetImport } from '../../../products/styles/import/sheet-import'
import { CustomersImportView } from './view/CustomersImportView'

/** The customers import's rights and why Import is held (a `customer-terms` key), or null. */
export function importHeldOf(permissions: readonly string[]): string | null {
  const held = new Set(permissions)
  if (!held.has('parties.manage')) return 'import.held.manage'
  if (!held.has('imports.run') || !held.has('files.upload')) return 'import.held.run'
  return null
}

/**
 * The container of Customers › Import (B-W2a-49): one import job on the customers and suppliers importer
 * (`parties.parties`) through the shared sheet import (products/styles/import/sheet-import.ts: upload → the dry run,
 * nothing written → apply what was seen → the result; the job is read every 2 s while it moves). The rows belong to every
 * company by default, as New customer's "Belongs to" (W1); a person in several companies may pick one. Running it needs
 * parties.manage and imports.run + files.upload; applying it imports.apply (the wizard holds Apply without it).
 */
export function CustomersImport({ onApplied }: { onApplied: () => void }) {
  return (
    <WithMessages namespaces={['customer-terms', 'admin-import', 'admin']}>
      <ImportContainer onApplied={onApplied} />
    </WithMessages>
  )
}

function ImportContainer({ onApplied }: { onApplied: () => void }) {
  const t = useT('customer-terms')
  const locale = useLocale()
  const api = useOfficeApi()
  const session = useOfficeSession()
  const held = useMemo(() => new Set(session.permissions), [session.permissions])
  const rights = useMemo(() => ({ view: held.has('imports.view'), run: held.has('imports.run') && held.has('files.upload'), apply: held.has('imports.apply'), people: false }), [held])
  const companies = useMemo(() => session.companies.map((company) => ({ id: company.id, name: company.name })), [session.companies])
  const importHeld = importHeldOf(session.permissions)
  const sheet = useSheetImport(api, {
    importerKey: 'parties.parties',
    companyId: EVERY_COMPANY,
    companies,
    everyCompany: t('import.everyCompany'),
    rights,
    locale: locale === 'en' ? 'en' : 'it',
    onApplied,
  })
  return (
    <CustomersImportView
      model={{ held: importHeld, sheet: sheet.model }}
      onOpen={() => {
        if (!importHeld) sheet.open()
      }}
      actions={sheet.actions}
    />
  )
}
