'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { companyPrefix } from '../../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useLiveBus } from '../../../../shell/live/use-live'
import { adminHref, problemKey } from '../../shared/model'
import {
  createEmailTemplate,
  deleteEmailTemplate,
  getEmailTemplate,
  listEmailTemplates,
  mailEvents,
  previewEmailTemplate,
  publishEmailTemplate,
  retireEmailTemplate,
  saveEmailTemplate,
  type EmailTemplate,
  type MailEventInfo,
} from '../mail-templates/api'
import { mailChanges, mailDraftOf, mailProblems, refusalOf, refusalReloads, type MailDraft } from './model'
import type { EditorConfirm, EditorNotice, EditorRead } from './view/DocTemplateEditorView'
import { mailEditorHref, MailTemplateEditorView, type MailEditorModel } from './view/MailTemplateEditorView'

const OWN_ECHO_MS = 8000

/**
 * `/w/<company>/admin/documents/mail/<id>` (SCR-633, B-W2b-432): reads the version (`GET /templates/mail/:id`), the event's
 * placeholders and the code's words (`GET /templates/mail/events`), the versions of the same company (or every company),
 * event and language (`GET /templates/mail?companyId&event&language`), and the preview (`POST …/:id/preview`: the saved
 * words filled with made-up values and the names of the company — the office's own for an every-company template; again
 * after each save). Writes as the document editor: ⌘S, Publish / Retire / Delete after a confirm, New version. Nothing is
 * sent from here. Live: email_template.changed of the same series.
 */
export function MailTemplateEditorPage({ templateId }: { templateId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const prefix = companyPrefix(session.company?.code ?? '')
  const officeCompany = session.company?.id ?? null
  const [read, setRead] = useState<EditorRead<EmailTemplate>>({ status: 'loading' })
  const [events, setEvents] = useState<readonly MailEventInfo[] | null>(null)
  const [versions, setVersions] = useState<readonly EmailTemplate[] | null>(null)
  const [draft, setDraft] = useState<MailDraft | null>(null)
  const [preview, setPreview] = useState<MailEditorModel['preview']>({ answer: null, problem: null })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<EditorNotice | null>(null)
  const [confirm, setConfirm] = useState<EditorConfirm>(null)
  const [changedElsewhere, setChangedElsewhere] = useState(false)
  const lastWrite = useRef(0)
  const current = useRef<{ template: EmailTemplate | null; draft: MailDraft | null }>({ template: null, draft: null })
  current.current = { template: read.status === 'ready' ? read.template : null, draft }

  const loadPreview = useCallback(
    async (template: EmailTemplate) => {
      setPreview({ answer: null, problem: null })
      try {
        setPreview({ answer: await previewEmailTemplate(api, template.id, template.companyId ?? officeCompany), problem: null })
      } catch (error) {
        setPreview({ answer: null, problem: refusalOf(error).key })
      }
    },
    [api, officeCompany],
  )

  const loadVersions = useCallback(
    async (template: EmailTemplate) => {
      // The list answers the company's own and every company's versions: keep the series of this one.
      const companyId = template.companyId ?? officeCompany
      if (!companyId) return setVersions([])
      try {
        const answer = await listEmailTemplates(api, { companyId, event: template.event, language: template.language === 'en' ? 'en' : 'it' })
        setVersions(answer.templates.filter((version) => version.companyId === template.companyId && version.event === template.event && version.language === template.language))
      } catch {
        setVersions([])
      }
    },
    [api, officeCompany],
  )

  const load = useCallback(async () => {
    try {
      const answer = await getEmailTemplate(api, templateId)
      setRead({ status: 'ready', template: answer.template, mayManage: answer.mayManage })
      setDraft(mailDraftOf(answer.template))
      setChangedElsewhere(false)
      void loadVersions(answer.template)
      void loadPreview(answer.template)
    } catch (error) {
      setRead({ status: 'failed', problem: problemKey(error) })
    }
  }, [api, templateId, loadPreview, loadVersions])

  useEffect(() => {
    setRead({ status: 'loading' })
    void load()
  }, [load])

  useEffect(() => {
    let live = true
    mailEvents(api).then(
      (answer) => live && setEvents(answer.events),
      () => live && setEvents([]),
    )
    return () => {
      live = false
    }
  }, [api])

  useLiveBus({
    onChange: (change) => {
      if (change.type !== 'email_template.changed') return
      const template = current.current.template
      if (!template) return
      const sameSeries = (change.fields.companyId ?? null) === template.companyId && change.fields.event === template.event && change.fields.language === template.language
      if (!sameSeries || Date.now() - lastWrite.current < OWN_ECHO_MS) return
      if (current.current.draft && mailChanges(template, current.current.draft).length > 0) setChangedElsewhere(true)
      else void load()
    },
    onReconnect: () => {
      const template = current.current.template
      if (template && current.current.draft && mailChanges(template, current.current.draft).length === 0) void load()
    },
  })

  const write = async (work: () => Promise<void>) => {
    setBusy(true)
    setNotice(null)
    lastWrite.current = Date.now()
    try {
      await work()
    } catch (error) {
      setNotice({ ...refusalOf(error), tone: 'danger' })
      if (refusalReloads(error)) void load()
    } finally {
      lastWrite.current = Date.now()
      setBusy(false)
      setConfirm(null)
    }
  }

  const template = read.status === 'ready' ? read.template : null
  const event = template && events ? (events.find((entry) => entry.event === template.event) ?? null) : null
  const model: MailEditorModel = {
    prefix,
    companyName: template?.companyId ? (session.companies.find((company) => company.id === template.companyId)?.name ?? null) : null,
    read,
    event,
    versions,
    draft,
    preview,
    busy,
    notice,
    confirm,
    changedElsewhere,
  }

  return (
    <MailTemplateEditorView
      model={model}
      actions={{
        onDraft: (change) => setDraft((now) => (now ? { ...now, ...change } : now)),
        onDiscard: () => template && setDraft(mailDraftOf(template)),
        onSave: () => {
          if (!template || !draft || read.status !== 'ready') return
          const changed = mailChanges(template, draft)
          if (changed.length === 0 || Object.keys(mailProblems(event?.placeholders ?? null, draft)).length > 0) return
          void write(async () => {
            const saved = await saveEmailTemplate(api, template, Object.fromEntries(changed.map((field) => [field, draft[field]])))
            setRead({ status: 'ready', template: saved, mayManage: read.mayManage })
            setDraft(mailDraftOf(saved))
            setNotice({ key: 'tpl.done.saved', tone: 'success', params: { revision: saved.revision } })
            void loadPreview(saved)
            void loadVersions(saved)
          })
        },
        onConfirm: setConfirm,
        onPublish: () => {
          if (!template || read.status !== 'ready') return
          void write(async () => {
            const answer = await publishEmailTemplate(api, template)
            setRead({ status: 'ready', template: answer.template, mayManage: read.mayManage })
            setDraft(mailDraftOf(answer.template))
            setNotice(answer.retired ? { key: 'tpl.done.publishedRetired', tone: 'success', params: { revision: answer.template.revision, retired: answer.retired.revision } } : { key: 'tpl.done.published', tone: 'success', params: { revision: answer.template.revision } })
            void loadVersions(answer.template)
          })
        },
        onRetire: () => {
          if (!template || read.status !== 'ready') return
          void write(async () => {
            const retired = await retireEmailTemplate(api, template)
            setRead({ status: 'ready', template: retired, mayManage: read.mayManage })
            setNotice({ key: 'tpl.done.mailRetired', tone: 'success', params: { revision: retired.revision } })
            void loadVersions(retired)
          })
        },
        onDelete: () => {
          if (!template) return
          void write(async () => {
            await deleteEmailTemplate(api, template)
            router.replace(`${adminHref(prefix, '/documents')}?view=mail${template.companyId ? `&company=${encodeURIComponent(template.companyId)}` : ''}`)
          })
        },
        onNewVersion: () => {
          if (!template) return
          void write(async () => {
            const created = await createEmailTemplate(api, { companyId: template.companyId, event: template.event, language: template.language === 'en' ? 'en' : 'it', from: template.id })
            router.push(mailEditorHref(prefix, created.id))
          })
        },
        onRetry: () => {
          setRead({ status: 'loading' })
          void load()
        },
        onRetryPreview: () => template && void loadPreview(template),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
