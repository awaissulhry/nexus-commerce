'use client'

import { useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../api/client'
import { isApiError } from '../../api/errors'
import { createTranslator, messagesFor } from '../../i18n/messages'
import { useLocale } from '../../i18n/provider'
import { completeUpload, requestUpload } from '../../../record-panels/api'
import { uploadProblem, type FileAudience, type FileKind } from '../../../record-panels/model'
import { putToStore, sha256Hex } from '../../../record-panels/store'
import { contentTypeOf } from '../attachments/model'
import { takesSheet } from '../attachments/model' // B-TH-283
import { START_AUDIENCE, type UploadAsk, type UploadPlace } from './model'

/**
 * F-OF-103 (order FILES tab; 13-backend §7 row 1 — the extraction): the ONE upload of the Files window, MOVED here from the docked
 * thread (its state and `sendUploads`, unchanged) so the window on every record and the order's Files tab add files the same way. The
 * dock calls it for its record; the order's container (use-order-files) calls it with "Where it goes": the order or one of its lines.
 * Two fixes on the way: a file the virus scan holds is said, never lost (F5-B6: the confirm's status is read); a refusal says why in
 * words (F5-B7: the API's kind, and its words when it gives them). `onDone` reads again what the upload changed (the dock its record's
 * files; the order's container the ORDER's read: F5-B8). No view here: the window and the tab draw `ask` and `outcome`.
 */

const FILES_VIEW_NS = 'record-thread-files-view'

/** What the last upload left to say: the files refused (with why) and the files the virus scan holds (they open once it says clean). */
export interface UploadOutcome {
  readonly refused: readonly { readonly name: string; readonly reason: string }[]
  readonly held: readonly string[]
}

const NO_OUTCOME: UploadOutcome = { refused: [], held: [] }

/** F5-B7: why the API refused a file, as a key of `records` (`files.problem.*`) or of the Files view (`upload.refused.*`, with its words). */
export function uploadRefusalOf(error: unknown): { readonly ns: 'records' | 'view'; readonly key: string; readonly params?: Readonly<Record<string, string>> } {
  if (!isApiError(error)) return { ns: 'records', key: 'files.problem.failed' }
  if (error.kind === 'forbidden') return { ns: 'view', key: 'upload.refused.forbidden' }
  if (error.kind === 'not_found') return { ns: 'view', key: 'upload.refused.notFound' }
  const detail = error.issues.find((issue) => issue.message)?.message ?? error.message
  if ((error.kind === 'invalid' || error.kind === 'conflict') && detail) return { ns: 'view', key: 'upload.refused.invalid', params: { detail } }
  return { ns: 'records', key: 'files.problem.failed' }
}

export function useFileUpload(
  api: ApiClient,
  input: {
    readonly companyId: string | null
    /** The record the files go on when no place is offered (the dock's record). */
    readonly record: { readonly type: string; readonly id: string } | null
    readonly siteId?: string | null
    readonly partyId: string | null
    readonly choices: { readonly kinds: readonly FileKind[]; readonly audiences: readonly FileAudience[] }
    /** "Where it goes" (the order and its lines); absent: the record above. */
    readonly places?: readonly UploadPlace[]
    /** F-OF-203: what was added (the files' ids, held ones too) and the upload that was asked (an ask's upload answers the ask). */
    readonly onDone?: (result: { readonly fileIds: readonly string[]; readonly ask: UploadAsk }) => void
  },
) {
  const locale = useLocale()
  const words = useMemo(() => {
    const messages = messagesFor(locale, ['records', FILES_VIEW_NS])
    return { records: createTranslator(locale, messages.records ?? {}), view: createTranslator(locale, messages[FILES_VIEW_NS] ?? {}) }
  }, [locale])
  const tr = words.records
  const tv = words.view
  const [upload, setUpload] = useState<UploadAsk | null>(null)
  const [uploadFiles, setUploadFiles] = useState<File[]>([])
  const [outcome, setOutcome] = useState<UploadOutcome>(NO_OUTCOME)
  const [busy, setBusy] = useState(false)
  const latest = useRef(input)
  latest.current = input

  /** Files dropped or browsed (none: "Add files…" opens the window to drop them there); more dropped while it is open join them. */
  const open = (dropped: readonly File[], placeKey?: string) => {
    const { choices, places } = latest.current
    setUploadFiles((known) => [...known, ...dropped])
    setUpload((now) => {
      const named = dropped.map((file) => ({ name: file.name, sizeBytes: file.size }))
      if (now) return { ...now, files: [...now.files, ...named] }
      const place = places?.find((one) => one.key === placeKey) ?? places?.[0]
      return {
        files: named,
        kind: (choices.kinds.includes('ATTACHMENT') ? 'ATTACHMENT' : choices.kinds[0]) as FileKind,
        audience: START_AUDIENCE as UploadAsk['audience'],
        kinds: choices.kinds,
        audiences: place?.audiences ?? choices.audiences,
        ...(places && place ? { places, place: place.key } : {}),
      }
    })
  }

  /**
   * F-OF-203: "Upload for this ask" — the same window, prefilled from the ask (where it lands, what it is, a measurement sheet, priced) with
   * the asker's words on top; once the files are in, `onDone` answers the ask with them. The place is the ask's own (one only).
   */
  const openForAsk = (input: { readonly place: UploadPlace; readonly kind: FileKind; readonly sheet: boolean; readonly priced: boolean; readonly forAsk: NonNullable<UploadAsk['forAsk']> }) => {
    const { choices } = latest.current
    setUploadFiles([])
    setUpload({
      files: [],
      kind: choices.kinds.includes(input.kind) ? input.kind : ((choices.kinds.includes('ATTACHMENT') ? 'ATTACHMENT' : choices.kinds[0]) as FileKind),
      audience: START_AUDIENCE as UploadAsk['audience'],
      kinds: choices.kinds,
      audiences: input.place.audiences,
      places: [input.place],
      place: input.place.key,
      ...(input.sheet ? { sheet: true } : {}),
      ...(input.priced ? { priced: true } : {}),
      forAsk: input.forAsk,
    })
  }

  /** The window's choices; another place offers its own audiences (a line's sharing waits for the read's `may`, B-OF-014). */
  const change = (next: Partial<Pick<UploadAsk, 'kind' | 'audience' | 'sheet' | 'priced' | 'place'>>) =>
    setUpload((now) => {
      if (!now) return now
      const merged: UploadAsk = { ...now, ...next }
      if (next.place === undefined || !now.places) return merged
      const audiences = now.places.find((one) => one.key === next.place)?.audiences ?? now.audiences
      return { ...merged, audiences, audience: audiences.includes(merged.audience) ? merged.audience : (START_AUDIENCE as UploadAsk['audience']) }
    })

  const cancel = () => {
    setUpload(null)
    setUploadFiles([])
  }

  // ---- moved from DockedOfficeThread (sendUploads), unchanged but for F5-B6 / F5-B7 and the place ----
  const sendUploads = async (ask: UploadAsk, dropped: readonly File[]) => {
    const { companyId, record, siteId, partyId } = latest.current
    const target = ask.places?.find((one) => one.key === ask.place)?.record ?? record
    if (!target) return
    setBusy(true)
    const failed: { name: string; reason: string }[] = []
    const held: string[] = []
    const added: string[] = [] // F-OF-203: the ids an ask's upload answers it with
    for (const file of dropped) {
      const contentType = contentTypeOf(file)
      const problem = uploadProblem({ name: file.name, type: contentType, size: file.size }, ask.kind)
      if (problem) {
        failed.push({ name: file.name, reason: tr(problem.key, problem.params) })
        continue
      }
      // B-TH-283 (B-TH-083): a measurement sheet is a PDF or a photo of one.
      if (ask.sheet && !takesSheet(contentType)) {
        failed.push({ name: file.name, reason: tv('upload.sheetType') })
        continue
      }
      try {
        const bytes = await file.arrayBuffer()
        const announced = await requestUpload(api, {
          companyId,
          record: target,
          kind: ask.kind,
          name: file.name,
          contentType,
          sizeBytes: file.size,
          sha256: await sha256Hex(bytes),
          visibility: ask.audience === 'OFFICE' ? ['OFFICE'] : ['OFFICE', ask.audience],
          floorSiteId: ask.audience === 'FLOOR' ? (siteId ?? null) : null,
          partyId: ask.audience === 'PARTNER' ? partyId : null,
          ...(ask.sheet ? { measurementSheet: true } : {}), // B-TH-283
          ...(ask.priced ? { priced: true } : {}), // F-CP-144: "This file shows prices"
        })
        await putToStore(announced.upload, new Blob([bytes], { type: contentType }))
        const done = await completeUpload(api, announced.file.id)
        // F-OF-103 (F5-B6): a file the store holds (the virus scan) is said, never silently gone.
        if (done.file.status !== 'AVAILABLE') held.push(file.name)
        added.push(done.file.id)
      } catch (error) {
        // F-OF-103 (F5-B7): why, in words — never only "did not finish".
        const refusal = uploadRefusalOf(error)
        failed.push({ name: file.name, reason: refusal.ns === 'records' ? tr(refusal.key, refusal.params) : tv(refusal.key, refusal.params) })
      }
    }
    setOutcome({ refused: failed, held })
    setUpload(null)
    setUploadFiles([])
    setBusy(false)
    latest.current.onDone?.({ fileIds: added, ask })
  }
  // ---- end moved

  return {
    /** The upload being asked (the window draws it), or null. */
    ask: upload,
    outcome,
    busy,
    open,
    openForAsk, // F-OF-203
    change,
    confirm: () => {
      if (upload && !busy) void sendUploads(upload, uploadFiles)
    },
    cancel,
    dismiss: () => setOutcome(NO_OUTCOME),
  }
}
