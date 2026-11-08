'use client'

import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { brandPortals, checkBranding } from '@nexus/ui/tokens/branding'
import type { PhotoMark } from '@nexus/ui/components/PhotoCapture/index'
import type { ApiClient } from '../../lib/api/client'
import { useLocale } from '../../lib/i18n/provider'
import { pictureAddress } from '../../lib/proofs/address'
import { LinkBrandingContext } from '../../shell/links/view/LinkFrameView'
import { answerLinkApproval, linkFileBytes, readLinkApproval, type ApprovalFile, type LinkDecision } from './api'
import { answerProblem, answerRefusal, isPdf, isPicture, markable, markupBodyOf, readRefusal, type ApproveViewModel, type MarkingState } from './model'
import { pdfPageImage, pictureSize } from './pdf-page'
import { ApproveView } from './view/ApproveView'

const START: ApproveViewModel = { link: 'valid', page: null, files: {}, open: null, decision: null, comment: '', markup: null, marking: null, answer: 'idle', problem: null, field: null }

/**
 * An APPROVAL link, once it opened (the link landing did `POST /link/open`): reads the request in the page's language
 * (`GET /link/approval`, again when the reader switches it), its photos and documents through the generic files route
 * (each read once; a picture kept as a data address so it outlives the store's 60-second address), and sends the ONE
 * answer with the typed name, the comment and an optional markup of one photo. The answer uses the link: the end is drawn
 * from the page the answer gives back (the link opens nothing afterwards). The tenant's colour goes on the page's
 * pop-ups too (brandPortals, D24). The token stays in the client's `x-factory-link` header.
 */
export function Approve({ api }: { api: ApiClient }) {
  const locale = useLocale()
  const [model, setModel] = useState<ApproveViewModel>(START)
  const latest = useRef(model)
  latest.current = model
  // Answered on this page: the link is used, so a language switch must not read it again (it would 404).
  const answered = useRef(false)
  const asked = useRef(new Set<string>())
  const pdfs = useRef(new Map<string, Uint8Array>())
  const [focus, setFocus] = useState<'decision' | 'comment' | null>(null)

  // D24: the sender's colour on the pop-ups (Mark the photo, the viewer), which the DS portals to <body>.
  const branding = useContext(LinkBrandingContext)
  useEffect(() => brandPortals(branding ? checkBranding(branding) : null), [branding])

  const readFile = useCallback(
    (file: ApprovalFile) => {
      if (asked.current.has(file.id) || (!isPicture(file.contentType) && !isPdf(file.contentType))) return
      asked.current.add(file.id)
      linkFileBytes(api, file.id)
        .then((bytes) => {
          if (isPdf(file.contentType)) pdfs.current.set(file.id, bytes.slice())
          const src = isPicture(file.contentType) ? pictureAddress(bytes, file.contentType) : bytes
          setModel((current) => ({ ...current, files: { ...current.files, [file.id]: { src, problem: false } } }))
        })
        .catch(() => {
          asked.current.delete(file.id)
          setModel((current) => ({ ...current, files: { ...current.files, [file.id]: { src: null, problem: true } } }))
        })
    },
    [api],
  )

  const load = useCallback(async () => {
    if (answered.current) return
    setModel((current) => (current.page ? current : { ...current, problem: null }))
    try {
      const page = await readLinkApproval(api, locale)
      if (answered.current) return
      setModel((current) => ({ ...current, link: 'valid', page, problem: current.answer === 'idle' && current.field === null ? null : current.problem }))
      for (const file of page.files) readFile(file)
    } catch (error) {
      const state = readRefusal(error)
      if (state === 'error') setModel((current) => (current.page ? current : { ...current, problem: 'problem.read' }))
      else setModel((current) => ({ ...current, link: state }))
    }
  }, [api, locale, readFile])

  useEffect(() => {
    void load()
  }, [load])

  // The page's own check moves the focus to what must be fixed (the decision, or the comment).
  useEffect(() => {
    if (!focus) return
    const target = focus === 'comment' ? document.getElementById('fw-ap-comment') : document.querySelector<HTMLInputElement>('input[name="fw-ap-decision"]')
    target?.focus()
    setFocus(null)
  }, [focus])

  const drawMarking = useCallback(
    async (file: ApprovalFile, target: 'picture' | 'pdf', pageNo: number) => {
      const done = (image: MarkingState['image'], pages: number | null = null) =>
        setModel((current) => (current.marking && current.marking.fileId === file.id && current.marking.page === pageNo ? { ...current, marking: { ...current.marking, image, pages: pages ?? current.marking.pages } } : current))
      try {
        if (target === 'picture') {
          const shown = latest.current.files[file.id]?.src
          const src = typeof shown === 'string' ? shown : pictureAddress(await linkFileBytes(api, file.id), file.contentType)
          done({ status: 'ready', src, ...(await pictureSize(src)) })
        } else {
          let bytes = pdfs.current.get(file.id)
          if (!bytes) {
            bytes = await linkFileBytes(api, file.id)
            pdfs.current.set(file.id, bytes.slice())
          }
          const drawn = await pdfPageImage(bytes, pageNo)
          done({ status: 'ready', src: drawn.src, width: drawn.width, height: drawn.height }, drawn.pages)
        }
      } catch {
        done({ status: 'failed' })
      }
    },
    [api],
  )

  const startMarking = (fileId: string, pageNo?: number) => {
    const file = latest.current.page?.files.find((item) => item.id === fileId)
    const target = file ? markable(file) : null
    if (!file || !target) return
    const draft = latest.current.markup?.fileId === fileId ? latest.current.markup : null
    const page = target === 'pdf' ? (pageNo ?? draft?.page ?? 1) : 1
    const marks: readonly PhotoMark[] = draft && (target === 'picture' || draft.page === page) ? draft.marks : []
    const note = latest.current.marking?.fileId === fileId ? latest.current.marking.note : (draft?.note ?? '')
    setModel((current) => ({ ...current, open: null, marking: { fileId, name: file.originalName, target, page, pages: current.marking?.fileId === fileId ? current.marking.pages : null, image: { status: 'loading' }, note, marks } }))
    void drawMarking(file, target, page)
  }

  return (
    <ApproveView
      model={model}
      actions={{
        onRetry: () => void load(),
        onDecision: (decision: LinkDecision) => setModel((current) => ({ ...current, decision, ...(current.field === 'decision' || current.field === 'comment' ? { problem: null, field: null } : {}) })),
        onComment: (comment) => setModel((current) => ({ ...current, comment, ...(current.field === 'comment' ? { problem: null, field: null } : {}) })),
        onSign: (typedName) => {
          const current = latest.current
          if (!current.page || current.answer === 'busy') return
          const problem = answerProblem(current.decision, current.comment)
          if (problem) {
            setModel((now) => ({ ...now, problem: problem.key, field: problem.field }))
            setFocus(problem.field)
            return
          }
          setModel((now) => ({ ...now, answer: 'busy', problem: null, field: null }))
          answerLinkApproval(api, { decision: current.decision!, answer: current.comment.trim() || null, typedName, markup: markupBodyOf(current.markup) }, locale)
            .then((page) => {
              answered.current = true
              setModel((now) => ({ ...now, page, answer: 'done', problem: null, field: null, marking: null, open: null }))
            })
            .catch((error: unknown) => {
              const refusal = answerRefusal(error)
              setModel((now) => ({ ...now, answer: 'idle', problem: refusal.key, field: null, ...(refusal.link ? { link: refusal.link } : {}) }))
              if (refusal.reload) void load()
            })
        },
        onOpen: (fileId) => setModel((current) => ({ ...current, open: fileId })),
        onRetryFile: (fileId) => {
          const file = latest.current.page?.files.find((item) => item.id === fileId)
          if (!file) return
          asked.current.delete(fileId)
          setModel((current) => {
            const files = { ...current.files }
            delete files[fileId]
            return { ...current, files }
          })
          readFile(file)
        },
        onMark: (fileId) => startMarking(fileId),
        onMarkPage: (page) => {
          const marking = latest.current.marking
          if (marking) startMarking(marking.fileId, page)
        },
        onMarkNote: (note) => setModel((current) => (current.marking ? { ...current, marking: { ...current.marking, note } } : current)),
        onMarkSave: (marks) =>
          setModel((current) =>
            current.marking ? { ...current, markup: { fileId: current.marking.fileId, page: current.marking.target === 'pdf' ? current.marking.page : null, marks: [...marks], note: current.marking.note }, marking: null } : current,
          ),
        onMarkClose: () => setModel((current) => ({ ...current, marking: null })),
        onMarkRemove: () => setModel((current) => ({ ...current, markup: null })),
      }}
    />
  )
}
