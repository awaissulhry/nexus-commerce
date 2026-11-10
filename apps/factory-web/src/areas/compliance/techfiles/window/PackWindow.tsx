'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { companyPrefix } from '../../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { liveMatches, useLive } from '../../../quality/_shared/hooks'
import { packBytes, readFile, readPack, type FileSummary, type Pack } from '../api'
import { failed, LOADING, problemOf, ready, techfilesCan, valueOf, type Read } from '../model'
import { PackWindowView } from './view/PackWindowView'

/** Saves bytes as a file on this device (a Blob link, clicked once). */
function save(bytes: Uint8Array, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * `/w/<company>/compliance/techfiles/pack?pack=<id>` (SCR-326, a window page; design tab:tf-pack-pdf): reads the pack, its file
 * (for the title) and, once BUILT, the PDF's bytes into the viewer; a pack still building is read again on its live event.
 * Download PDF / ZIP read the bytes the same way (the store's address lives 60 seconds).
 */
export function PackWindow() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const prefix = companyPrefix(session.company?.code ?? '')
  const can = useMemo(() => techfilesCan(session.permissions), [session.permissions])
  const packId = params?.get('pack') ?? ''
  const [pack, setPack] = useState<Read<Pack>>(LOADING)
  const [file, setFile] = useState<Read<Pick<FileSummary, 'id' | 'number' | 'style'>> | null>(null)
  const [pdf, setPdf] = useState<Read<Uint8Array> | null>(null)
  const [downloading, setDownloading] = useState<'PDF' | 'ZIP' | null>(null)
  const [attempt, setAttempt] = useState(0)

  const read = useCallback(() => {
    if (!packId || !can.view) return setPack(failed(packId ? 'problem.forbidden' : 'problem.notFound'))
    readPack(api, packId).then(
      (value) => setPack(ready(value)),
      (error) => setPack(failed(problemOf(error))),
    )
  }, [api, packId, can.view])

  useEffect(() => {
    setPack(LOADING)
    read()
  }, [read, attempt])

  const value = valueOf(pack)
  const fileId = value?.technicalFileId ?? null
  useEffect(() => {
    if (!fileId) return
    readFile(api, fileId).then(
      (answer) => setFile(ready(answer.file)),
      (error) => setFile(failed(problemOf(error))),
    )
  }, [api, fileId])

  const built = value?.status === 'BUILT' && value.pdf !== null
  useEffect(() => {
    if (!built) return setPdf(null)
    const controller = new AbortController()
    setPdf(LOADING)
    packBytes(api, packId, 'PDF', controller.signal).then(
      (answer) => setPdf(ready(answer.bytes)),
      (error) => !controller.signal.aborted && setPdf(failed(problemOf(error))),
    )
    return () => controller.abort()
  }, [api, packId, built, attempt])

  useLive(
    (change) => {
      if (liveMatches(change, ['technical_file.pack_changed']) && change.fields.packId === packId) read()
    },
    read,
  )

  return (
    <PackWindowView
      model={{ prefix, canView: can.view, pack, file, pdf, downloading }}
      actions={{
        onRetry: () => setAttempt((n) => n + 1),
        onDownload: (kind) => {
          setDownloading(kind)
          packBytes(api, packId, kind).then(
            (answer) => {
              save(answer.bytes, answer.fileName, kind === 'PDF' ? 'application/pdf' : 'application/zip')
              setDownloading(null)
            },
            () => setDownloading(null),
          )
        },
      }}
    />
  )
}
