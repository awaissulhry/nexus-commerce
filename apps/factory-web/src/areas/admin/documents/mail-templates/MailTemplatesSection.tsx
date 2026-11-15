'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { companyPrefix } from '../../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useLiveBus } from '../../../../shell/live/use-live'
import { problemKey, type Loaded } from '../../shared/model'
import type { CompanyChoice, ListNotice } from '../doc-templates/model'
import type { PageView } from '../doc-templates/view/ViewSwitch'
import type { CompanyOption } from '../model'
import { refusalOf } from '../template-editor/model'
import { mailEditorHref } from '../template-editor/view/MailTemplateEditorView'
import { createEmailTemplate, deleteEmailTemplate, listEmailTemplates, mailEvents, publishEmailTemplate, retireEmailTemplate } from './api'
import { draftsOf, mailOpenTarget, type MailBulk, type MailRow, type MailTemplatesModel } from './model'
import { MailTemplatesView } from './view/MailTemplatesView'

const OWN_ECHO_MS = 8000

/**
 * `/w/<company>/admin/documents?view=mail&company=<id>` (SCR-632, B-W2b-432): the events and the code's words (`GET
 * /templates/mail/events`) and the company's slots with their versions (`GET /templates/mail?companyId`). "Write this
 * company's" / "Write every company's" = `POST /templates/mail` (from the version in use, else the code's words) then its
 * editor; a bulk action runs one call per version with the version read, said in ONE notice. Live: email_template.changed
 * of this company or of every company → "N updates · Show".
 */
export function MailTemplatesSection({ companies, askedCompany, onView, onCompany }: { companies: Loaded<CompanyOption>; askedCompany: string | null; onView: (view: PageView) => void; onCompany: (companyId: string) => void }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const prefix = companyPrefix(session.company?.code ?? '')
  const choices: CompanyChoice[] = useMemo(
    () => (companies.items ? companies.items.filter((company) => company.status === 'ACTIVE').map((company) => ({ id: company.id, name: company.legalName })) : session.companies.map((company) => ({ id: company.id, name: company.name }))),
    [companies.items, session.companies],
  )
  const companyId = askedCompany ?? session.company?.id ?? choices[0]?.id ?? null
  const [read, setRead] = useState<MailTemplatesModel['read']>({ status: 'loading' })
  const [selected, setSelected] = useState<readonly string[]>([])
  const [confirm, setConfirm] = useState<MailTemplatesModel['confirm']>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<ListNotice | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const lastWrite = useRef(0)

  const load = useCallback(async () => {
    if (!companyId) return setRead({ status: 'ready', answer: { list: { templates: [], slots: [], mayManage: { company: false, all: false } }, events: { events: [], languages: [] } } })
    try {
      const [list, events] = await Promise.all([listEmailTemplates(api, { companyId }), mailEvents(api)])
      setRead({ status: 'ready', answer: { list, events } })
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
      if (change.type !== 'email_template.changed') return
      const whose = change.fields.companyId ?? null
      if (whose !== null && whose !== companyId) return
      if (Date.now() - lastWrite.current < OWN_ECHO_MS) return
      setUpdates((count) => count + 1)
    },
    onReconnect: () => void load(),
  })

  const runBulk = async (action: MailBulk, rows: readonly MailRow[]) => {
    const may = read.status === 'ready' ? read.answer.list.mayManage : { company: false, all: false }
    setBusy(true)
    setNotice(null)
    lastWrite.current = Date.now()
    const refused: Array<{ id: string; said: ReturnType<typeof refusalOf> }> = []
    let done = 0
    for (const row of rows) {
      try {
        if (action === 'retire') {
          if (row.companyActive) await retireEmailTemplate(api, row.companyActive)
        } else {
          for (const draft of draftsOf(row, may)) {
            if (action === 'publish') await publishEmailTemplate(api, draft)
            else await deleteEmailTemplate(api, draft)
          }
        }
        done += 1
      } catch (error) {
        refused.push({ id: row.id, said: refusalOf(error) })
      }
    }
    lastWrite.current = Date.now()
    setNotice(
      refused.length === 0
        ? { key: `tpl.bulk.done.${action === 'retire' ? 'mailRetire' : action}`, tone: 'success', params: { count: done } }
        : { key: done === 0 ? 'tpl.bulk.failed' : 'tpl.bulk.partial', tone: done === 0 ? 'danger' : 'warning', params: { count: done, refused: refused.length }, refused },
    )
    setConfirm(null)
    setSelected([])
    setBusy(false)
    void load()
  }

  const model: MailTemplatesModel = { prefix, companies: choices, companyId, read, selected, confirm, busy, notice, asOf, updates }

  return (
    <MailTemplatesView
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
          const target = mailOpenTarget(row)
          if (target) router.push(mailEditorHref(prefix, target))
        },
        onStart: (row, scope) => {
          if (!companyId || busy) return
          setBusy(true)
          setNotice(null)
          lastWrite.current = Date.now()
          createEmailTemplate(api, { companyId: scope === 'company' ? companyId : null, event: row.event, language: row.language })
            .then((created) => router.push(mailEditorHref(prefix, created.id)))
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
