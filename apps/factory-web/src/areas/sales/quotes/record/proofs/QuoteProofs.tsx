'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { isApiError } from '../../../../../lib/api/errors'
import type { ApiClient } from '../../../../../lib/api/client'
import { pictureAddress } from '../../../../../lib/proofs/address'
import { useLiveChanges } from '../../../../../record-panels/live'
import { putToStore, readFromStore, sha256Hex } from '../../../../../record-panels/store'
import { announceProof, carryProofs, completeProof, previewProof, readProofs, removeProof, type QuoteProofs as Proofs } from './api'
import { currentOf, fileProblem, type ProofsPanelModel } from './model'
import { ProofsPanel } from './view/ProofsPanel'

/**
 * The Proofs panel's container (SCR-035-proofs; B-W2b-165): reads the quote's proofs (GET /sales/quotes/:id/proofs) and
 * does what the panel asks — one upload at a time (read, hash, announce, PUT to the store, confirm), a new version, a
 * removal after the person's yes, a carry-over; opens a proof through the files preview (its bytes read once). A change
 * by anyone (quote.proofs_changed, a send that froze them) reads them again. A refusal is said in the panel's words; a
 * conflict reads the proofs again and says so.
 */
export function QuoteProofs({ api, quoteId }: { api: ApiClient; quoteId: string }) {
  const [model, setModel] = useState<ProofsPanelModel>({ state: 'loading', data: null, busy: null, problem: null, notice: null, open: null, shown: {}, confirmRemove: null })
  const reading = useRef(new Set<string>())

  const load = useCallback(async () => {
    try {
      const data = await readProofs(api, quoteId)
      setModel((current) => ({ ...current, state: 'ready', data }))
    } catch {
      setModel((current) => ({ ...current, state: current.data ? 'ready' : 'error' }))
    }
  }, [api, quoteId])

  useEffect(() => {
    void load()
  }, [load])

  useLiveChanges({
    onChange: (change) => {
      if (change.fields.quoteId === quoteId) void load()
    },
    onReconnect: () => void load(),
  })

  const done = (data: Proofs, notice: ProofsPanelModel['notice']) => setModel((current) => ({ ...current, data, busy: null, problem: null, notice, confirmRemove: null }))
  const failed = (error: unknown, name: string) => {
    const conflict = isApiError(error) && error.kind === 'conflict'
    setModel((current) => ({ ...current, busy: null, confirmRemove: null, notice: null, problem: conflict ? { key: 'office.notice.conflict' } : { key: 'office.upload.failed', params: { name } } }))
    if (conflict) void load()
  }

  /** One file: read, hash, announce (a new proof, or the next version of `of`), PUT, confirm. */
  const upload = async (file: File, of?: string) => {
    const proof = of ? currentOf(model.data)?.proofs.find((entry) => entry.fileId === of) : undefined
    const problem = fileProblem(file, proof)
    if (problem) {
      setModel((current) => ({ ...current, problem, notice: null }))
      return
    }
    setModel((current) => ({ ...current, busy: { name: file.name, step: 'reading' }, problem: null, notice: null }))
    try {
      const bytes = await file.arrayBuffer()
      const sha256 = await sha256Hex(bytes)
      const { file: announced, upload: put } = await announceProof(api, quoteId, { originalName: file.name, contentType: file.type, sizeBytes: file.size, sha256 }, of)
      setModel((current) => ({ ...current, busy: { name: file.name, step: 'sending' } }))
      await putToStore(put, bytes)
      done(await completeProof(api, quoteId, announced.id), { key: 'office.notice.added', params: { name: file.name } })
    } catch (error) {
      failed(error, file.name)
    }
  }

  /** A proof's bytes for the viewer, read once: a picture as an address, a PDF as its bytes. */
  const read = (fileId: string) => {
    if (reading.current.has(fileId)) return
    const proof = model.data?.versions.flatMap((version) => version.proofs).find((entry) => entry.currentFileId === fileId)
    if (!proof) return
    reading.current.add(fileId)
    previewProof(api, fileId)
      .then(({ preview }) => readFromStore(preview))
      .then((bytes) => setModel((current) => ({ ...current, shown: { ...current.shown, [fileId]: { src: proof.shape === 'PICTURE' ? pictureAddress(bytes, proof.contentType) : bytes, problem: false } } })))
      .catch(() => {
        reading.current.delete(fileId)
        setModel((current) => ({ ...current, shown: { ...current.shown, [fileId]: { src: null, problem: true } } }))
      })
  }

  return (
    <ProofsPanel
      model={model}
      actions={{
        onRetry: () => {
          setModel((current) => ({ ...current, state: 'loading' }))
          void load()
        },
        onFiles: (files) => {
          void (async () => {
            for (const file of files) await upload(file)
          })()
        },
        onNewVersion: (fileId, file) => void upload(file, fileId),
        onRemove: (fileId) => setModel((current) => ({ ...current, confirmRemove: fileId })),
        onRemoveConfirm: (fileId) => {
          const name = currentOf(model.data)?.proofs.find((entry) => entry.fileId === fileId)?.name ?? ''
          setModel((current) => ({ ...current, busy: { name, step: 'sending' } }))
          removeProof(api, quoteId, fileId)
            .then((data) => done(data, { key: 'office.notice.removed', params: { name } }))
            .catch((error: unknown) => failed(error, name))
        },
        onCarry: () => {
          const carry = model.data?.carry
          if (!carry) return
          setModel((current) => ({ ...current, busy: { name: '', step: 'sending' } }))
          carryProofs(api, quoteId, carry.fromVersionId)
            .then((data) => done(data, { key: 'office.notice.carried', params: { count: carry.count } }))
            .catch((error: unknown) => failed(error, ''))
        },
        onOpen: (fileId) => {
          setModel((current) => ({ ...current, open: fileId }))
          if (fileId) read(fileId)
        },
        onOpenRetry: (fileId) => {
          setModel((current) => {
            const shown = { ...current.shown }
            delete shown[fileId]
            return { ...current, shown }
          })
          read(fileId)
        },
        onDismiss: () => setModel((current) => ({ ...current, problem: null, notice: null })),
      }}
    />
  )
}
