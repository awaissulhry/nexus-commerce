'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useT } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { downloadLink } from '../../../../record-panels/api'
import { WithMessages } from '../../../../record-panels/i18n'
import { useLiveChanges } from '../../../../record-panels/live'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import { storeUrl } from '../../../../record-panels/store'
import type { DocumentSendModel } from '../../../_shared/document-send/model'
import { parseCc } from '../../../_shared/document-send/model'
import { isApiError } from '../../../../lib/api/errors'
import {
  addLine,
  approveQuote,
  askApproval,
  cancelQuote,
  editLine,
  findStyles,
  getParty,
  getQuote,
  getStyle,
  listApprovals,
  listVersions,
  previewBytes,
  previewHref,
  rejectQuote,
  removeLine,
  reopen,
  reviseQuote,
  sendCheck,
  sendNewLink,
  sendQuote,
  updateQuote,
  type QuoteDetail,
  type StyleDetail,
} from '../api'
import { listPaymentTerms, type PaymentTermsRow } from '../../customers/terms/api'
import { useDuplicate } from '../duplicate/use-duplicate'
import { abilitiesOf, grainsOf, lineWrites, parsePrice, romeToday, tabOf, type QuoteTab } from '../model'
import { readProblem, writeProblem } from '../problems'
import type { ComposerState, Loaded, QuoteDialog, QuoteNotice, QuoteRecordViewModel, SaveState } from './record-model'
import { sendItems } from './send-model'
import { QuoteRecordView } from './view/QuoteRecordView'

const WIDE = '(min-width: 1280px)'
const DOCK_KEY = 'fw.sales.dock.Quote'
const SAVE_DELAY_MS = 700
const NO_COMPOSER: ComposerState = { query: '', results: null, problem: null, chosen: null, picked: [] }

/**
 * `/w/<company>/sales/quotes/<id>` (SCR-035): loads the quote (quotes.view; the API checks the company and customer and
 * drops the money the person's grains do not reach), its styles, versions, approval rounds and customer, and does what
 * the view asks — one write at a time, each with the quote's version as read (a 409 reads it again and says so, never
 * overwrites). A typed size grid is saved shortly after the typing stops, block by block: a colourway that gets pieces
 * becomes a line, a line left with none is removed. Live: the quote's events read it again; with unsaved work the page
 * says it changed instead. Sending is the shared send dialog (SCR-037).
 */
export function QuoteRecord({ quoteId }: { quoteId: string }) {
  return (
    <WithMessages namespaces={['sales', 'send', 'records']}>
      <QuoteRecordContainer quoteId={quoteId} />
    </WithMessages>
  )
}

function QuoteRecordContainer({ quoteId }: { quoteId: string }) {
  const t = useT('sales')
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const tab = tabOf(params?.get('tab'))
  const prefix = pathname.replace(/\/sales\/quotes\/[^/]+\/?$/, '')
  const grains = useMemo(() => grainsOf(session.permissions), [session.permissions])
  const can = useMemo(() => abilitiesOf(session.permissions), [session.permissions])
  const companyId = session.company?.id ?? null

  const [quote, setQuote] = useState<Loaded<QuoteDetail>>({ status: 'loading' })
  const quoteRef = useRef<QuoteDetail | null>(null)
  const [styles, setStyles] = useState<Record<string, StyleDetail | null>>({})
  const [drafts, setDrafts] = useState<Record<string, Record<string, Record<string, number>>>>({})
  const draftsRef = useRef(drafts)
  draftsRef.current = drafts
  const [pending, setPending] = useState<Record<string, string[]>>({})
  const [prices, setPrices] = useState<Record<string, string>>({})
  const pricesRef = useRef(prices)
  pricesRef.current = prices
  const [save, setSave] = useState<SaveState>({ state: 'idle', at: null })
  const [composer, setComposer] = useState<ComposerState>(NO_COMPOSER)
  const [versions, setVersions] = useState<QuoteRecordViewModel['versions']>({ items: null, people: {}, problem: null })
  const [approvals, setApprovals] = useState<QuoteRecordViewModel['approvals']>({ items: null, problem: null })
  const [party, setParty] = useState<QuoteRecordViewModel['party']>({ value: null, problem: null })
  const [previewLanguage, setPreviewLanguage] = useState<'it' | 'en'>('it')
  const [doc, setDoc] = useState<QuoteRecordViewModel['document']>({ src: null, openHref: null, problem: null, frozen: false })
  const [send, setSend] = useState<DocumentSendModel | null>(null)
  const [dialog, setDialog] = useState<QuoteDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<QuoteNotice | null>(null)
  const [changed, setChanged] = useState<{ at: string } | null>(null)
  const [dockOpen, setDockOpen] = useState(false)
  const inFlight = useRef(0)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const tabHref = useCallback((next: QuoteTab) => `${prefix}/sales/quotes/${quoteId}?tab=${next}`, [prefix, quoteId])
  // B-W2a-49: Duplicate (band ⋯) and the payment terms library for Terms & delivery (paymentterms.view).
  const duplicate = useDuplicate(api, companyId, (id) => router.push(`${prefix}/sales/quotes/${id}?tab=lines`))
  const termsAllowed = session.permissions.includes('paymentterms.view')
  const [library, setLibrary] = useState<{ items: PaymentTermsRow[] | null; problem: string | null }>({ items: null, problem: null })

  const setValue = useCallback((next: QuoteDetail) => {
    quoteRef.current = next
    setQuote({ status: 'ready', value: next })
  }, [])

  const loadQuote = useCallback(async () => {
    try {
      const next = await getQuote(api, quoteId)
      setValue(next)
      setChanged(null)
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setQuote({ status: 'not_found' })
      else if (isApiError(error) && error.kind === 'forbidden') setQuote({ status: 'forbidden' })
      else setQuote({ status: 'error', problem: readProblem(error) })
    }
  }, [api, quoteId, setValue])

  const loadVersions = useCallback(async () => {
    try {
      const answer = await listVersions(api, quoteId)
      setVersions({ items: answer.versions, people: Object.fromEntries(answer.people.map((person) => [person.id, person.name])), problem: null })
    } catch (error) {
      setVersions((current) => ({ ...current, problem: readProblem(error) }))
    }
  }, [api, quoteId])

  const loadApprovals = useCallback(async () => {
    try {
      setApprovals({ items: (await listApprovals(api, 'all', quoteId)).approvals, problem: null })
    } catch (error) {
      setApprovals({ items: null, problem: readProblem(error) })
    }
  }, [api, quoteId])

  const loadAll = useCallback(() => {
    void loadQuote()
    void loadVersions()
    void loadApprovals()
  }, [loadApprovals, loadQuote, loadVersions])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  // The language the draft's PDF is previewed in starts as the quote's own.
  const value = quote.status === 'ready' ? quote.value : null
  useEffect(() => {
    if (value) setPreviewLanguage(value.current.language === 'en' ? 'en' : 'it')
    // Only when another quote opens (the person's own choice stays while they work on this one).
  }, [value?.id])

  const quoteCompany = value?.companyId ?? null
  useEffect(() => {
    if (tab !== 'terms' || !termsAllowed || !quoteCompany || library.items !== null) return
    listPaymentTerms(api, quoteCompany)
      .then((items) => setLibrary({ items, problem: null }))
      .catch((error: unknown) => setLibrary({ items: [], problem: readProblem(error) }))
  }, [api, tab, termsAllowed, quoteCompany, library.items])

  // The customer (contacts, addresses, tax identity) for Terms & delivery.
  const partyId = value?.partyId ?? null
  useEffect(() => {
    if (!partyId) return
    getParty(api, partyId)
      .then((answer) => setParty({ value: answer, problem: null }))
      .catch((error: unknown) => setParty({ value: null, problem: readProblem(error) }))
  }, [api, partyId])

  // Each style of the lines (and of new blocks), once.
  const styleIds = useMemo(() => [...new Set([...(value?.lines.map((line) => line.styleId) ?? []), ...Object.keys(pending)])], [value?.lines, pending])
  useEffect(() => {
    for (const styleId of styleIds) {
      if (styleId in styles) continue
      setStyles((current) => ({ ...current, [styleId]: current[styleId] ?? null }))
      getStyle(api, styleId)
        .then((style) => setStyles((current) => ({ ...current, [styleId]: style })))
        .catch(() => setStyles((current) => ({ ...current, [styleId]: null })))
    }
  }, [api, styleIds, styles])

  // The Documents tab's PDF: the live preview of a draft, else the version's frozen PDF from the file store.
  const sentDocument = versions.items?.find((version) => version.revision === value?.currentRevision)?.document ?? null
  const frozen = !!value && !['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(value.current.status) && sentDocument !== null
  const docKey = value ? `${value.id}:${value.version}:${previewLanguage}:${frozen ? sentDocument?.fileId : 'live'}` : null
  useEffect(() => {
    if (tab !== 'documents' || !value || !docKey) return
    let gone = false
    setDoc((current) => ({ ...current, src: null, problem: null }))
    if (frozen && sentDocument) {
      downloadLink(api, sentDocument.fileId)
        .then(({ download }) => !gone && setDoc({ src: storeUrl(download.url), openHref: null, problem: null, frozen: true }))
        .catch(() => !gone && setDoc({ src: null, openHref: null, problem: 'docs.problem.frozen', frozen: true }))
    } else {
      previewBytes(api, value.id, previewLanguage)
        .then((bytes) => !gone && setDoc({ src: bytes, openHref: previewHref(value.id, previewLanguage), problem: null, frozen: false }))
        .catch((error: unknown) => !gone && setDoc({ src: null, openHref: null, problem: isApiError(error) && error.kind === 'conflict' ? 'docs.problem.needs' : readProblem(error), frozen: false }))
    }
    return () => {
      gone = true
    }
    // The key holds everything the PDF depends on.
  }, [tab, docKey])

  // The thread beside the tab (Owner O1), remembered on this device (a per-viewer convenience).
  useEffect(() => {
    try {
      setDockOpen(window.localStorage.getItem(DOCK_KEY) === '1' && window.matchMedia(WIDE).matches)
    } catch {
      setDockOpen(false)
    }
  }, [])
  const toggleDock = () => {
    let wide = false
    try {
      wide = window.matchMedia(WIDE).matches
    } catch {
      wide = false
    }
    if (!wide) {
      router.push(tabHref('activity'))
      return
    }
    setDockOpen((current) => {
      try {
        window.localStorage.setItem(DOCK_KEY, current ? '0' : '1')
      } catch {
        // Not kept on this device; the dock still toggles.
      }
      return !current
    })
  }

  // ---- live ---------------------------------------------------------------------------------------------------------
  const unsaved = Object.keys(drafts).length > 0 || Object.keys(prices).length > 0
  useLiveChanges({
    onChange: (change) => {
      if (change.fields.quoteId !== quoteId) return
      if (inFlight.current > 0) return
      if (unsaved) setChanged({ at: new Date().toISOString() })
      else loadAll()
    },
    onReconnect: () => {
      if (!unsaved && inFlight.current === 0) loadAll()
    },
  })

  // ---- writes ---------------------------------------------------------------------------------------------------------
  /** One write with the quote as it stands now; true when the server took it. */
  const runWrite = useCallback(
    async (write: (current: QuoteDetail) => Promise<QuoteDetail>, done?: QuoteNotice): Promise<boolean> => {
      const current = quoteRef.current
      if (!current) return false
      inFlight.current++
      setSave({ state: 'saving', at: null })
      try {
        const next = await write(current)
        setValue(next)
        setSave({ state: 'saved', at: new Date().toISOString() })
        if (done) setNotice(done)
        return true
      } catch (error) {
        const problem = writeProblem(error)
        setNotice({ key: problem.key, tone: 'danger' })
        setSave((state) => ({ state: 'failed', at: state.at }))
        if (problem.reload) void loadQuote()
        return false
      } finally {
        inFlight.current--
      }
    },
    [loadQuote, setValue],
  )

  const enqueue = useCallback((work: () => Promise<unknown>) => {
    const next = queue.current.then(work, work)
    queue.current = next.catch(() => undefined)
    return next
  }, [])

  /** A block's typed grid, as line writes, one after the other. */
  const flush = useCallback(
    (styleId: string) =>
      enqueue(async () => {
        const typed = draftsRef.current[styleId]
        const current = quoteRef.current
        if (!typed || !current) return
        const writes = lineWrites(current.lines.filter((line) => line.styleId === styleId), typed)
        let ok = true
        for (const write of writes) {
          const key = `${styleId}:${write.colourwayId}`
          if (write.kind === 'add') {
            const price = pricesRef.current[key]
            ok = await runWrite((quote) => addLine(api, quote, { styleId, colourwayId: write.colourwayId, sizes: write.sizes, unitPrice: price ?? null }))
            if (ok) setPrices(({ [key]: _gone, ...rest }) => rest)
          } else if (write.kind === 'edit') {
            ok = await runWrite((quote) => editLine(api, quote, write.lineId, { sizes: write.sizes }))
          } else {
            ok = await runWrite((quote) => removeLine(api, quote, write.lineId))
            // The row stays in the block (its colourway is still chosen), now without a line.
            if (ok) setPending((all) => ({ ...all, [styleId]: [...new Set([...(all[styleId] ?? []), write.colourwayId])] }))
          }
          if (!ok) break
        }
        if (ok && draftsRef.current[styleId] === typed) setDrafts(({ [styleId]: _done, ...rest }) => rest)
      }),
    [api, enqueue, runWrite],
  )

  const onCells = (styleId: string, next: Record<string, Record<string, number>>) => {
    setDrafts((all) => ({ ...all, [styleId]: next }))
    draftsRef.current = { ...draftsRef.current, [styleId]: next }
    setSave((state) => ({ state: 'saving', at: state.at }))
    const timer = timers.current.get(styleId)
    if (timer) clearTimeout(timer)
    timers.current.set(
      styleId,
      setTimeout(() => {
        timers.current.delete(styleId)
        void flush(styleId)
      }, SAVE_DELAY_MS),
    )
  }
  useEffect(() => () => timers.current.forEach((timer) => clearTimeout(timer)), [])

  const onPrice = (styleId: string, colourwayId: string, text: string) => {
    const parsed = parsePrice(text)
    if (parsed === null) {
      setNotice({ key: 'lines.priceInvalid', tone: 'warning' })
      return
    }
    const line = quoteRef.current?.lines.find((entry) => entry.styleId === styleId && entry.colourwayId === colourwayId)
    if (!line) {
      setPrices((all) => ({ ...all, [`${styleId}:${colourwayId}`]: parsed }))
      return
    }
    void enqueue(() => runWrite((quote) => editLine(api, quote, line.id, { unitPrice: parsed })))
  }

  const onRemoveBlock = (styleId: string) => {
    const lines = quoteRef.current?.lines.filter((line) => line.styleId === styleId) ?? []
    setDrafts(({ [styleId]: _gone, ...rest }) => rest)
    setPending(({ [styleId]: _gone, ...rest }) => rest)
    void enqueue(async () => {
      for (const line of lines) if (!(await runWrite((quote) => removeLine(api, quote, line.id)))) return
      setNotice({ key: 'lines.removed', tone: 'success', params: { count: lines.length } })
    })
  }

  // ---- the style composer ---------------------------------------------------------------------------------------------
  const searchSeq = useRef(0)
  const onComposerQuery = (query: string) => {
    const mine = ++searchSeq.current
    setComposer((current) => ({ ...current, query, results: query.trim() === '' ? current.results : null, problem: null }))
    findStyles(api, query, companyId)
      .then((results) => mine === searchSeq.current && setComposer((current) => ({ ...current, results })))
      .catch((error: unknown) => mine === searchSeq.current && setComposer((current) => ({ ...current, problem: readProblem(error) })))
  }
  const onComposerPick = (styleId: string) => {
    getStyle(api, styleId)
      .then((style) => {
        setStyles((current) => ({ ...current, [style.id]: style }))
        setComposer((current) => ({ ...current, chosen: style, picked: style.colourways.filter((colourway) => colourway.status === 'ACTIVE').map((colourway) => colourway.id) }))
      })
      .catch((error: unknown) => setComposer((current) => ({ ...current, problem: readProblem(error) })))
  }
  const onComposerAdd = () => {
    const chosen = composer.chosen
    if (!chosen) return
    const existing = new Set(quoteRef.current?.lines.filter((line) => line.styleId === chosen.id).map((line) => line.colourwayId) ?? [])
    setPending((all) => ({ ...all, [chosen.id]: [...new Set([...(all[chosen.id] ?? []), ...composer.picked.filter((id) => !existing.has(id))])] }))
    setComposer(NO_COMPOSER)
    setNotice({ key: 'composer.added', tone: 'info', params: { style: chosen.code } })
  }

  // ---- the send dialog (SCR-037) --------------------------------------------------------------------------------------
  const openSend = () => {
    const current = quoteRef.current
    if (!current) return
    const language = current.current.language === 'en' ? 'en' : 'it'
    const label = t('docs.pdfTitle', { number: current.number, revision: current.currentRevision })
    setSend({
      title: t('send.title', { number: current.number, revision: current.currentRevision }),
      documentLabel: label,
      recipient: current.contact ? { name: current.contact.name, email: current.contact.email } : null,
      language,
      how: { kind: 'acceptLink', until: null },
      freezeNote: t('send.freeze', { revision: current.currentRevision, next: current.currentRevision + 1 }),
      recipientCan: [t('send.can.accept'), ...(current.current.depositAmount ? [t('send.can.deposit')] : []), ...(current.current.priceBasis === 'GROSS' ? [t('send.can.consumer')] : [])],
      fields: { cc: '', subject: '', message: '' },
      checks: { status: 'loading' },
      preview: { src: null, openHref: previewHref(current.id, language), problem: null, fileName: `${current.number}-v${current.currentRevision}.pdf` },
      sending: false,
      problem: null,
      result: null,
      canSend: can.send,
    })
    void readSendChecks()
    previewBytes(api, current.id, language)
      .then((bytes) => setSend((model) => (model ? { ...model, preview: { ...model.preview, src: bytes } } : model)))
      .catch((error: unknown) => setSend((model) => (model ? { ...model, preview: { ...model.preview, problem: t(isApiError(error) && error.kind === 'conflict' ? 'docs.problem.needs' : readProblem(error)) } } : model)))
  }
  const readSendChecks = async () => {
    const current = quoteRef.current
    if (!current) return
    setSend((model) => (model ? { ...model, checks: { status: 'loading' } } : model))
    try {
      const check = await sendCheck(api, current.id)
      setSend((model) =>
        model
          ? {
              ...model,
              recipient: check.recipient ? { name: check.recipient.name, email: check.recipient.email } : null,
              language: check.language,
              how: { kind: 'acceptLink', until: check.linkExpiresAt },
              fields: { ...model.fields, subject: model.fields.subject || check.subject || '', message: model.fields.message },
              checks: { status: 'ready', items: sendItems(check, t, tabHref) },
            }
          : model,
      )
    } catch (error) {
      setSend((model) => (model ? { ...model, checks: { status: 'error', problem: t(readProblem(error)) } } : model))
    }
  }
  const doSend = () => {
    const current = quoteRef.current
    const model = send
    if (!current || !model) return
    setSend({ ...model, sending: true, problem: null })
    inFlight.current++
    sendQuote(api, current, { cc: parseCc(model.fields.cc).valid, subject: model.fields.subject, message: model.fields.message })
      .then((answer) => {
        setValue(answer.quote)
        setSend((state) => (state ? { ...state, sending: false, result: { delivery: answer.delivery, to: answer.sent.to, at: answer.sent.sentAt, linkUntil: answer.sent.link.expiresAt } } : state))
        void loadVersions()
      })
      .catch((error: unknown) => {
        const problem = writeProblem(error)
        setSend((state) => (state ? { ...state, sending: false, problem: t(problem.key === 'problem.write.state' ? 'send.refused' : problem.key) } : state))
        if (problem.reload) {
          void loadQuote()
          void readSendChecks()
        }
      })
      .finally(() => {
        inFlight.current--
      })
  }

  // ---- dialogs ----------------------------------------------------------------------------------------------------------
  const decide = async (work: () => Promise<boolean>): Promise<boolean> => {
    setBusy(true)
    try {
      const done = await work()
      if (done) {
        void loadApprovals()
        void loadVersions()
      }
      return done
    } finally {
      setBusy(false)
    }
  }

  const model: QuoteRecordViewModel = {
    prefix,
    me: session.user.id,
    tab,
    grains,
    can,
    quote,
    styles,
    drafts,
    pendingColourways: pending,
    prices,
    save,
    composer,
    versions,
    approvals,
    party,
    previewLanguage,
    document: doc,
    send,
    dialog,
    busy,
    notice,
    changed,
    today: romeToday(),
    dockOpen,
    library: { ...library, allowed: termsAllowed },
    duplicate: duplicate.model,
  }

  return (
    <QuoteRecordView
      model={model}
      panels={value ? <RecordPanels record={{ type: 'Quote', id: value.id, companyId: value.companyId, siteId: null }} title={`${value.number} · ${value.party.legalName}`} party={{ id: value.partyId, name: value.party.legalName, emails: value.contact?.email ? [value.contact.email] : [] }} /> : null}
      actions={{
        onRetry: loadAll,
        onReload: loadAll,
        onCells,
        onPrice,
        onRemoveBlock,
        onAddColourway: (styleId, colourwayId) => setPending((all) => ({ ...all, [styleId]: [...new Set([...(all[styleId] ?? []), colourwayId])] })),
        onRetrySave: () => {
          for (const styleId of Object.keys(draftsRef.current)) void flush(styleId)
        },
        onComposerQuery,
        onComposerPick,
        onComposerToggle: (colourwayId) => setComposer((current) => ({ ...current, picked: current.picked.includes(colourwayId) ? current.picked.filter((id) => id !== colourwayId) : [...current.picked, colourwayId] })),
        onComposerAdd,
        onComposerClear: () => setComposer((current) => ({ ...current, chosen: null, picked: [] })),
        onTermsSave: (patch) => enqueue(() => runWrite((current) => updateQuote(api, current, patch), { key: 'terms.saved', tone: 'success' })) as Promise<boolean>,
        onDialog: setDialog,
        onAsk: (note) => decide(() => runWrite((current) => askApproval(api, current, note), { key: 'notice.asked', tone: 'success' })),
        onWithdraw: (reason) => decide(() => runWrite((current) => reopen(api, current, reason), { key: 'notice.reopened', tone: 'success' })),
        onApprove: (note) => decide(() => runWrite((current) => approveQuote(api, current, note), { key: 'notice.approved', tone: 'success' })),
        onReject: (reason) => decide(() => runWrite((current) => rejectQuote(api, current, reason), { key: 'notice.rejected', tone: 'success' })),
        onCancelQuote: (reason) => decide(() => runWrite((current) => cancelQuote(api, current, reason), { key: 'notice.cancelled', tone: 'success' })),
        onRevise: (changeNote) => decide(() => runWrite((current) => reviseQuote(api, current, changeNote), { key: 'notice.revised', tone: 'success', params: { next: (quoteRef.current?.currentRevision ?? 0) + 1 } })),
        onNewLink: () =>
          decide(() =>
            runWrite(
              async (current) => {
                const answer = await sendNewLink(api, current)
                if (answer.delivery === 'failed') setNotice({ key: 'notice.linkFailed', tone: 'danger' })
                return answer.quote
              },
              { key: 'notice.linkSent', tone: 'success' },
            ),
          ),
        onOpenSend: openSend,
        onPreviewLanguage: setPreviewLanguage,
        onDownload: (fileId) => {
          downloadLink(api, fileId)
            .then(({ download }) => {
              const anchor = document.createElement('a')
              anchor.href = storeUrl(download.url)
              anchor.rel = 'noopener'
              document.body.appendChild(anchor)
              anchor.click()
              anchor.remove()
            })
            .catch((error: unknown) => setNotice({ key: readProblem(error), tone: 'danger' }))
        },
        onDismissNotice: () => setNotice(null),
        onDock: toggleDock,
        ...duplicate.actions,
        onDuplicateStart: () => {
          const current = quoteRef.current
          if (!current) return
          duplicate.open({
            id: current.id,
            number: current.number,
            partyId: current.partyId,
            partyName: current.party.legalName,
            revision: current.currentRevision,
            versions: (versions.items ?? []).map((version) => ({ id: version.id, revision: version.revision, status: version.status })).sort((a, b) => b.revision - a.revision),
          })
        },
        onUseListPrice: (lineId) => {
          const line = quoteRef.current?.lines.find((entry) => entry.id === lineId)
          if (!line?.listUnitPrice) return
          void enqueue(() => runWrite((quote) => editLine(api, quote, line.id, { unitPrice: line.listUnitPrice ?? null }), { key: 'lines.backToList', tone: 'success', params: { colour: line.colourway.code } }))
        },
      }}
      sendActions={{
        onField: (field, text) => setSend((current) => (current ? { ...current, fields: { ...current.fields, [field]: text } } : current)),
        onSend: doSend,
        onClose: () => setSend(null),
        onRetryChecks: () => void readSendChecks(),
        onNewLink: () => {
          setSend(null)
          setDialog('newLink')
        },
      }}
    />
  )
}
