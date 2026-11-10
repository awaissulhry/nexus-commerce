'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useLive } from '../../../quality/_shared/hooks'
import { checkTranslation, draftPdf, editDraft, moveTranslation, readCoverage, readDeclaration, readLeaflet, refreshDraft, signedPdfAddress, startTranslations, withdrawDraft } from '../api'
import {
  declarationsCan,
  draftOf,
  editOf,
  isDeclarationsChange,
  problemOf,
  readProblemOf,
  recordAddressOf,
  recordAddressText,
  recordOfDeclaration,
  recordOfLeaflet,
  type ContentDraft,
  type Problem,
  type RecordAddress,
  type RecordDoc,
} from '../model'
import { failedRead, loadingRead, readyRead, type PageNotice, type PreviewState, type Read } from '../view-model'
import { RecordView } from '../view/RecordView'

/** One document as the record: the declaration route for every kind, the leaflet's own route for user information. */
export async function readRecord(api: ReturnType<typeof useOfficeApi>, id: string, signal?: AbortSignal): Promise<RecordDoc> {
  const declaration = await readDeclaration(api, id, signal)
  if (declaration.kind !== 'USER_INFORMATION') return recordOfDeclaration(declaration)
  return recordOfLeaflet(await readLeaflet(api, id, signal))
}

/** The PDF of one document of the family: a draft painted by the API (bytes), a signed one its uploaded file (an address). */
export async function readPdf(api: ReturnType<typeof useOfficeApi>, record: RecordDoc, documentId: string, signal?: AbortSignal): Promise<Uint8Array | string> {
  const entry = record.family.find((item) => item.id === documentId)
  const generated = entry ? entry.origin === 'GENERATED' : record.generated
  if (generated) return draftPdf(api, record.kind, documentId, signal)
  const address = await signedPdfAddress(api, record.row.styleId, documentId)
  if (!address) throw new Error('preview.noFile')
  return address
}

export const pdfProblem = (error: unknown): string => (error instanceof Error && error.message === 'preview.noFile' ? 'preview.noFile' : readProblemOf(error))

/**
 * `/w/<company>/compliance/declarations/<id>?tab=content|languages|batches|publication&do=…&edit=1` (SCR-052-record; B-W2b-268):
 * reads the document (and, user information, its leaflet route), the PDF of the language shown beside the fields, and the
 * languages the markets need (Translate's choices). Every write is one call at the version read, with its own Idempotency-Key;
 * the record is read again after it (and the PDF, which the API paints from what is saved). A live change of this document
 * family reads it again — or, while words are being typed, says so and waits for "Read again".
 */
export function DeclarationRecord({ documentId }: { documentId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/compliance\/declarations\/[^/]+\/?$/, '')
  const can = useMemo(() => declarationsCan(session.permissions), [session.permissions])
  const address = useMemo(() => recordAddressOf(params), [params])
  const created = params?.get('created') === '1'

  const [read, setRead] = useState<Read<RecordDoc>>(loadingRead)
  const [readAt, setReadAt] = useState<string | null>(null)
  const [changedAt, setChangedAt] = useState<string | null>(null)
  const [notice, setNotice] = useState<PageNotice | null>(created ? { tone: 'success', key: 'notice.created' } : null)
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [draft, setDraft] = useState<ContentDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [reason, setReason] = useState('')
  const [typed, setTyped] = useState('')
  const [translateLanguages, setTranslateLanguages] = useState<readonly string[]>([])
  const [translatePacks, setTranslatePacks] = useState<readonly string[]>([])
  const [marketLanguages, setMarketLanguages] = useState<readonly string[]>([])
  const [online, setOnline] = useState(true)

  useEffect(() => {
    const update = () => setOnline(typeof navigator === 'undefined' || navigator.onLine !== false)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  const go = useCallback((change: Partial<RecordAddress>) => router.replace(`${pathname}${recordAddressText({ ...address, ...change })}`, { scroll: false }), [router, pathname, address])

  const load = useCallback(async () => {
    if (!can.view) return null
    try {
      const record = await readRecord(api, documentId)
      setRead(readyRead(record))
      setReadAt(new Date().toISOString())
      setChangedAt(null)
      return record
    } catch (error) {
      setRead(failedRead(problemOf(error).key))
      return null
    }
  }, [api, can.view, documentId])

  useEffect(() => {
    setRead(loadingRead)
    setPreview(null)
    void load()
  }, [load])

  const record = read.status === 'ready' ? read.value : null

  // The PDF beside the fields: this document's at first, then the language chosen.
  const previewId = preview?.documentId ?? null
  const [previewTurn, setPreviewTurn] = useState(0)
  useEffect(() => {
    if (!record || address.tab !== 'content') return
    const id = previewId && record.family.some((entry) => entry.id === previewId) ? previewId : record.row.id
    const controller = new AbortController()
    setPreview({ documentId: id, pdf: loadingRead })
    readPdf(api, record, id, controller.signal).then(
      (pdf) => !controller.signal.aborted && setPreview({ documentId: id, pdf: readyRead(pdf) }),
      (error: unknown) => !controller.signal.aborted && setPreview({ documentId: id, pdf: failedRead(pdfProblem(error)) }),
    )
    return () => controller.abort()
  }, [api, record, previewId, previewTurn, address.tab])

  // The markets' languages (Translate's choices), once per style.
  const styleId = record?.row.styleId ?? null
  useEffect(() => {
    if (!styleId) return
    readCoverage(api, styleId).then(
      (coverage) => setMarketLanguages(coverage.languages),
      () => setMarketLanguages([]),
    )
  }, [api, styleId])

  // Edit mode follows the address; a fresh draft from what is stored.
  useEffect(() => {
    if (!record) return
    if (address.edit && !draft) setDraft(draftOf(record))
    if (!address.edit && draft) setDraft(null)
  }, [address.edit, record, draft])

  // A dialog opens clean.
  useEffect(() => {
    setProblem(null)
    setReason('')
    setTyped('')
    setTranslateLanguages([])
    setTranslatePacks([])
  }, [address.dialog])

  // Live: this document's family changed elsewhere.
  const stateRef = useRef({ record, draft, busy })
  stateRef.current = { record, draft, busy }
  const live = useLive(
    (change) => {
      const current = stateRef.current
      if (!current.record || !isDeclarationsChange(change) || current.busy) return
      const ids = new Set([current.record.row.id, ...current.record.family.map((entry) => entry.id)])
      const subject = String(change.fields.documentId ?? change.fields.translationOfId ?? '')
      const style = String(change.fields.styleId ?? '')
      if (!ids.has(subject) && style !== current.record.row.styleId) return
      if (current.draft) setChangedAt(new Date().toISOString())
      else void load()
    },
    () => void load(),
  )

  /** One write: busy, the call, a fresh read; the refusal in our words. */
  const run = async (work: () => Promise<unknown>, done: PageNotice, after?: Partial<RecordAddress>) => {
    if (!record || busy) return
    setBusy(true)
    setProblem(null)
    try {
      await work()
      setNotice(done)
      const fresh = await load()
      if (fresh) setPreviewTurn((turn) => turn + 1)
      if (after) go(after)
    } catch (error) {
      setProblem(problemOf(error))
    } finally {
      setBusy(false)
    }
  }

  const kind = record?.kind ?? 'DECLARATION_OF_CONFORMITY'
  const version = record?.row.version ?? 0
  const id = record?.row.id ?? documentId

  return (
    <RecordView
      model={{
        prefix,
        can,
        userId: session.user.id,
        address,
        read,
        readAt,
        live,
        changedAt,
        notice,
        preview,
        draft: address.edit ? draft : null,
        busy,
        problem,
        reason,
        typed,
        translateLanguages,
        translatePacks,
        marketLanguages,
        online,
      }}
      actions={{
        onAddress: go,
        onRetry: () => {
          setRead(loadingRead)
          void load()
        },
        onReload: () => {
          setDraft(null)
          go({ edit: false })
          void load()
        },
        onDismissNotice: () => setNotice(null),
        onPreview: (next) => setPreview({ documentId: next, pdf: loadingRead }),
        onRetryPreview: () => setPreviewTurn((turn) => turn + 1),
        onDraft: setDraft,
        onEdit: (on) => {
          setProblem(null)
          if (!on) setDraft(null)
          go({ edit: on })
        },
        onSave: () => {
          if (!record || !draft) return
          const edit = editOf(record, draft)
          if (!edit) return
          void run(() => editDraft(api, kind, id, { version, ...edit }, newIdempotencyKey()), { tone: 'success', key: 'saved.edited' }, { edit: false })
        },
        onRefresh: () => void run(() => refreshDraft(api, kind, id, version, newIdempotencyKey()), { tone: 'success', key: 'saved.refreshed' }, { dialog: null }),
        onReason: setReason,
        onTyped: setTyped,
        onWithdraw: () => {
          if (!record) return
          void run(() => withdrawDraft(api, kind, id, version, reason.trim(), newIdempotencyKey()), { tone: 'success', key: 'saved.withdrawn' }, { dialog: null })
        },
        onTranslateChoice: (languages, packs) => {
          setTranslateLanguages(languages)
          setTranslatePacks(packs)
        },
        onTranslate: () => void run(() => startTranslations(api, kind, id, translateLanguages, translatePacks, newIdempotencyKey()), { tone: 'success', key: 'notice.translations', params: { count: translateLanguages.length + translatePacks.length } }, { dialog: null, tab: 'languages' }),
        onCheck: () => void run(() => checkTranslation(api, kind, id, version, newIdempotencyKey()), { tone: 'success', key: 'saved.checked' }, { dialog: null }),
        onBackToTranslator: (target, targetVersion) => void run(() => moveTranslation(api, kind, target, targetVersion, 'IN_TRANSLATION', newIdempotencyKey()), { tone: 'info', key: 'saved.backToTranslator' }),
        onCopy: (text, what) => {
          void navigator.clipboard?.writeText(text).then(
            () => setNotice({ tone: 'success', key: what === 'address' ? 'notice.addressCopied' : 'notice.copied', params: { text } }),
            () => setNotice({ tone: 'warning', key: 'notice.copyFailed', params: { text } }),
          )
        },
      }}
    />
  )
}
