'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useLocale } from '../../../../lib/i18n/provider'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { downloadText, isStepUpCancelled, useLive, useStepUp } from '../../_shared/hooks'
import { romeToday } from '../model'
import { addMapping, changeMapping, getMapping, removeMapping, saveSettings, type MappingAnswer, type MappingKey, type MappingRow } from './api'
import {
  addBody,
  addHeld,
  bulkHeld,
  changeHeld,
  cleanAccount,
  keyId,
  keyOfOpen,
  mappingAddressOf,
  mappingCanOf,
  mappingCsv,
  mappingHref,
  mappingTouches,
  readProblem,
  removeHeld,
  switchBody,
  switchHeld,
  writeProblem,
  type Phrase,
} from './model'
import type { BulkDialogModel, KeyDialogModel, MappingActions, MappingPageModel, SwitchDialogModel } from './view-model'
import { MappingView } from './view/MappingView'

const SLOW_MS = 1000
/** A live event this soon after one of our own writes is our own: read again without "N updates". */
const OWN_WRITE_MS = 5000

const keyDialog = (key: MappingKey, today: string): KeyDialogModel => ({ key, draft: { accountCode: '', validFrom: today, note: '' }, busy: false, problem: null, editing: null, rowBusy: null, rowProblem: null, done: null })

/**
 * `/w/<company>/finance/accounting/mapping` (SCR-480; B-W2b-426 on B-W2b-408's API): the company's account mapping —
 * every key Nexus posts with its account in force today, the next one and the earlier ones (`?kind=&view=&q=`), one key's
 * rows in its dialog (`?open=KIND/KEY`: add a row from a day; change or remove an upcoming one before its day), "Map N
 * keys" to one account, Export N / the whole mapping as a CSV for the accountant to confirm, and the journals switch
 * (a fresh authenticator code first). Live: a row or the switch changed elsewhere → "N updates · Show". Nothing is sent to
 * the accountant: the CSV is a file a person downloads.
 */
export function MappingPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const locale = useLocale()
  const prefix = pathname.replace(/\/finance\/accounting\/mapping\/?$/, '')
  const address = useMemo(() => mappingAddressOf(params), [params])
  const companyId = session.company?.id ?? null

  const [state, setState] = useState<{ answer: MappingAnswer | null; problem: string | null; slow: boolean; readAt: number | null }>({ answer: null, problem: null, slow: false, readAt: null })
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<Phrase | null>(null)
  const [dialog, setDialog] = useState<KeyDialogModel | null>(null)
  const [bulk, setBulk] = useState<BulkDialogModel | null>(null)
  const [switching, setSwitching] = useState<SwitchDialogModel | null>(null)
  const lastWrite = useRef(0)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const answer = state.answer
  const can = useMemo(() => mappingCanOf(session.permissions, answer), [session.permissions, answer])
  const today = answer?.today ?? romeToday()

  const turn = useRef(0)
  const load = useCallback(async () => {
    if (!can.view || !companyId) return null
    const mine = ++turn.current
    const slow = setTimeout(() => mine === turn.current && setState((now) => (now.answer || now.problem ? now : { ...now, slow: true })), SLOW_MS)
    try {
      const read = await getMapping(api, companyId)
      if (mine === turn.current) {
        setState({ answer: read, problem: null, slow: false, readAt: Date.now() })
        setUpdates(0)
      }
      return read
    } catch (error) {
      if (mine === turn.current) setState((now) => ({ ...now, answer: null, problem: readProblem(error), slow: false }))
      return null
    } finally {
      clearTimeout(slow)
    }
  }, [api, can.view, companyId])

  useEffect(() => {
    void load()
  }, [load])

  // The key the address opens follows the newest read (its rows change after a write).
  useEffect(() => {
    const key = answer ? keyOfOpen(answer.keys, address.open) : null
    setDialog((current) => (!key ? null : current && keyId(current.key) === keyId(key) ? { ...current, key } : keyDialog(key, answer?.today ?? today)))
  }, [answer, address.open, today])

  const live = useLive(
    (change) => {
      if (!mappingTouches(change)) return
      if (Date.now() - lastWrite.current < OWN_WRITE_MS) void load()
      else setUpdates((count) => count + 1)
    },
    () => void load(),
    can.view,
  )

  const stepUpApi = useStepUp(api)
  // The address as it is now (a debounced search must not undo a key opened meanwhile).
  const addressRef = useRef(address)
  addressRef.current = address
  const go = (next: Partial<typeof address>) => router.replace(mappingHref(prefix, { ...addressRef.current, ...next }), { scroll: false })
  const wrote = () => {
    lastWrite.current = Date.now()
  }

  const actions: MappingActions = {
    onKind: (kind) => go({ kind }),
    onView: (view) => go({ view }),
    // The list filters as the person types; the address follows a moment later (one history entry, not one per key).
    onSearch: (q) => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
      searchTimer.current = setTimeout(() => go({ q }), 300)
    },
    onClear: () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
      go({ kind: null, view: 'all', q: '' })
    },
    onRetry: () => void load(),
    onShowUpdates: () => void load(),
    onDismissNotice: () => setNotice(null),
    onExport: (keys) => {
      const words = createTranslator(locale, messagesFor(locale, ['finance-accounting-depth'])['finance-accounting-depth']!)
      const csv = mappingCsv(
        keys,
        { headers: ['kind', 'key', 'what', 'account', 'since', 'next', 'nextFrom', 'note'].map((name) => words(`mapping.csv.${name}`)), kind: (kind) => words(`mapping.kind.${kind}`), notPosted: words('mapping.notPosted') },
        locale,
      )
      downloadText(`${answer?.company.code ?? 'company'}_${words('mapping.csv.file')}_${today}.csv`, csv)
    },
    onOpen: (key) => go({ open: keyId(key) }),
    onClose: () => go({ open: null }),
    onDraft: (patch) => setDialog((current) => (current ? { ...current, draft: { ...current.draft, ...patch }, problem: null, done: null } : current)),
    onAdd: () => {
      const open = dialog
      if (!open || !companyId || addHeld(open.key, open.draft, { today, can, busy: open.busy })) return
      setDialog({ ...open, busy: true, problem: null, done: null })
      wrote()
      addMapping(api, addBody(companyId, open.key, open.draft))
        .then((row) => {
          setDialog((current) => (current ? { ...current, busy: false, draft: { ...current.draft, note: '' }, done: { key: 'mapping.done.added', params: { account: row.accountCode, day: row.validFrom } } } : current))
          void load()
        })
        .catch((error: unknown) => {
          const problem = writeProblem(error)
          setDialog((current) => (current ? { ...current, busy: false, problem } : current))
          if (problem.reload) void load()
        })
    },
    onEdit: (row) => setDialog((current) => (current ? { ...current, editing: row ? { rowId: row.id, accountCode: row.accountCode, note: row.note ?? '' } : null, rowProblem: null, done: null } : current)),
    onEditDraft: (patch) => setDialog((current) => (current?.editing ? { ...current, editing: { ...current.editing, ...patch }, rowProblem: null } : current)),
    onSaveEdit: () => {
      const open = dialog
      const editing = open?.editing
      const row = open?.key.upcoming.find((entry) => entry.id === editing?.rowId)
      if (!open || !editing || !row || changeHeld(row, editing, { can, busy: open.rowBusy !== null })) return
      setDialog({ ...open, rowBusy: row.id, rowProblem: null })
      wrote()
      const note = editing.note.trim()
      changeMapping(api, row.id, { version: row.version, accountCode: cleanAccount(editing.accountCode), note: note === '' ? null : note })
        .then((changed) => {
          setDialog((current) => (current ? { ...current, rowBusy: null, editing: null, done: { key: 'mapping.done.changed', params: { account: changed.accountCode, day: changed.validFrom } } } : current))
          void load()
        })
        .catch((error: unknown) => {
          const problem = writeProblem(error)
          setDialog((current) => (current ? { ...current, rowBusy: null, rowProblem: problem } : current))
          if (problem.reload) void load()
        })
    },
    onRemove: (row: MappingRow) => {
      const open = dialog
      if (!open || removeHeld(row, { can, busy: open.rowBusy !== null })) return
      setDialog({ ...open, rowBusy: row.id, rowProblem: null, done: null })
      wrote()
      removeMapping(api, row.id, row.version)
        .then(() => {
          setDialog((current) => (current ? { ...current, rowBusy: null, editing: null, done: { key: 'mapping.done.removed', params: { account: row.accountCode, day: row.validFrom } } } : current))
          void load()
        })
        .catch((error: unknown) => {
          const problem = writeProblem(error)
          setDialog((current) => (current ? { ...current, rowBusy: null, rowProblem: problem } : current))
          if (problem.reload) void load()
        })
    },
    onBulk: (keys) => setBulk({ keys, draft: { accountCode: '', validFrom: today, note: '' }, busy: false, sent: 0, done: null }),
    onBulkDraft: (patch) => setBulk((current) => (current && !current.busy ? { ...current, draft: { ...current.draft, ...patch }, done: null } : current)),
    onBulkClose: () => {
      if (bulk?.busy) return
      setBulk(null)
    },
    onBulkGo: () => {
      const run = bulk
      if (!run || !companyId || bulkHeld(run.keys, run.draft, { today, can, busy: run.busy })) return
      setBulk({ ...run, busy: true, sent: 0, done: null })
      wrote()
      void (async () => {
        const made: string[] = []
        const refused: Array<{ id: string; problem: Phrase }> = []
        for (const key of run.keys) {
          try {
            await addMapping(api, addBody(companyId, key, run.draft), newIdempotencyKey())
            made.push(keyId(key))
          } catch (error) {
            refused.push({ id: keyId(key), problem: writeProblem(error) })
          }
          lastWrite.current = Date.now()
          setBulk((current) => (current ? { ...current, sent: made.length + refused.length } : current))
        }
        setBulk((current) => (current ? { ...current, busy: false, done: { made, refused } } : current))
        void load()
      })()
    },
    onSwitchOpen: () => setSwitching({ reason: '', busy: false, problem: null }),
    onSwitchReason: (text) => setSwitching((current) => (current ? { ...current, reason: text, problem: null } : current)),
    onSwitchClose: () => {
      if (switching?.busy) return
      setSwitching(null)
    },
    onSwitchGo: () => {
      const open = switching
      const settings = answer?.journals
      if (!open || !settings || !companyId || switchHeld(open, can)) return
      setSwitching({ ...open, busy: true, problem: null })
      const key = newIdempotencyKey()
      const body = switchBody(companyId, settings, open.reason)
      // A fresh code first (the route asks one for every switch), then the write; a late 403 stepUp asks again.
      stepUpApi
        .ensureFresh('journals.stepUp')
        .then(() => {
          wrote()
          return stepUpApi.guard('journals.stepUp', () => saveSettings(api, body, key))
        })
        .then((saved) => {
          setSwitching(null)
          setNotice({ key: saved.journalsOn ? 'journals.done.on' : 'journals.done.off' })
          void load()
        })
        .catch((error: unknown) => {
          if (isStepUpCancelled(error)) {
            setSwitching((current) => (current ? { ...current, busy: false } : current))
            return
          }
          const problem = writeProblem(error)
          setSwitching((current) => (current ? { ...current, busy: false, problem } : current))
          if (problem.reload) void load()
        })
    },
    onStepUpSubmit: (code) => void stepUpApi.submitStepUp(code),
    onStepUpCancel: () => stepUpApi.cancelStepUp(),
  }

  const model: MappingPageModel = {
    prefix,
    can,
    today,
    address,
    live,
    answer,
    problem: state.problem,
    slow: state.slow,
    readAt: state.readAt,
    updates,
    notice,
    key: dialog,
    bulk,
    switching,
    stepUp: stepUpApi.stepUp,
  }
  return <MappingView model={model} actions={actions} />
}
