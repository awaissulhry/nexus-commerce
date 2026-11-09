'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../lib/api/client'
import { newIdempotencyKey } from '../../lib/api/client'
import { isApiError } from '../../lib/api/errors'
import { StoreError } from '../../record-panels/store'
import { WithMessages } from '../../record-panels/i18n'
import { confirmReceipt, downloadPayrollFile, downloadSetFile, presignedBytes, previewSetFile, readFileSet, readPayrollFiles, sendPassword, type Downloaded } from './api'
import {
  availableFiles,
  downloadAllHeld,
  downloadHeld,
  emptyModel,
  fileNameOf,
  isExpired,
  msUntil,
  pageOfPayroll,
  pageOfSet,
  passwordProblemOf,
  receiptHeld,
  stateOfReadError,
  unlockHeld,
  unlockPassed,
  usedUp,
  withUsesLeft,
  type DownloadState,
  type FileLinkViewModel,
  type FilePage,
  type PageFile,
} from './model'
import { FileLinkView } from './view/FileLinkView'

/**
 * Files by link, once the link opened (the landing did `POST /link/open`): `source="set"` reads a set of files
 * (`GET /link/files`: a SECURE_FILE — SCR-272 — or a DOCUMENT_VIEW of files — links.document's W2b parts), `source=
 * "payroll"` the payroll file (B-W2b-54's routes). It asks for the password when the sender set one (the unlock key
 * stays in this page's memory for its 30 minutes, then the form comes back), downloads one file or all of them (each its
 * own logged call and Idempotency-Key — kept for a retry after a lost answer, so a retry never uses the link twice; the
 * bytes go from the store's 60-second address straight to the browser's download), reads a shared PDF or picture in the
 * page, and sends the receipt. Every refusal says why in the page's words; a link that dies while open says so and
 * offers "Ask for a new link" (the frame's).
 */
export function FileLink({ api, source }: { api: ApiClient; source: 'set' | 'payroll' }) {
  return (
    <WithMessages namespaces={['link-files', 'ds-words']}>
      <FileLinkContainer api={api} source={source} />
    </WithMessages>
  )
}

const SLOW_MS = 1_000

/** Hands the bytes to the browser as a download under the file's own name (memory only; nothing kept). */
function saveBytes(data: Uint8Array, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([data.slice()], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const notFound = (error: unknown): boolean => isApiError(error) && error.kind === 'not_found'

function FileLinkContainer({ api, source }: { api: ApiClient; source: 'set' | 'payroll' }) {
  const [model, setModel] = useState<FileLinkViewModel>(emptyModel)
  const current = useRef(model)
  current.current = model
  // The unlock key of a right password and until when it opens the files (memory only).
  const unlock = useRef<string | null>(null)
  const [unlockedUntil, setUnlockedUntil] = useState<string | null>(null)
  // One Idempotency-Key per pressed download, kept until it is answered: a retry after a lost answer is the same use.
  const pending = useRef(new Map<string, string>())
  const receiptKey = useRef<string | null>(null)
  const passwordKey = useRef<string | null>(null)

  const setPage = useCallback((update: (page: FilePage) => FilePage) => setModel((state) => (state.page ? { ...state, page: update(state.page) } : state)), [])
  const setDownload = useCallback((fileId: string, value: DownloadState) => setModel((state) => ({ ...state, downloads: { ...state.downloads, [fileId]: value } })), [])

  const read = useCallback(async (): Promise<FilePage> => (source === 'payroll' ? pageOfPayroll(await readPayrollFiles(api)) : pageOfSet(await readFileSet(api, unlock.current))), [api, source])

  const load = useCallback(async () => {
    setModel((state) => ({ ...state, link: 'loading', slow: false }))
    try {
      const page = await read()
      setModel((state) => ({ ...state, page, link: isExpired(page.expiresAt, new Date()) ? 'expired' : 'valid', expiredAt: isExpired(page.expiresAt, new Date()) ? page.expiresAt : null }))
    } catch (error) {
      setModel((state) => ({ ...state, link: stateOfReadError(error) }))
    }
  }, [read])

  useEffect(() => {
    void load()
  }, [load])

  // "Still loading…" after about a second.
  useEffect(() => {
    if (model.link !== 'loading') return
    const timer = setTimeout(() => setModel((state) => (state.link === 'loading' ? { ...state, slow: true } : state)), SLOW_MS)
    return () => clearTimeout(timer)
  }, [model.link])

  // The expiry passing while the page is open turns it to "expired" at once.
  const expiresAt = model.page?.expiresAt ?? null
  useEffect(() => {
    if (!expiresAt || model.link !== 'valid') return
    let timer: ReturnType<typeof setTimeout>
    const arm = () => {
      timer = setTimeout(() => {
        if (msUntil(expiresAt, new Date()) > 0) arm()
        else setModel((state) => ({ ...state, link: 'expired', expiredAt: expiresAt, preview: null }))
      }, msUntil(expiresAt, new Date()))
    }
    arm()
    return () => clearTimeout(timer)
  }, [expiresAt, model.link])

  /** The 30 minutes passed (by the clock, or a call said so): the files close and the form comes back. */
  const relock = useCallback(() => {
    unlock.current = null
    setUnlockedUntil(null)
    setModel((state) => ({
      ...state,
      page: state.page ? { ...state.page, password: { ...state.page.password, unlocked: false }, files: [] } : state.page,
      preview: null,
      all: null,
      password: { value: '', shown: false, busy: false, problem: { kind: 'relock' } },
    }))
  }, [])

  useEffect(() => {
    if (!unlockedUntil) return
    const timer = setTimeout(relock, msUntil(unlockedUntil, new Date()))
    return () => clearTimeout(timer)
  }, [unlockedUntil, relock])

  // A hold read on arrival or answered by the API ends by itself: the form acts again (the view reads the clock).
  const holdUntil = model.password.problem?.kind === 'held' ? model.password.problem.until : (model.page?.password.heldUntil ?? null)
  const [, tick] = useState(0)
  useEffect(() => {
    if (!holdUntil) return
    const wait = msUntil(holdUntil, new Date())
    if (wait <= 0) return
    const timer = setTimeout(() => tick((n) => n + 1), wait + 50)
    return () => clearTimeout(timer)
  }, [holdUntil])

  /**
   * A refusal the whole page answers; false when it is the caller's. The unlock passed (403 at `password`): the form
   * comes back. A 404: the link's one answer when it died — or a file gone from the set; reading the page again tells
   * which (dead: the page's end; alive: the page as it stands now, and the caller marks its file).
   */
  const pageRefusal = useCallback(
    async (error: unknown): Promise<boolean> => {
      if (unlockPassed(error)) {
        relock()
        return true
      }
      if (!notFound(error)) return false
      try {
        const page = await read()
        setModel((state) => ({ ...state, page }))
        return false
      } catch (again) {
        if (!notFound(again)) return false
        setModel((state) => ({ ...state, link: state.page && usedUp(state.page) ? 'used' : 'unavailable', preview: null }))
        return true
      }
    },
    [read, relock],
  )

  /** One file: the logged download (a use where the link counts them), then its bytes to the browser. */
  const download = useCallback(
    async (file: PageFile): Promise<boolean> => {
      setDownload(file.id, 'busy')
      const key = pending.current.get(file.id) ?? newIdempotencyKey()
      pending.current.set(file.id, key)
      let answer: Downloaded
      try {
        answer = source === 'payroll' ? await downloadPayrollFile(api, file.id, key) : await downloadSetFile(api, file.id, unlock.current, key)
      } catch (error) {
        // A refusal used nothing: the next press is a new request. A lost answer keeps its key (the same use on retry).
        if (!isApiError(error) || error.kind !== 'unavailable') pending.current.delete(file.id)
        if (await pageRefusal(error)) return false
        setDownload(file.id, isApiError(error) && (error.kind === 'conflict' || error.kind === 'not_found') ? 'gone' : 'failed')
        return false
      }
      pending.current.delete(file.id)
      setPage((page) => withUsesLeft(page, answer.usesLeft))
      try {
        // The address lives 60 seconds: one more try at once if the store did not answer.
        const bytes = await presignedBytes(answer.download).catch((error: unknown) => (error instanceof StoreError || error instanceof TypeError ? presignedBytes(answer.download) : Promise.reject(error)))
        saveBytes(bytes, fileNameOf(file), file.contentType)
        setDownload(file.id, 'done')
        return true
      } catch {
        setDownload(file.id, 'failed')
        return false
      }
    },
    [api, source, pageRefusal, setDownload, setPage],
  )

  /** After a download: the page's own last use turns it to its "used" end. */
  const afterDownloads = useCallback(() => {
    setModel((state) => (state.page && usedUp(state.page) && state.link === 'valid' ? { ...state, link: 'used', preview: null } : state))
  }, [])

  return (
    <FileLinkView
      model={model}
      actions={{
        onPassword: (value) => setModel((state) => ({ ...state, password: { ...state.password, value, problem: state.password.problem?.kind === 'held' ? state.password.problem : null } })),
        onShowPassword: () => setModel((state) => ({ ...state, password: { ...state.password, shown: !state.password.shown } })),
        onUnlock: () => {
          const state = current.current
          if (!state.page) return
          if (state.password.value.length === 0) {
            setModel((now) => ({ ...now, password: { ...now.password, problem: { kind: 'empty' } } }))
            return
          }
          if (unlockHeld(state, state.page, new Date())) return
          const typed = state.password.value
          passwordKey.current = passwordKey.current ?? newIdempotencyKey()
          setModel((now) => ({ ...now, password: { ...now.password, busy: true, problem: null } }))
          sendPassword(api, typed, passwordKey.current)
            .then(async (answer) => {
              passwordKey.current = null
              unlock.current = answer.unlock
              setUnlockedUntil(answer.unlockedUntil)
              const page = await read()
              setModel((now) => ({ ...now, page, password: { value: '', shown: false, busy: false, problem: null } }))
            })
            .catch(async (error: unknown) => {
              if (!isApiError(error) || error.kind !== 'unavailable') passwordKey.current = null
              if (await pageRefusal(error)) return
              setModel((now) => ({ ...now, password: { ...now.password, busy: false, problem: passwordProblemOf(error, new Date()) } }))
            })
        },
        onDownload: (fileId) => {
          const state = current.current
          const file = state.page?.files.find((entry) => entry.id === fileId)
          if (!state.page || !file || !file.available || downloadHeld(state.page, state, fileId)) return
          void download(file).then(afterDownloads)
        },
        onDownloadAll: () => {
          const state = current.current
          if (!state.page || downloadAllHeld(state.page, state)) return
          const files = availableFiles(state.page)
          setModel((now) => ({ ...now, all: { busy: true, done: 0, of: files.length } }))
          void (async () => {
            let done = 0
            for (const file of files) {
              if (current.current.link !== 'valid') break
              if (await download(file)) done += 1
              setModel((now) => ({ ...now, all: { busy: true, done, of: files.length } }))
            }
            setModel((now) => ({ ...now, all: { busy: false, done, of: files.length } }))
            afterDownloads()
          })()
        },
        onPreview: (fileId) => {
          const state = current.current
          const file = state.page?.files.find((entry) => entry.id === fileId)
          if (!file || !file.preview || state.link !== 'valid') return
          setModel((now) => ({ ...now, preview: { fileId, state: 'loading', data: null, contentType: file.contentType } }))
          previewSetFile(api, fileId, unlock.current)
            .then(presignedBytes)
            .then((data) => setModel((now) => (now.preview?.fileId === fileId ? { ...now, preview: { fileId, state: 'ready', data, contentType: file.contentType } } : now)))
            .catch(async (error: unknown) => {
              if (await pageRefusal(error)) return
              setModel((now) => (now.preview?.fileId === fileId ? { ...now, preview: { fileId, state: 'failed', data: null, contentType: file.contentType } } : now))
            })
        },
        onClosePreview: () => setModel((now) => ({ ...now, preview: null })),
        onGoTo: (fileId) => setModel((now) => ({ ...now, focus: fileId })),
        onReceiptName: (value) => setModel((now) => ({ ...now, receipt: { ...now.receipt, name: value, failed: false } })),
        onReceipt: () => {
          const state = current.current
          if (!state.page || receiptHeld(state, state.page)) return
          const name = state.receipt.name.trim()
          receiptKey.current = receiptKey.current ?? newIdempotencyKey()
          setModel((now) => ({ ...now, receipt: { ...now.receipt, busy: true, failed: false } }))
          confirmReceipt(api, name === '' ? null : name, unlock.current, receiptKey.current)
            .then((receipt) => {
              receiptKey.current = null
              setModel((now) => ({ ...now, receipt: { name: '', busy: false, failed: false, confirmedHere: true }, page: now.page ? { ...now.page, receipt: { ...now.page.receipt, at: receipt.at, name: receipt.name } } : now.page }))
            })
            .catch(async (error: unknown) => {
              if (!isApiError(error) || error.kind !== 'unavailable') receiptKey.current = null
              if (await pageRefusal(error)) return
              if (isApiError(error) && error.kind === 'conflict') {
                // Confirmed already (another tab, or an answer lost on the way): the page reads where it stands.
                const page = await read().catch(() => null)
                setModel((now) => ({ ...now, receipt: { ...now.receipt, busy: false }, page: page ?? now.page }))
                return
              }
              setModel((now) => ({ ...now, receipt: { ...now.receipt, busy: false, failed: true } }))
            })
        },
        onRetry: () => void load(),
      }}
    />
  )
}
