'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { useT } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { companyPrefix } from '../../../lib/session/session'
import { csvLine, downloadText, liveMatches, useLive } from '../../quality/_shared/hooks'
import { failedRead, problemKey, reading, ready, type Notice, type Read } from '../../quality/_shared/model'
import { checkGarment, createCertificate, getStyleFacts, listBrands, listCertificates, pickedFile, searchStyles, uploadPdf, type BrandOption, type Certificate, type PickedFile, type StyleOption } from './api'
import { listReviews } from './renewals/api'
import { waitingByCertificate } from './renewals/model'
import { addressOf, blankCheck, blankDraft, certCan, certificatesCsv, draftFieldOf, filtersFromAddress, holderOf, inputOf, kindOf, todayInRome, type AddModel, type CertFilters, type CheckModel, type ListDialog } from './model'
import { CertMessages } from './view/parts'
import { certificateHref, CertificatesListView } from './view/CertificatesListView'

const EXPLAINER_KEY = 'fw.ce.explainer'

/**
 * The certificate register container (`/w/<company>/compliance/certificates`, SCR-050): reads the whole register the
 * person may see (`GET /compliance/certificates`, at most 500, with today's business date) — the views, tiles and
 * notices are worked out from it, so a tile's number is its view's count — and listens to the live stream (a
 * certificate expiring or expired: "N updates · Show", rows never move under the cursor). Add certificate creates a
 * DRAFT (and sends its PDF when one was chosen) and opens its Coverage; Check a garment asks the gate. `?view=&kind=&q=`
 * keep the filters in the address, `?new=1` opens Add certificate.
 */
export function CertificatesPage() {
  return (
    <CertMessages>
      <CertificatesContainer />
    </CertMessages>
  )
}

function CertificatesContainer() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const t = useT('certificates')
  const can = useMemo(() => certCan(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const filters = useMemo(() => filtersFromAddress(params), [params])
  const companies = useMemo(() => session.companies.map((company) => ({ id: company.id, name: company.name })), [session.companies])
  const [rows, setRows] = useState<Read<Certificate[]>>(reading())
  const [waiting, setWaiting] = useState<Read<Record<string, number>> | null>(null)
  const [today, setToday] = useState<string | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [selected, setSelected] = useState<readonly string[]>([])
  const [notice, setNotice] = useState<Notice | null>(null)
  const [dialog, setDialog] = useState<ListDialog | null>(null)
  const [brands, setBrands] = useState<BrandOption[] | null>(null)
  const [add, setAdd] = useState<AddModel | null>(null)
  const [check, setCheck] = useState<CheckModel | null>(null)
  const [explainerOpen, setExplainerOpen] = useState(false)
  const file = useRef<PickedFile | null>(null)
  const request = useRef<AbortController | null>(null)
  const styleSearch = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    if (!can.view) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    try {
      // W2a: the changes to the approved type waiting for the notified body (the column and the `changes` view).
      listReviews(api, { state: 'WAITING' }, controller.signal)
        .then((answer) => !controller.signal.aborted && setWaiting(ready(waitingByCertificate(answer.reviews))))
        .catch((error) => !controller.signal.aborted && (error as { name?: string } | null)?.name !== 'AbortError' && setWaiting(failedRead(problemKey(error))))
      const register = await listCertificates(api, controller.signal)
      if (controller.signal.aborted) return
      setRows(ready(register.certificates))
      setToday(register.today)
      setAsOf(new Date().toISOString())
      setUpdates(0)
      setSelected((current) => current.filter((id) => register.certificates.some((row) => row.id === id)))
    } catch (error) {
      if ((error as { name?: string } | null)?.name === 'AbortError') return
      setRows(failedRead(problemKey(error)))
    }
  }, [api, can.view])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!can.parties) return
    listBrands(api)
      .then(setBrands)
      .catch(() => setBrands(null))
  }, [api, can.parties])

  // The explainer's open state is remembered on this device (per person, design ce-explainer).
  useEffect(() => {
    try {
      setExplainerOpen(window.localStorage.getItem(EXPLAINER_KEY) !== '0')
    } catch {
      setExplainerOpen(true)
    }
  }, [])

  const live = useLive(
    (change) => {
      if (liveMatches(change, ['compliance.certificate_', 'compliance.type_change_', 'compliance.renewal_'])) setUpdates((count) => count + 1)
    },
    () => void load(),
  )

  const setFilters = (next: CertFilters) => {
    setSelected([])
    router.replace(`${pathname}${addressOf(next)}`, { scroll: false })
  }

  const openDialog = (next: ListDialog | null) => {
    setDialog(next)
    if (next?.kind !== 'add') setAdd(null)
    if (next?.kind !== 'check') setCheck(null)
    if (next?.kind === 'add') {
      file.current = null
      setAdd({ draft: blankDraft(session.company?.id ?? null), touched: [], fileName: null, busy: false, problem: null, lines: [], refused: [] })
    }
    if (next?.kind === 'check') setCheck(blankCheck(today ?? todayInRome()))
    if (!next && params?.get('new') === '1') router.replace(`${pathname}${addressOf(filters)}`, { scroll: false })
  }

  // `?new=1` (Today's New ▾, the `c` key from elsewhere) opens Add certificate once.
  const askedNew = params?.get('new') === '1'
  useEffect(() => {
    if (askedNew && can.manage) openDialog({ kind: 'add' })
    // Only when the address asks.
  }, [askedNew])

  const create = async () => {
    if (!add) return
    setAdd({ ...add, busy: true, problem: null, lines: [], refused: [] })
    try {
      const created = await createCertificate(api, inputOf(add.draft))
      let tab = 'coverage'
      if (file.current) {
        try {
          await uploadPdf(api, created.id, file.current)
        } catch {
          tab = 'files&pdf=failed'
        }
      }
      router.push(certificateHref(prefix, created.id, `tab=${tab}`))
    } catch (error) {
      const refused = isApiError(error) ? error.issues.map((issue) => draftFieldOf(issuePath(issue))).filter((field): field is NonNullable<typeof field> => field !== null) : []
      const lines = isApiError(error) ? error.issues.map((issue) => issue.message ?? '').filter(Boolean) : []
      const problem = isApiError(error) && error.kind === 'conflict' ? 'add.problem.duplicate' : isApiError(error) && error.kind === 'forbidden' ? 'held.manage' : isApiError(error) && error.kind === 'invalid' ? 'add.problem.invalid' : 'add.problem.failed'
      setAdd((current) => (current ? { ...current, busy: false, problem, lines: error instanceof Error && isApiError(error) && error.kind === 'conflict' ? [error.message] : lines, refused } : current))
    }
  }

  // Check a garment: the style search waits for a pause in typing; the style's colourways and sizes come next.
  const searchStyle = (query: string) => {
    setCheck((current) => (current ? { ...current, query, styles: query.trim() ? (current.styles?.value ? current.styles : reading()) : null } : current))
    styleSearch.current?.abort()
    if (!query.trim()) return
    const controller = new AbortController()
    styleSearch.current = controller
    setTimeout(() => {
      if (controller.signal.aborted) return
      searchStyles(api, query, controller.signal)
        .then((found) => !controller.signal.aborted && setCheck((current) => (current ? { ...current, styles: ready(found) } : current)))
        .catch((error) => !controller.signal.aborted && setCheck((current) => (current ? { ...current, styles: failedRead(problemKey(error)) } : current)))
    }, 250)
  }
  const pickStyle = (style: StyleOption) => {
    setCheck((current) => (current ? { ...current, style: reading(), colourwayId: '', size: '', result: null, problem: null } : current))
    getStyleFacts(api, style.id)
      .then((facts) => setCheck((current) => (current ? { ...current, style: ready(facts), colourwayId: facts.colourways.find((entry) => entry.status === 'ACTIVE')?.id ?? '' } : current)))
      .catch((error) => setCheck((current) => (current ? { ...current, style: failedRead(problemKey(error)) } : current)))
  }
  const runCheck = async () => {
    const model = check
    const style = model?.style?.value
    if (!model || !style) return
    setCheck({ ...model, busy: true, result: null, problem: null })
    try {
      const result = await checkGarment(api, { styleId: style.id, colourwayId: model.colourwayId, size: model.size, date: model.date })
      setCheck((current) => (current ? { ...current, busy: false, result } : current))
    } catch (error) {
      setCheck((current) => (current ? { ...current, busy: false, problem: problemKey(error) } : current))
    }
  }

  const exportRows = (certificates: readonly Certificate[]) => {
    const header = [t('csv.number'), t('csv.standard'), t('csv.class'), t('csv.kind'), t('csv.holder'), t('csv.bodyName'), t('csv.bodyNumber'), t('csv.model'), t('csv.covers'), t('csv.validFrom'), t('csv.validTo'), t('csv.daysLeft'), t('csv.status')]
    const lines = certificatesCsv(certificates, header, {
      status: (certificate) => t(`status.${certificate.status}`),
      kind: (certificate) => t(`kind.${kindOf(certificate.standard)}`),
      holder: (certificate) => holderOf(certificate, companies, brands).name ?? '',
    }).map(csvLine)
    downloadText(`certificates-${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\r\n'))
    setNotice({ key: 'done.exported', params: { count: certificates.length }, tone: 'success' })
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setNotice({ key: 'done.copied', params: { number: text }, tone: 'success' })
    } catch {
      setNotice({ key: 'done.copyFailed', tone: 'warning' })
    }
  }

  return (
    <CertificatesListView
      model={{ prefix, can, companies, brands, filters, rows, waiting, today, asOf, live, updates, selected, notice, dialog, add, check, explainerOpen }}
      actions={{
        onFilters: setFilters,
        onRetry: () => void load(),
        onShowUpdates: () => void load(),
        onSelect: (ids) => setSelected([...ids]),
        onOpen: (certificate) => router.push(certificateHref(prefix, certificate.id)),
        onDialog: openDialog,
        onExplainer: (open) => {
          setExplainerOpen(open)
          try {
            window.localStorage.setItem(EXPLAINER_KEY, open ? '1' : '0')
          } catch {
            // Not kept on this device.
          }
        },
        onExport: exportRows,
        onCopy: (text) => void copy(text),
        onDismissNotice: () => setNotice(null),
        onAddDraft: (draft) => setAdd((current) => (current ? { ...current, draft, refused: [] } : current)),
        onAddTouch: (field) => setAdd((current) => (current && !current.touched.includes(field) ? { ...current, touched: [...current.touched, field] } : current)),
        onAddFile: (chosen) => {
          void pickedFile(chosen).then((picked) => {
            file.current = picked
            setAdd((current) => (current ? { ...current, fileName: picked.name } : current))
          })
        },
        onCreate: () => void create(),
        onCheckQuery: searchStyle,
        onCheckStyle: pickStyle,
        onCheckClearStyle: () => setCheck((current) => (current ? { ...current, style: null, colourwayId: '', size: '', result: null } : current)),
        onCheckPatch: (patch) => setCheck((current) => (current ? { ...current, ...patch, result: null, problem: null } : current)),
        onCheckRun: () => void runCheck(),
      }}
    />
  )
}
