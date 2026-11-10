'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useT } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { downloadText, useLive } from '../../quality/_shared/hooks'
import { createDraft, listDeclarations, readCoverage, readPreview, readUnrecorded, recordShipment, startTranslations, type Coverage, type CoverageRow, type ListAnswer } from './api'
import { addressOf, addressText, cellAction, declarationsCan, isDeclarationsChange, languageCheck, problemOf, readProblemOf, recordHref, rowsCsv, withAddress, type DeclarationsAddress } from './model'
import { failedRead, loadingRead, readyRead, type LanguageCheckState, type NewState, type PageNotice, type Read, type TranslateState, type UnrecordedState } from './view-model'
import { languageOptions } from './view/dialogs'
import { DeclarationsView } from './view/DeclarationsView'

const PREVIEW_PAUSE = 350

const blankNew = (address: DeclarationsAddress, companyId: string | null): NewState => ({
  styleId: address.newStyle,
  kind: address.newKind ?? 'DECLARATION_OF_CONFORMITY',
  languages: address.newLanguage ? [address.newLanguage] : [],
  marketCode: null,
  packs: [],
  companyId,
  preview: null,
  busy: false,
  problem: null,
})

/**
 * `/w/<company>/compliance/declarations` (SCR-052; B-W2b-268; design compliance.declarations): two reads — the coverage with the
 * tiles (GET /compliance/declarations/coverage) and the grid (GET /compliance/declarations, the address's filters) — each loading
 * and failing on its own. Dialogs live in the address (`model.ts` addressOf): New declaration (`?new=1&style=&newKind=&lang=`, its
 * preview read live and paused while typing), Language check (`?check=1`), the batches without a recorded version
 * (`?unrecorded=1`); Translate opens from a row or a cell. Writes carry one Idempotency-Key each; a refusal is said by its code.
 * Live: the generator's, the leaflet builder's and W1's signed uploads re-read the coverage (coalesced) and count grid updates
 * ("N updates · Show": rows never move under the cursor).
 */
export function DeclarationsPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const words = useT('compliance-declarations')
  const prefix = pathname.replace(/\/compliance\/declarations\/?$/, '')
  const can = useMemo(() => declarationsCan(session.permissions), [session.permissions])
  const address = useMemo(() => addressOf(params), [params])
  const companyId = session.company?.id ?? null

  const [coverage, setCoverage] = useState<Read<Coverage>>(loadingRead)
  const [list, setList] = useState<Read<ListAnswer>>(loadingRead)
  const [readAt, setReadAt] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<PageNotice | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [selectedCoverage, setSelectedCoverage] = useState<string[]>([])
  const [add, setAdd] = useState<NewState | null>(null)
  const [translate, setTranslate] = useState<TranslateState | null>(null)
  const [check, setCheck] = useState<LanguageCheckState | null>(null)
  const [unrecorded, setUnrecorded] = useState<UnrecordedState | null>(null)
  const [online, setOnline] = useState(true)
  const turns = useRef({ coverage: 0, list: 0 })

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

  const go = useCallback((change: Partial<DeclarationsAddress>) => router.replace(`${pathname}${addressText(withAddress(address, change))}`, { scroll: false }), [router, pathname, address])

  const readCoverageNow = useCallback(async () => {
    if (!can.view) return
    const turn = ++turns.current.coverage
    try {
      const value = await readCoverage(api, null)
      if (turn === turns.current.coverage) setCoverage(readyRead(value))
    } catch (error) {
      if (turn === turns.current.coverage) setCoverage(failedRead(readProblemOf(error)))
    }
  }, [api, can.view])

  const { kind, status, origin, language, q } = address
  const readListNow = useCallback(async () => {
    if (!can.view) return
    const turn = ++turns.current.list
    try {
      const value = await listDeclarations(api, { kind, status, origin, language, q })
      if (turn !== turns.current.list) return
      setList(readyRead(value))
      setReadAt(new Date().toISOString())
      setUpdates(0)
      setSelected((current) => current.filter((id) => value.declarations.some((row) => row.id === id)))
    } catch (error) {
      if (turn === turns.current.list) setList(failedRead(readProblemOf(error)))
    }
  }, [api, can.view, kind, status, origin, language, q])

  useEffect(() => {
    void readCoverageNow()
  }, [readCoverageNow])
  // The words typed wait for a pause (250 ms); a filter reads at once.
  useEffect(() => {
    const timer = setTimeout(() => void readListNow(), q ? 250 : 0)
    return () => clearTimeout(timer)
  }, [readListNow, q])

  const rereadAll = useCallback(() => {
    void readCoverageNow()
    void readListNow()
  }, [readCoverageNow, readListNow])

  // ---- live: the coverage re-reads (coalesced), the grid counts its updates -----------------------------------------------------
  const coverageTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const readersRef = useRef({ readCoverageNow, rereadAll })
  readersRef.current = { readCoverageNow, rereadAll }
  useEffect(() => () => void (coverageTimer.current && clearTimeout(coverageTimer.current)), [])
  const live = useLive(
    (change) => {
      if (!can.view || !isDeclarationsChange(change)) return
      setUpdates((count) => count + 1)
      if (coverageTimer.current) return
      coverageTimer.current = setTimeout(() => {
        coverageTimer.current = null
        void readersRef.current.readCoverageNow()
      }, 800)
    },
    () => {
      if (can.view) readersRef.current.rereadAll()
    },
  )

  // ---- New declaration: opened by the address, its preview read after a pause --------------------------------------------------
  useEffect(() => {
    if (!address.add || !can.view) {
      setAdd(null)
      return
    }
    setAdd((current) => current ?? blankNew(address, null))
  }, [address.add, can.view])

  const previewKey = add ? `${add.styleId}|${add.kind}|${add.languages[0] ?? ''}|${add.marketCode ?? ''}|${add.companyId ?? ''}` : ''
  useEffect(() => {
    if (!add || !add.styleId || add.languages.length === 0) return
    const styleId = add.styleId
    const query = { kind: add.kind, styleId, companyId: add.companyId, language: add.languages[0]!, marketCode: add.marketCode }
    const controller = new AbortController()
    setAdd((current) => (current ? { ...current, preview: loadingRead } : current))
    const timer = setTimeout(() => {
      readPreview(api, query, controller.signal)
        .then((preview) => {
          if (controller.signal.aborted) return
          // A style of every company: made for the company the page works in, unless another is chosen.
          if (preview.companyId === null && !query.companyId && companyId) setAdd((current) => (current ? { ...current, companyId } : current))
          else setAdd((current) => (current ? { ...current, preview: readyRead(preview) } : current))
        })
        .catch((error: unknown) => !controller.signal.aborted && setAdd((current) => (current ? { ...current, preview: failedRead(problemOf(error).key) } : current)))
    }, PREVIEW_PAUSE)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [api, previewKey, companyId])

  const create = async () => {
    if (!add || add.busy || !add.styleId) return
    setAdd({ ...add, busy: true, problem: null })
    try {
      const id = await createDraft(api, add.kind, { styleId: add.styleId, companyId: add.companyId, languages: add.languages, marketCode: add.marketCode, packs: add.kind === 'USER_INFORMATION' ? add.packs : [] }, newIdempotencyKey())
      setAdd(null)
      router.push(`${recordHref(prefix, id)}?created=1`)
    } catch (error) {
      setAdd((current) => (current ? { ...current, busy: false, problem: problemOf(error) } : current))
    }
  }

  // ---- Translate (a row's original, or a coverage cell) -----------------------------------------------------------------------
  const listRows = list.status === 'ready' ? list.value.declarations : []
  const openTranslate = (originalId: string, preset: readonly string[] = []) => {
    const original = listRows.find((row) => row.id === originalId)
    if (!original) return
    const taken = new Set(listRows.filter((row) => row.id === originalId || row.translationOfId === originalId).map((row) => row.language))
    const options = languageOptions(coverage.status === 'ready' ? coverage.value.languages : [], preset).filter((tag) => !taken.has(tag))
    setTranslate({ originalId, kind: original.kind, label: `${original.number ?? original.style.code} (${original.language.toUpperCase()})`, options, languages: preset.filter((tag) => options.includes(tag)), busy: false, problem: null })
  }

  const runTranslate = async () => {
    if (!translate || translate.busy) return
    setTranslate({ ...translate, busy: true, problem: null })
    try {
      await startTranslations(api, translate.kind, translate.originalId, translate.languages, [], newIdempotencyKey())
      setNotice({ tone: 'success', key: 'notice.translations', params: { count: translate.languages.length } })
      setTranslate(null)
      rereadAll()
    } catch (error) {
      setTranslate((current) => (current ? { ...current, busy: false, problem: problemOf(error) } : current))
    }
  }

  const onCell = (row: CoverageRow, tag: string) => {
    const action = cellAction(row, tag, listRows, can)
    if (action.kind === 'open') router.push(recordHref(prefix, action.documentId))
    else if (action.kind === 'translate') openTranslate(action.originalId, [tag])
    else if (action.kind === 'new') go({ add: true, newStyle: row.style.id, newKind: row.kind, newLanguage: tag })
  }

  /** Translate the gaps: each chosen row's missing languages added to its generated original, one call per row. */
  const translateGaps = async (keys: readonly string[]) => {
    if (coverage.status !== 'ready' || check?.busy) return
    const rows = languageCheck(coverage.value, listRows, can).filter((row) => keys.includes(row.key) && row.held === null && row.originalId)
    setCheck({ busy: true })
    let done = 0
    const refused: { label: string; key: string }[] = []
    for (const row of rows) {
      try {
        await startTranslations(api, row.row.kind, row.originalId!, row.gaps, [], newIdempotencyKey())
        done += row.gaps.length
      } catch (error) {
        refused.push({ label: `${row.row.style.code} · ${words(`kindShort.${row.row.kind}`)}`, key: problemOf(error).key })
      }
    }
    setCheck(null)
    setSelectedCoverage([])
    setNotice({ tone: refused.length > 0 ? 'warning' : 'success', key: 'notice.gaps', params: { count: done }, refused })
    if (address.check) go({ check: false })
    rereadAll()
  }

  // ---- the batches that left without a recorded version ----------------------------------------------------------------------
  const readUnrecordedNow = useCallback(() => {
    setUnrecorded((current) => ({ read: loadingRead, busy: null, problem: current?.problem ?? null }))
    readUnrecorded(api).then(
      (value) => setUnrecorded((current) => ({ busy: null, problem: current?.problem ?? null, read: readyRead(value) })),
      (error: unknown) => setUnrecorded((current) => ({ busy: null, problem: current?.problem ?? null, read: failedRead(readProblemOf(error)) })),
    )
  }, [api])
  useEffect(() => {
    if (address.unrecorded && can.view) readUnrecordedNow()
    else setUnrecorded(null)
  }, [address.unrecorded, can.view, readUnrecordedNow])

  const record = async (shipmentId: string) => {
    if (!unrecorded || unrecorded.busy) return
    setUnrecorded({ ...unrecorded, busy: shipmentId, problem: null })
    try {
      const answer = await recordShipment(api, shipmentId, newIdempotencyKey())
      setNotice({ tone: answer.skipped.length > 0 ? 'warning' : 'success', key: answer.skipped.length > 0 ? 'notice.recordedSkipped' : 'notice.recorded', params: { count: answer.recorded.length, skipped: answer.skipped.length } })
      readUnrecordedNow()
      void readCoverageNow()
    } catch (error) {
      setUnrecorded((current) => (current ? { ...current, busy: null, problem: problemOf(error) } : current))
    }
  }

  return (
    <DeclarationsView
      model={{
        prefix,
        can,
        companyId,
        companies: session.companies.map((company) => ({ id: company.id, code: company.code, name: company.name })),
        address,
        coverage,
        list,
        readAt,
        live,
        updates,
        notice,
        selected,
        selectedCoverage,
        add: address.add ? add : null,
        translate,
        check,
        unrecorded,
        online,
      }}
      actions={{
        onAddress: go,
        onRetry: (part) => {
          if (part === 'coverage') {
            setCoverage(loadingRead)
            void readCoverageNow()
          } else {
            setList(loadingRead)
            void readListNow()
          }
        },
        onShowUpdates: () => void readListNow(),
        onDismissNotice: () => setNotice(null),
        onSelected: setSelected,
        onSelectedCoverage: setSelectedCoverage,
        onNew: (change) => setAdd((current) => (current ? { ...current, ...change, problem: null, ...(change.styleId !== undefined && change.styleId !== current.styleId ? { companyId: null } : {}) } : current)),
        onCreate: () => void create(),
        onCell,
        onTranslateRow: (id) => openTranslate(id),
        onTranslate: (change) => setTranslate((current) => (change === null || !current ? null : { ...current, ...change, problem: null })),
        onStartTranslate: () => void runTranslate(),
        onTranslateGaps: (keys) => void translateGaps(keys),
        onRecordShipment: (id) => void record(id),
        onRetryUnrecorded: readUnrecordedNow,
        onOpen: (id) => router.push(recordHref(prefix, id)),
        onCopy: (text, what) => {
          void navigator.clipboard?.writeText(text).then(
            () => setNotice({ tone: 'success', key: what === 'address' ? 'notice.addressCopied' : 'notice.copied', params: { text } }),
            () => setNotice({ tone: 'warning', key: 'notice.copyFailed', params: { text } }),
          )
        },
        onExport: (ids) => {
          const rows = listRows.filter((row) => ids.includes(row.id))
          downloadText(words('csv.file', { day: new Date().toISOString().slice(0, 10) }), rowsCsv(rows, words))
          setNotice({ tone: 'success', key: 'notice.exported', params: { count: rows.length } })
        },
      }}
    />
  )
}

