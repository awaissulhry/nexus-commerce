'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { readPublicDocCode } from '@nexus/factory-domain/compliance/public-doc/code'
import { brandPortals, checkBranding } from '@nexus/ui/tokens/branding'
import { browserApi } from '../../lib/api/browser'
import { isApiError } from '../../lib/api/errors'
import { useLocale } from '../../lib/i18n/provider'
import { lookupPublicDoc, publicDocFileBytes } from './api'
import { chooseLanguage, codeProblem, EMPTY_LOOKUP, fileIn, frameSender, lookupRefusal, readerLanguages, waitParts, type LookupModel, type PublicDocViewModel } from './model'
import { PublicDocView } from './view/PublicDocView'
// B-W2b-357 (links.doc › sec:report): the public safety report's container.
import { usePublicReport } from './report/use-report'

const SLOW_MS = 1_000

/**
 * `/doc/<code>` and `/doc` (B-W2b-166, SCR-102): the public DoC page for anyone — no session, no token. With a code (the
 * QR's address, or one typed under Type the code) it asks the API for the page (`POST /public/doc/lookup`: the abuse
 * guard may ask the device for a short check first, which `lookupPublicDoc` solves once), reads the declaration in the
 * reader's language into the page's viewer, and keeps every published language, the leaflet and the older versions one
 * click away (each the API's permanent PDF address). A code the API does not know turns the page into Type the code with
 * "We could not find this code"; a 429 holds the button with the wait in words. The sender's colour goes on the page's
 * pop-ups too (brandPortals, D24). Nothing is kept in the browser.
 */
export function PublicDoc({ code }: { code: string | null }) {
  const locale = useLocale()
  const router = useRouter()
  const api = useMemo(() => browserApi(), [])
  const chain = useMemo(() => readerLanguages(typeof navigator === 'undefined' ? [] : [...navigator.languages], locale), [locale])
  const read = code ? readPublicDocCode(code) : null
  const [model, setModel] = useState<PublicDocViewModel>(() => ({
    kind: read ? 'loading' : 'lookup',
    sender: null,
    slow: false,
    page: null,
    readerLanguages: chain,
    language: null,
    pdf: null,
    lookup: code && !read ? { ...EMPTY_LOOKUP, text: code, problem: 'format' } : EMPTY_LOOKUP,
  }))
  const latest = useRef(model)
  latest.current = model
  const bytes = useRef(new Map<string, Uint8Array>())
  const [waitUntil, setWaitUntil] = useState<number | null>(null)
  const [n, setN] = useState(0)

  useEffect(() => setModel((current) => ({ ...current, readerLanguages: chain })), [chain])

  // D24: the sender's colour on the pop-ups (the language list), which the DS portals to <body>.
  useEffect(() => brandPortals(model.sender ? checkBranding(model.sender) : null), [model.sender])

  const readPdf = useCallback(
    (path: string, fileId: string) => {
      const kept = bytes.current.get(fileId)
      setModel((current) => ({ ...current, pdf: { fileId, state: kept ? 'ready' : 'loading', data: kept ?? null } }))
      if (kept) return
      publicDocFileBytes(api, path, fileId)
        .then((data) => {
          bytes.current.set(fileId, data)
          setModel((current) => (current.pdf?.fileId === fileId ? { ...current, pdf: { fileId, state: 'ready', data } } : current))
        })
        .catch(() => setModel((current) => (current.pdf?.fileId === fileId ? { ...current, pdf: { fileId, state: 'failed', data: null } } : current)))
    },
    [api],
  )

  const load = useCallback(
    async (wanted: string, pick: number) => {
      setModel((current) => ({ ...current, kind: 'loading', slow: false, lookup: { ...current.lookup, busy: true, problem: null } }))
      let challenged = false
      try {
        const page = await lookupPublicDoc(api, wanted, {
          n: pick,
          onChecking: () => {
            challenged = true
            setModel((current) => ({ ...current, lookup: { ...current.lookup, checking: true } }))
          },
        })
        const language = page.declaration ? chooseLanguage(page.declaration.files, latest.current.readerLanguages) : null
        setModel((current) => ({ ...current, kind: 'found', page, sender: frameSender(page), language, lookup: EMPTY_LOOKUP }))
        // The address says the code as the API reads it (a typed or lower-case code becomes the printed one).
        if (typeof window !== 'undefined' && window.location.pathname !== `/doc/${page.path}`) window.history.replaceState(null, '', `/doc/${page.path}`)
        const shown = page.declaration ? fileIn(page.declaration.files, language) : null
        if (shown) readPdf(page.path, shown.fileId)
      } catch (error) {
        const refusal = isApiError(error) ? lookupRefusal(error, challenged) : ({ kind: 'error' } as const)
        if (refusal.kind === 'error') {
          setModel((current) => ({ ...current, kind: 'error', lookup: { ...current.lookup, busy: false, checking: false } }))
          return
        }
        if (refusal.waitMs) setWaitUntil(Date.now() + refusal.waitMs)
        setModel((current) => ({
          ...current,
          kind: 'lookup',
          page: null,
          sender: null,
          pdf: null,
          lookup: { text: current.lookup.text || wanted, problem: refusal.problem, wait: refusal.waitMs ? waitParts(refusal.waitMs) : null, busy: false, checking: false },
        }))
      }
    },
    [api, readPdf],
  )

  useEffect(() => {
    if (read) void load(read, n)
  }, [read, n, load])

  // "Still loading…" after about a second.
  useEffect(() => {
    if (model.kind !== 'loading') return
    const timer = setTimeout(() => setModel((current) => (current.kind === 'loading' ? { ...current, slow: true } : current)), SLOW_MS)
    return () => clearTimeout(timer)
  }, [model.kind])

  // The wait counts down on the held button's banner, then lets go.
  useEffect(() => {
    if (waitUntil === null) return
    const tick = () => {
      const left = waitUntil - Date.now()
      if (left <= 0) {
        setWaitUntil(null)
        setModel((current) => ({ ...current, lookup: { ...current.lookup, wait: null } }))
      } else setModel((current) => ({ ...current, lookup: { ...current.lookup, wait: waitParts(left) } }))
    }
    tick()
    const timer = setInterval(tick, 1_000)
    return () => clearInterval(timer)
  }, [waitUntil])

  // B-W2b-357: Report a problem, once a page is found.
  const report = usePublicReport(api, model.kind === 'found' ? model.page : null)

  const setLookup = (change: Partial<LookupModel>) => setModel((current) => ({ ...current, lookup: { ...current.lookup, ...change } }))

  return (
    <PublicDocView
      model={{ ...model, report: report.model }}
      actions={{
        report: report.actions,
        onLanguage: (language) => {
          const page = latest.current.page
          setModel((current) => ({ ...current, language }))
          const file = page?.declaration ? fileIn(page.declaration.files, language) : null
          if (page && file) readPdf(page.path, file.fileId)
        },
        onRetry: () => {
          if (read) void load(read, n)
        },
        onRetryPdf: () => {
          const current = latest.current
          if (current.page && current.pdf) readPdf(current.page.path, current.pdf.fileId)
        },
        onLookupText: (text) => setLookup({ text, problem: null }),
        onLookupSubmit: () => {
          const current = latest.current.lookup
          if (current.wait || current.busy) return
          const problem = codeProblem(current.text)
          if (problem) return setLookup({ problem })
          const typed = readPublicDocCode(current.text)!
          setN(0)
          // The same code again (after a miss or a wait): ask again here; another code is its own address.
          if (typed === read) void load(typed, 0)
          else router.push(`/doc/${typed}`)
        },
        onPick: (pick) => setN(pick),
      }}
    />
  )
}
