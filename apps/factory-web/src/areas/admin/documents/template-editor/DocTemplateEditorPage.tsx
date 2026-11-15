'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { companyPrefix } from '../../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useLiveBus } from '../../../../shell/live/use-live'
import { adminHref, problemKey } from '../../shared/model'
import {
  createDocumentTemplate,
  deleteDocumentTemplate,
  documentKinds,
  documentTemplatePreview,
  getDocumentTemplate,
  listDocumentTemplates,
  publishDocumentTemplate,
  retireDocumentTemplate,
  saveDocumentTemplate,
  type DocumentKind,
  type DocumentTemplate,
  type TemplateLanguage,
} from '../doc-templates/api'
import { documentChanges, documentDraftOf, documentProblems, documentSaveBody, refusalOf, refusalReloads, type DocumentDraft } from './model'
import { DocTemplateEditorView, editorHref, type DocEditorModel, type EditorConfirm, type EditorNotice, type EditorRead } from './view/DocTemplateEditorView'

/** A write of this page is not "changed by someone else" when its own event comes back (live) within this time. */
const OWN_ECHO_MS = 8000

/**
 * `/w/<company>/admin/documents/templates/<id>` (SCR-631, B-W2b-432): reads the version (`GET /templates/documents/:id`),
 * the kind's sections (`GET …/kinds`), the versions of its series (`GET /templates/documents?companyId&kind&language`)
 * and its PDF (`GET …/:id/preview`, again after each save). ⌘S saves the changed fields (`PUT` with the version read);
 * Publish, Retire and Delete ask first (the DS ActionConfirm); New version starts a draft from this one (`POST`, one key per
 * click) and opens it. A refusal is said by its code; a 409 reads everything again. Live: document_template.changed of the
 * same series reads again (or, with unsaved words, says it changed elsewhere).
 */
export function DocTemplateEditorPage({ templateId }: { templateId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const prefix = companyPrefix(session.company?.code ?? '')
  const [read, setRead] = useState<EditorRead<DocumentTemplate>>({ status: 'loading' })
  const [kind, setKind] = useState<DocumentKind | null>(null)
  const [versions, setVersions] = useState<readonly DocumentTemplate[] | null>(null)
  const [draft, setDraft] = useState<DocumentDraft | null>(null)
  const [preview, setPreview] = useState<DocEditorModel['preview']>({ src: null, problem: null })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<EditorNotice | null>(null)
  const [confirm, setConfirm] = useState<EditorConfirm>(null)
  const [changedElsewhere, setChangedElsewhere] = useState(false)
  const lastWrite = useRef(0)
  const current = useRef<{ template: DocumentTemplate | null; draft: DocumentDraft | null }>({ template: null, draft: null })
  current.current = { template: read.status === 'ready' ? read.template : null, draft }

  const loadPreview = useCallback(async () => {
    setPreview({ src: null, problem: null })
    try {
      setPreview({ src: await documentTemplatePreview(api, templateId), problem: null })
    } catch (error) {
      // A company without its legal data cannot print (400: the design's error, said with where it is fixed).
      setPreview({ src: null, problem: isApiError(error) && error.kind === 'invalid' ? 'tpl.preview.legalMissing' : refusalOf(error).key })
    }
  }, [api, templateId])

  const loadVersions = useCallback(
    async (template: DocumentTemplate) => {
      try {
        const answer = await listDocumentTemplates(api, { companyId: template.companyId, kind: template.kind, language: template.language === 'en' ? 'en' : ('it' as TemplateLanguage) })
        setVersions(answer.templates.filter((version) => version.kind === template.kind && version.language === template.language))
      } catch {
        setVersions([])
      }
    },
    [api],
  )

  const load = useCallback(async () => {
    try {
      const answer = await getDocumentTemplate(api, templateId)
      setRead({ status: 'ready', template: answer.template, mayManage: answer.mayManage })
      setDraft(documentDraftOf(answer.template))
      setChangedElsewhere(false)
      void loadVersions(answer.template)
      void loadPreview()
    } catch (error) {
      setRead({ status: 'failed', problem: problemKey(error) })
    }
  }, [api, templateId, loadPreview, loadVersions])

  useEffect(() => {
    setRead({ status: 'loading' })
    void load()
  }, [load])

  // The kinds answer names every kind's sections: keep the one of this template (read once per kind).
  const templateKind = read.status === 'ready' ? read.template.kind : null
  useEffect(() => {
    if (!templateKind) return
    let live = true
    documentKinds(api).then(
      (answer) => live && setKind(answer.kinds.find((entry) => entry.kind === templateKind) ?? null),
      () => live && setKind(null),
    )
    return () => {
      live = false
    }
  }, [api, templateKind])

  useLiveBus({
    onChange: (change) => {
      if (change.type !== 'document_template.changed') return
      const template = current.current.template
      if (!template) return
      const sameSeries = change.fields.companyId === template.companyId && change.fields.kind === template.kind && change.fields.language === template.language
      if (!sameSeries || Date.now() - lastWrite.current < OWN_ECHO_MS) return
      if (current.current.draft && documentChanges(template, current.current.draft).length > 0) setChangedElsewhere(true)
      else void load()
    },
    onReconnect: () => {
      const template = current.current.template
      if (template && current.current.draft && documentChanges(template, current.current.draft).length === 0) void load()
    },
  })

  /** One write: busy, the refusal in words (a 409 reads again), the receipt. */
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
  const model: DocEditorModel = {
    prefix,
    companyName: template ? (session.companies.find((company) => company.id === template.companyId)?.name ?? null) : null,
    read,
    kind,
    versions,
    draft,
    preview,
    busy,
    notice,
    confirm,
    changedElsewhere,
  }

  return (
    <DocTemplateEditorView
      model={model}
      actions={{
        onDraft: (change) => setDraft((now) => (now ? { ...now, ...change } : now)),
        onDiscard: () => template && setDraft(documentDraftOf(template)),
        onSave: () => {
          if (!template || !draft || read.status !== 'ready') return
          if (documentChanges(template, draft).length === 0 || Object.keys(documentProblems(kind, draft)).length > 0) return
          void write(async () => {
            const saved = await saveDocumentTemplate(api, template, documentSaveBody(template, draft))
            setRead({ status: 'ready', template: saved, mayManage: read.mayManage })
            setDraft(documentDraftOf(saved))
            setNotice({ key: 'tpl.done.saved', tone: 'success', params: { revision: saved.revision } })
            void loadPreview()
            void loadVersions(saved)
          })
        },
        onConfirm: setConfirm,
        onPublish: () => {
          if (!template || read.status !== 'ready') return
          void write(async () => {
            const answer = await publishDocumentTemplate(api, template)
            setRead({ status: 'ready', template: answer.template, mayManage: read.mayManage })
            setDraft(documentDraftOf(answer.template))
            setNotice(answer.retired ? { key: 'tpl.done.publishedRetired', tone: 'success', params: { revision: answer.template.revision, retired: answer.retired.revision } } : { key: 'tpl.done.published', tone: 'success', params: { revision: answer.template.revision } })
            void loadVersions(answer.template)
            void loadPreview()
          })
        },
        onRetire: () => {
          if (!template || read.status !== 'ready') return
          void write(async () => {
            const retired = await retireDocumentTemplate(api, template)
            setRead({ status: 'ready', template: retired, mayManage: read.mayManage })
            setNotice({ key: 'tpl.done.retired', tone: 'success', params: { revision: retired.revision } })
            void loadVersions(retired)
          })
        },
        onDelete: () => {
          if (!template) return
          void write(async () => {
            await deleteDocumentTemplate(api, template)
            router.replace(`${adminHref(prefix, '/documents')}?view=documents&company=${encodeURIComponent(template.companyId)}`)
          })
        },
        onNewVersion: () => {
          if (!template) return
          void write(async () => {
            const created = await createDocumentTemplate(api, { companyId: template.companyId, kind: template.kind, language: template.language === 'en' ? 'en' : 'it', from: template.id })
            router.push(editorHref(prefix, created.id))
          })
        },
        onRetry: () => {
          setRead({ status: 'loading' })
          void load()
        },
        onRetryPreview: () => void loadPreview(),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
