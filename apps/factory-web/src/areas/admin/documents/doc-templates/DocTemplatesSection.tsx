'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { companyPrefix } from '../../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useLiveBus } from '../../../../shell/live/use-live'
import { problemKey, type Loaded } from '../../shared/model'
import type { CompanyOption } from '../model'
import { refusalOf } from '../template-editor/model'
import { editorHref } from '../template-editor/view/DocTemplateEditorView'
import { createDocumentTemplate, deleteDocumentTemplate, listDocumentTemplates, publishDocumentTemplate, retireDocumentTemplate, type DocumentTemplatesAnswer } from './api'
import { openTarget, type CompanyChoice, type DocBulk, type DocRow, type DocTemplatesModel, type ListNotice, type ListRead } from './model'
import { DocTemplatesView } from './view/DocTemplatesView'
import type { PageView } from './view/ViewSwitch'

/** A write of this list is not "changed elsewhere" when its own event comes back (live) within this time. */
const OWN_ECHO_MS = 8000

/**
 * `/w/<company>/admin/documents?view=documents&company=<id>` (SCR-630, B-W2b-432): the company's document templates (`GET
 * /templates/documents?companyId`); the company is the address's, else the office's own. "Write a template" = `POST
 * /templates/documents` (the code's layout, every optional column) then its editor; a bulk action runs one call per row
 * with the version read (publish, retire, delete), said in ONE notice with each refused row in words. Live:
 * document_template.changed of this company → "N updates · Show" (the rows never move under the cursor).
 */
export function DocTemplatesSection({ companies, askedCompany, onView, onCompany }: { companies: Loaded<CompanyOption>; askedCompany: string | null; onView: (view: PageView) => void; onCompany: (companyId: string) => void }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const prefix = companyPrefix(session.company?.code ?? '')
  const choices: CompanyChoice[] = useMemo(
    () => (companies.items ? companies.items.filter((company) => company.status === 'ACTIVE').map((company) => ({ id: company.id, name: company.legalName })) : session.companies.map((company) => ({ id: company.id, name: company.name }))),
    [companies.items, session.companies],
  )
  const companyId = askedCompany ?? session.company?.id ?? choices[0]?.id ?? null
  const [read, setRead] = useState<ListRead<DocumentTemplatesAnswer>>({ status: 'loading' })
  const [selected, setSelected] = useState<readonly string[]>([])
  const [confirm, setConfirm] = useState<DocTemplatesModel['confirm']>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<ListNotice | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const lastWrite = useRef(0)

  const load = useCallback(async () => {
    if (!companyId) return setRead({ status: 'ready', answer: { templates: [], slots: [], mayManage: false } })
    try {
      setRead({ status: 'ready', answer: await listDocumentTemplates(api, { companyId }) })
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      setRead({ status: 'failed', problem: problemKey(error) })
    }
  }, [api, companyId])

  useEffect(() => {
    setRead({ status: 'loading' })
    setSelected([])
    void load()
  }, [load])

  useLiveBus({
    onChange: (change) => {
      if (change.type !== 'document_template.changed' || change.fields.companyId !== companyId) return
      if (Date.now() - lastWrite.current < OWN_ECHO_MS) return
      setUpdates((count) => count + 1)
    },
    onReconnect: () => void load(),
  })

  const runBulk = async (action: DocBulk, rows: readonly DocRow[]) => {
    setBusy(true)
    setNotice(null)
    lastWrite.current = Date.now()
    const refused: Array<{ id: string; said: ReturnType<typeof refusalOf> }> = []
    let done = 0
    for (const row of rows) {
      try {
        if (action === 'retire' && row.active) await retireDocumentTemplate(api, row.active)
        else if (action === 'publish' && row.draft) await publishDocumentTemplate(api, row.draft)
        else if (action === 'delete' && row.draft) await deleteDocumentTemplate(api, row.draft)
        done += 1
      } catch (error) {
        refused.push({ id: row.id, said: refusalOf(error) })
      }
    }
    lastWrite.current = Date.now()
    setNotice(
      refused.length === 0
        ? { key: `tpl.bulk.done.${action}`, tone: 'success', params: { count: done } }
        : { key: done === 0 ? 'tpl.bulk.failed' : 'tpl.bulk.partial', tone: done === 0 ? 'danger' : 'warning', params: { count: done, refused: refused.length }, refused },
    )
    setConfirm(null)
    setSelected([])
    setBusy(false)
    void load()
  }

  const legal = companies.items?.find((company) => company.id === companyId) ?? null
  const model: DocTemplatesModel = { prefix, companies: choices, companyId, read, selected, confirm, busy, notice, asOf, updates, legalMissing: legal ? legal.legalMissing : null }

  return (
    <DocTemplatesView
      model={model}
      actions={{
        onView,
        onCompany,
        onSelect: setSelected,
        onRetry: () => {
          setRead({ status: 'loading' })
          void load()
        },
        onShowUpdates: () => void load(),
        onOpen: (row) => {
          const target = openTarget(row)
          if (target) router.push(editorHref(prefix, target))
        },
        onStart: (row) => {
          if (!companyId || busy) return
          setBusy(true)
          setNotice(null)
          lastWrite.current = Date.now()
          createDocumentTemplate(api, { companyId, kind: row.kind, language: row.language })
            .then((created) => router.push(editorHref(prefix, created.id)))
            .catch((error: unknown) => {
              setNotice({ ...refusalOf(error), tone: 'danger' })
              void load()
            })
            .finally(() => setBusy(false))
        },
        onBulk: (action, rows) => setConfirm(action && rows && rows.length > 0 ? { action, rows } : null),
        onBulkGo: () => {
          if (confirm && !busy) void runBulk(confirm.action, confirm.rows)
        },
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
