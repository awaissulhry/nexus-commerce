'use client'

import { useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { FileQuestion } from 'lucide-react'
import { SelectionLabel } from '@nexus/ui/grid'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { companyPrefix } from '../../../../lib/session/session'
import { useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { downloadText } from '../../../parties/_shared/hooks'
import { PartiesList } from '../../../parties/_shared/PartiesList'
import { partyName, type ListView } from '../../../parties/_shared/model'
import { NS, requestHeld } from '../depth/model'
import '../depth/depth.css'
import { useDocumentsColumn } from './columns'
import { SupplierImport } from './SupplierImport'
import { useSupplierDocuments } from './use-documents'
import { ExpiringSection, type ExpiringRow } from './view/ExpiringSection'
import { RequestDialog } from './view/RequestDialog'

/**
 * `/w/<company>/purchasing/suppliers` (SCR-056): the shared parties list seen from Purchasing, with its W2b parts
 * (B-W2b-334): the band's Import (the parties importer with the supplier columns), the Documents column, the "Documents
 * expiring in 30 days" tile and its view (`?docs=expiring`, its own list frame), and Request documents N on a selection.
 */
export function SuppliersPage() {
  return (
    <WithMessages namespaces={[NS]}>
      <Suppliers />
    </WithMessages>
  )
}

function Suppliers() {
  const t = useT(NS)
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const params = useSearchParams()
  const session = useOfficeSession()
  const prefix = companyPrefix(session.company?.code ?? '')
  const docs = useSupplierDocuments()
  const columns = useDocumentsColumn(docs.byParty, docs.summary.status === 'error' ? docs.summary.problem : null)
  const [expiring, setExpiring] = useState(params?.get('docs') === 'expiring')

  const setDocs = (on: boolean) => {
    setExpiring(on)
    const search = new URLSearchParams(params?.toString() ?? '')
    if (on) {
      search.set('docs', 'expiring')
      search.delete('view')
    } else search.delete('docs')
    const qs = search.toString()
    router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
  }
  // The suppliers' names and kinds are read when the expiring view opens.
  const loadNames = useRef(docs.loadSuppliers)
  loadNames.current = docs.loadSuppliers
  useEffect(() => {
    if (expiring) loadNames.current()
  }, [expiring])

  const summary = docs.summary.status === 'ready' ? docs.summary.value : null
  const exportRows = (rows: readonly ExpiringRow[]) => {
    const head = [t('expiring.col.code'), t('expiring.col.supplier'), t('expiring.col.expiring'), t('expiring.col.expired'), t('expiring.col.missing'), t('expiring.col.valid')]
    const cell = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`
    const lines = [head, ...rows.map((row) => [row.code, row.name, row.docs.expiring, row.docs.expired, row.docs.missing, row.docs.valid])].map((line) => line.map(cell).join(';'))
    downloadText('supplier-documents-expiring.csv', `${lines.join('\n')}\n`)
  }

  return (
    <>
      <PartiesList
        side="suppliers"
        columns={columns}
        headActions={(reload) => (
          <SupplierImport
            importer="parties.parties"
            onApplied={() => {
              reload()
              docs.reload()
            }}
          />
        )}
        depth={(list) => {
          const on = expiring && list.view === 'open'
          const held = requestHeld(docs.can, list.selectedRows.length)
          return {
            tiles: [
              {
                label: t('tile.expiring'),
                value: docs.summary.status === 'loading' ? <Skeleton width={36} height={22} /> : summary ? String(summary.expiringIn30Days) : '—',
                hint: docs.summary.status === 'error' ? t('tile.unknown') : t('tile.expiringHint'),
                active: on,
                onClick: () => {
                  if (on) setDocs(false)
                  else {
                    if (list.view !== 'open') list.onView('open' as ListView)
                    setDocs(true)
                  }
                },
              },
            ],
            body: expiring ? (
              on ? (
                <ExpiringSection
                  model={{ summary: docs.summary.status === 'ready' ? { status: 'ready', value: docs.summary.value.suppliers } : docs.summary, suppliers: docs.suppliers, can: docs.can, prefix }}
                  actions={{
                    onRequest: docs.request.open,
                    onExport: exportRows,
                    onClose: () => setDocs(false),
                    onRetry: docs.reload,
                    onOpen: (row) => router.push(`${prefix}/purchasing/suppliers/${encodeURIComponent(row.id)}?tab=documents`),
                  }}
                />
              ) : (
                <LeaveExpiring onLeave={() => setDocs(false)} />
              )
            ) : null,
            bulk: (
              <Button size="sm" aria-label={t('list.request', { count: list.selectedRows.length })} onClick={() => docs.request.open(list.selectedRows.map((row) => ({ id: row.id, name: partyName(row) })))} heldReason={held ? t(held.key, held.params) : null}>
                <FileQuestion size={13} aria-hidden /> <SelectionLabel>{t('list.request', { count: list.selectedRows.length })}</SelectionLabel>
              </Button>
            ),
          }
        }}
      />
      <RequestDialog run={docs.request.run} today={docs.today} onDue={docs.request.onDue} onSend={docs.request.onSend} onClose={docs.request.onClose} />
    </>
  )
}

/** Another of the list's views was picked while the expiring view was on: it closes (its address term too). */
function LeaveExpiring({ onLeave }: { onLeave: () => void }) {
  useEffect(() => {
    onLeave()
  }, [onLeave])
  return null
}
