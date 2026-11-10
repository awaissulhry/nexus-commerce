'use client'

import { useMemo, useState, type ReactNode } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { EVERY_COMPANY, useSheetImport } from '../../styles/import/sheet-import'
import { SheetImportDialog } from '../../styles/import/view/SheetImportDialog'
import { depthCan, importHeld } from './model'

/** The importers of the libraries (B-W2b-224: factory-api platform/imports/registry.ts). */
export const IMPORTERS = { poms: 'product.pointsOfMeasure', rules: 'product.gradeRules' } as const

/**
 * Import (W2b) on the Sizes page (B-W2b-240; design products.sizes page.h "Import (W2b)"): a sheet of points of measure
 * or of grade rules, through the same wizard as Admin › Import & export (upload → the dry run, nothing written → apply
 * what was seen → the result; the job stays on the server). The importer is named in this page's words (the API's
 * label is English). Rights: product.styles.manage, imports.run and files.upload; applying needs imports.apply.
 */
export function useLibraryImport({ api, permissions, companyId, companies, locale, onApplied }: { api: ApiClient; permissions: readonly string[]; companyId: string | null; companies: ReadonlyArray<{ id: string; name: string }>; locale: 'it' | 'en'; onApplied: () => void }): {
  held: string | null
  open: (importer: 'poms' | 'rules') => void
  dialog: ReactNode
} {
  const can = useMemo(() => depthCan(permissions), [permissions])
  const rights = useMemo(() => ({ view: can.importView, run: can.importRun, apply: can.importApply, people: false }), [can])
  const company = companyId ?? (companies.length === 1 ? companies[0]!.id : EVERY_COMPANY)
  const [which, setWhich] = useState<'poms' | 'rules'>('poms')
  const common = { companyId: company, companies, everyCompany: '', rights, locale, onApplied }
  const poms = useSheetImport(api, { ...common, importerKey: IMPORTERS.poms })
  const rules = useSheetImport(api, { ...common, importerKey: IMPORTERS.rules })
  const current = which === 'poms' ? poms : rules
  const held = importHeld(can)
  return {
    held,
    open: (importer) => {
      if (held) return
      setWhich(importer)
      ;(importer === 'poms' ? poms : rules).open()
    },
    dialog: current.model ? <ImportDialog which={which} model={current.model} actions={current.actions} /> : null,
  }
}

function ImportDialog({ which, model, actions }: { which: 'poms' | 'rules'; model: NonNullable<ReturnType<typeof useSheetImport>['model']>; actions: ReturnType<typeof useSheetImport>['actions'] }) {
  return (
    <WithMessages namespaces={['products-sizes-depth']}>
      <Named which={which} model={model} actions={actions} />
    </WithMessages>
  )
}

function Named({ which, model, actions }: { which: 'poms' | 'rules'; model: NonNullable<ReturnType<typeof useSheetImport>['model']>; actions: ReturnType<typeof useSheetImport>['actions'] }) {
  const t = useT('products-sizes-depth')
  // The wizard names an importer it has no words for by the API's label: ours, in the page's language.
  const importers = model.importers.map((importer) => ({ ...importer, label: t(`import.name.${which}`), description: t(`import.fills.${which}`) }))
  const companies = model.companies.map((company) => (company.id === EVERY_COMPANY ? { ...company, name: t('common.everyCompany') } : company))
  return <SheetImportDialog model={{ ...model, importers, companies }} actions={actions} />
}
