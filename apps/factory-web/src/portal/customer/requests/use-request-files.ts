'use client'

import { useCallback, useRef, useState } from 'react'
import type { ApiClient } from '../../../lib/api/client'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { holdFiles, retryCarry, stateAfterUpload, toAttach, toUpload, type HeldFile } from '../../../lib/request-compose/files'
import { putToStore, sha256Hex, StoreError } from '../../../record-panels/store'
import { announceFile, attachFiles, completeFile, type FileDoor } from './api'

/**
 * B-TH-282 (B-TH-085) — the customer's files as the portal sends them, one container hook for New order (held until Send, then
 * onto the new request) and the request page's "Add files" (sent at once): each file announced, its bytes PUT to the store,
 * completed — sent, or held for the virus scan —, then ONE message of the customer carries the sent ones into the request's
 * thread. A refusal keeps the API's own words (in the person's language: "Your access does not let you send files…", "This
 * already holds 50 of your files…", the scanner's sentence); Retry sends only what did not go, and carries again what arrived but
 * was not carried (never twice). Nothing names a party or a company: the session's (W11, W25, W37).
 */
export interface RequestFiles {
  readonly held: readonly HeldFile[]
  readonly leftOut: number
  add: (files: File[]) => void
  sheet: (key: string, on: boolean) => void
  remove: (key: string) => void
  clear: () => void
  /** Upload what waits (or failed) onto the request `id` through its door, then carry the sent files into its thread. */
  send: (id: string, door: FileDoor) => Promise<void>
}

export function useRequestFiles(api: ApiClient, words: { network: string; store: string; refused: string }): RequestFiles {
  const [held, setHeld] = useState<HeldFile[]>([])
  const [leftOut, setLeftOut] = useState(0)
  const files = useRef(new Map<string, File>())
  const latest = useRef<HeldFile[]>([])
  const carried = useRef(new Set<string>())
  const busy = useRef(false)
  const update = useCallback((next: (current: HeldFile[]) => HeldFile[]) => {
    setHeld((current) => {
      const value = next(current)
      latest.current = value
      return value
    })
  }, [])
  const patch = useCallback((key: string, change: Partial<HeldFile>) => update((current) => current.map((file) => (file.key === key ? { ...file, ...change } : file))), [update])

  const add = useCallback(
    (dropped: File[]) => {
      const keys = dropped.map(() => `pf-${newIdempotencyKey()}`)
      const result = holdFiles(latest.current, dropped.map((file) => ({ name: file.name || 'Pasted image.png', type: file.type, size: file.size })), (index) => keys[index]!)
      for (const file of result.held) {
        const index = keys.indexOf(file.key)
        if (index >= 0) files.current.set(file.key, dropped[index]!)
      }
      setLeftOut(result.leftOut)
      update(() => result.held)
    },
    [update],
  )

  const failureOf = useCallback(
    (error: unknown): string => {
      if (error instanceof StoreError) return words.store
      if (!isApiError(error)) return words.network
      // The API's own words, in the person's language (a refusal at refusal/<CODE>, the outside uploads' sentence).
      const refusal = error.issues.find((issue) => issuePath(issue).replace(/\./g, '/').startsWith('refusal/'))
      if (refusal?.message) return refusal.message
      if (error.kind === 'unavailable' && error.message) return error.message
      return error.kind === 'invalid' || error.kind === 'conflict' || error.kind === 'forbidden' ? (error.issues[0]?.message ?? words.refused) : words.network
    },
    [words],
  )

  const send = useCallback(
    async (id: string, door: FileDoor) => {
      if (busy.current) return
      busy.current = true
      try {
        update((current) => retryCarry(current))
        for (const row of toUpload(latest.current)) {
          const file = files.current.get(row.key)
          if (!file) continue
          patch(row.key, { state: 'uploading', failure: undefined })
          try {
            const bytes = await file.arrayBuffer()
            const { file: announced, upload } = await announceFile(api, door, id, { originalName: row.name, contentType: row.contentType, sizeBytes: row.sizeBytes, sha256: await sha256Hex(bytes), ...(row.sheet ? { measurementSheet: true } : {}) })
            await putToStore(upload, new Blob([bytes], { type: row.contentType }))
            const done = await completeFile(api, door, id, announced.id)
            patch(row.key, { state: stateAfterUpload(done.status), fileId: done.id, uploaded: true })
          } catch (error) {
            patch(row.key, { state: 'failed', failure: failureOf(error) })
          }
        }
        const ids = toAttach(latest.current, carried.current)
        if (ids.length > 0) {
          try {
            await attachFiles(api, door, id, ids)
            ids.forEach((fileId) => carried.current.add(fileId))
          } catch (error) {
            const why = failureOf(error)
            update((current) => current.map((file): HeldFile => (file.fileId && ids.includes(file.fileId) ? { ...file, state: 'failed', failure: why } : file)))
          }
        }
      } finally {
        busy.current = false
      }
    },
    [api, update, patch, failureOf],
  )

  return {
    held,
    leftOut,
    add,
    sheet: (key, on) => patch(key, { sheet: on }),
    remove: (key) => {
      files.current.delete(key)
      update((current) => current.filter((file) => file.key !== key))
    },
    clear: () => {
      files.current.clear()
      carried.current.clear()
      setLeftOut(0)
      update(() => [])
    },
    send,
  }
}
