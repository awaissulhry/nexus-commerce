'use client'

import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { brandPortals, checkBranding } from '@nexus/ui/tokens/branding'
import { newIdempotencyKey, type ApiClient } from '../../lib/api/client'
import { useLocale } from '../../lib/i18n/provider'
import { LinkBrandingContext } from '../../shell/links/view/LinkFrameView'
import { postShareMessage, readLinkShare, readOlderMessages, setShareNotify, shareFileBytes, uploadShareFile } from './api'
import { pickedProblem, readRefusal, START, writeRefusal, type InviteViewModel } from './model'
import { InviteView } from './view/InviteView'

/** How often an open page reads the record again ("New message or file → the thread updates while open"). */
const REFRESH_MS = 30_000

/**
 * A RECORD_INVITE link, once it opened (the link landing did `POST /link/open`): reads the shared record in the page's
 * language (`GET /link/share`, again when the reader switches it, every 30 s while the page is in view, and after each post
 * or upload), keeps the message being written and the shared files ticked to go with it, posts them under one
 * Idempotency-Key per text and files, loads earlier messages, switches
 * "E-mail me", uploads files one by one (announce, the bytes to the store, complete) and opens a shared file in a new tab
 * (its bytes read once through the generic files route). A share revoked or ended meanwhile opens nothing: the page turns
 * into the frame's dead link. The tenant's colour goes on the page's pop-ups too (brandPortals, D24). The token stays in the
 * client's `x-factory-link` header.
 */
export function InviteLink({ api }: { api: ApiClient }) {
  const locale = useLocale()
  const [model, setModel] = useState<InviteViewModel>(() => ({ ...START, now: Date.now() }))
  const latest = useRef(model)
  latest.current = model
  const postKey = useRef<{ body: string; key: string } | null>(null)

  const branding = useContext(LinkBrandingContext)
  useEffect(() => brandPortals(branding ? checkBranding(branding) : null), [branding])

  const load = useCallback(async () => {
    try {
      const page = await readLinkShare(api, locale)
      setModel((current) => ({ ...current, link: 'valid', page, problem: null, now: Date.now(), cursor: current.older.length > 0 ? current.cursor : page.thread.nextCursor }))
    } catch (error) {
      const state = readRefusal(error)
      if (state === 'error') setModel((current) => (current.page ? current : { ...current, problem: 'problem.read' }))
      else setModel((current) => ({ ...current, link: state }))
    }
  }, [api, locale])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && latest.current.link === 'valid' && latest.current.page) void load()
    }, REFRESH_MS)
    return () => clearInterval(timer)
  }, [load])

  const post = async () => {
    const current = latest.current
    const body = current.draft.trim()
    // Only files the page still shows go (a file the office stopped sharing meanwhile is dropped).
    const attached = current.attached.filter((fileId) => current.page?.files.some((file) => file.id === fileId))
    if (!current.page || current.posting || (body === '' && attached.length === 0) || !current.page.thread.canPost) return
    const text = JSON.stringify([body, attached])
    if (postKey.current?.body !== text) postKey.current = { body: text, key: newIdempotencyKey() }
    setModel((now) => ({ ...now, posting: true, postProblem: null }))
    try {
      await postShareMessage(api, body, attached, postKey.current.key)
      postKey.current = null
      setModel((now) => ({ ...now, posting: false, draft: '', attached: [] }))
      await load()
    } catch (error) {
      const refusal = writeRefusal(error)
      setModel((now) => ({ ...now, posting: false, postProblem: refusal.words, ...(refusal.link ? { link: refusal.link } : {}) }))
      if (refusal.reload) void load()
    }
  }

  const more = async () => {
    const cursor = latest.current.cursor
    if (!cursor || latest.current.moreBusy) return
    setModel((now) => ({ ...now, moreBusy: true }))
    try {
      const page = await readOlderMessages(api, cursor)
      setModel((now) => ({ ...now, moreBusy: false, older: [...now.older, ...page.messages], cursor: page.nextCursor }))
    } catch (error) {
      const refusal = writeRefusal(error)
      setModel((now) => ({ ...now, moreBusy: false, postProblem: refusal.words, ...(refusal.link ? { link: refusal.link } : {}) }))
    }
  }

  const notify = async (on: boolean) => {
    const current = latest.current
    if (!current.page || current.notifyBusy) return
    setModel((now) => ({ ...now, notifyBusy: true, notifyProblem: null }))
    try {
      const answer = await setShareNotify(api, on, newIdempotencyKey())
      setModel((now) => ({ ...now, notifyBusy: false, page: now.page ? { ...now.page, share: { ...now.page.share, notifyByEmail: answer.notifyByEmail, version: answer.version } } : now.page }))
    } catch (error) {
      const refusal = writeRefusal(error)
      setModel((now) => ({ ...now, notifyBusy: false, notifyProblem: refusal.words, ...(refusal.link ? { link: refusal.link } : {}) }))
      if (refusal.reload) void load()
    }
  }

  const upload = async (files: File[]) => {
    const current = latest.current
    if (!current.page || current.upload.busy || files.length === 0) return
    for (const file of files) {
      const problem = pickedProblem(file, current.page)
      if (problem) {
        setModel((now) => ({ ...now, upload: { busy: false, name: file.name, problem, done: null } }))
        return
      }
    }
    for (const file of files) {
      setModel((now) => ({ ...now, upload: { busy: true, name: file.name, problem: null, done: null } }))
      try {
        const done = await uploadShareFile(api, file, { announce: newIdempotencyKey(), complete: newIdempotencyKey() })
        setModel((now) => ({ ...now, upload: { busy: false, name: file.name, problem: null, done: { key: done.status === 'AVAILABLE' ? 'files.uploaded' : 'files.checking', params: { name: file.name } } } }))
      } catch (error) {
        const refusal = writeRefusal(error)
        setModel((now) => ({ ...now, upload: { busy: false, name: file.name, problem: refusal.words, done: null }, ...(refusal.link ? { link: refusal.link } : {}) }))
        if (refusal.reload) void load()
        return
      }
    }
    await load()
  }

  const open = async (fileId: string) => {
    const current = latest.current
    const file = current.page?.files.find((item) => item.id === fileId)
    if (!file || current.opening) return
    // The new tab is opened at once (a browser lets a click open one), then given the file when it is read.
    const tab = window.open('', '_blank')
    setModel((now) => ({ ...now, opening: fileId, fileProblem: null }))
    try {
      const bytes = await shareFileBytes(api, fileId)
      const url = URL.createObjectURL(new Blob([bytes.slice()], { type: file.contentType || 'application/octet-stream' }))
      if (tab) tab.location.href = url
      else {
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = file.originalName
        anchor.click()
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      setModel((now) => ({ ...now, opening: null }))
    } catch (error) {
      tab?.close()
      const refusal = writeRefusal(error)
      setModel((now) => ({ ...now, opening: null, fileProblem: { key: 'files.problem.open' }, ...(refusal.link ? { link: refusal.link } : {}) }))
    }
  }

  return (
    <InviteView
      model={model}
      actions={{
        onRetry: () => {
          setModel((now) => ({ ...now, problem: null }))
          void load()
        },
        onDraft: (value) => setModel((now) => ({ ...now, draft: value, postProblem: null })),
        onAttach: (ids) => setModel((now) => ({ ...now, attached: ids, postProblem: null })),
        onPost: () => void post(),
        onMore: () => void more(),
        onNotify: (on) => void notify(on),
        onFiles: (files) => void upload(files),
        onOpenFile: (fileId) => void open(fileId),
        onDismiss: (what) =>
          setModel((now) =>
            what === 'post' ? { ...now, postProblem: null } : what === 'notify' ? { ...now, notifyProblem: null } : what === 'upload' ? { ...now, upload: { ...now.upload, problem: null, done: null } } : { ...now, fileProblem: null },
          ),
      }}
    />
  )
}
