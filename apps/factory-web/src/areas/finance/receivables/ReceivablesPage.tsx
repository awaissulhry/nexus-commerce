'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { romeToday } from '../costing/model'
import { downloadText, useLive } from '../_shared/hooks'
import {
  approveReminder,
  approveReminders,
  cancelReminder,
  editReminder,
  getAgeing,
  getReceivablesSettings,
  getReminder,
  getReminderCounts,
  getStatement,
  listReminders,
  sendReminder,
  sendStatement,
  skipReminder,
  type AgeingRow,
  type Reminder,
  type ReminderCounts,
  type ReceivablesSettings,
} from './api'
import {
  addressOf,
  ageingCsv,
  ageingQueryOf,
  bulkRefusalsOf,
  liveTouches,
  readProblem,
  receivablesCanOf,
  receivablesHref,
  rowStatement,
  statementKey,
  statementOfAddress,
  statementPdfHref,
  statementQueryOf,
  type ReceivablesAddress,
  type StatementRef,
} from './model'
import type { ReminderDialogState } from './view/ReminderDialog'
import { ReceivablesView, type Notice, type ReceivablesModel } from './view/ReceivablesView'
import type { StatementState } from './view/StatementDialog'

const SLOW_MS = 1000
const SEARCH_MS = 300

/**
 * `/w/<company>/finance/receivables` (SCR-151): reads what customers owe (`GET /receivables/ageing` with the address's
 * day, search and tile; 100 customers a page with Show more), the header's count (`GET /receivables/reminders/counts`),
 * the reminders of the chosen view (`GET /receivables/reminders`) and the company's switch (`GET /receivables/settings`);
 * opens a customer's statement (`?statement=&company=&currency=`, J / K over the table) and a reminder (`?reminder=`);
 * prints statements in the PDF tab (new tab), e-mails one, approves (and sends while switched on), edits and skips
 * reminders. Live: payment reminders, settings, payments and issued invoices count behind "N updates · Show"; the
 * reminders and the count read again at once. Without receivables.view it asks the API nothing (the view says why).
 */
export function ReceivablesPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const locale = useLocale()
  const prefix = pathname.replace(/\/finance\/receivables\/?$/, '')
  const can = useMemo(() => receivablesCanOf(session.permissions), [session.permissions])
  const address = useMemo(() => addressOf(params), [params])
  const companyId = session.company?.id ?? null
  const [ageing, setAgeing] = useState<ReceivablesModel['ageing']>({
    value: null,
    problem: null,
    slow: false,
  })
  const [rows, setRows] = useState<AgeingRow[] | null>(null)
  const [next, setNext] = useState<number | null>(null)
  const [readAt, setReadAt] = useState<number | null>(null)
  const [updates, setUpdates] = useState(0)
  const [counts, setCounts] = useState<ReminderCounts | null>(null)
  const [reminders, setReminders] = useState<ReceivablesModel['reminders']>({
    value: null,
    problem: null,
    more: false,
  })
  const [reminderCursor, setReminderCursor] = useState<string | null>(null)
  const [settings, setSettings] = useState<ReceivablesSettings | null>(null)
  const [statement, setStatement] = useState<StatementState | null>(null)
  const [reminder, setReminder] = useState<ReminderDialogState | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const asked = useRef(address)
  asked.current = address

  const load = useCallback(async () => {
    if (!can.view) return
    const target = asked.current
    const slow = setTimeout(() => setAgeing((current) => (current.value || current.problem ? current : { ...current, slow: true })), SLOW_MS)
    try {
      const value = await getAgeing(api, ageingQueryOf(target, companyId))
      if (asked.current !== target) return
      setAgeing({ value, problem: null, slow: false })
      setRows(value.customers)
      setNext(value.next)
      setReadAt(Date.now())
      setUpdates(0)
    } catch (error) {
      if (asked.current === target) {
        setAgeing({ value: null, problem: readProblem(error), slow: false })
        setRows(null)
      }
    } finally {
      clearTimeout(slow)
    }
  }, [api, can.view, companyId])

  const loadReminders = useCallback(async () => {
    if (!can.view) return
    const view = asked.current.reminders
    try {
      const [page, count] = await Promise.all([listReminders(api, { companyId, view }), getReminderCounts(api, companyId)])
      if (asked.current.reminders !== view) return
      setReminders({
        value: page.reminders,
        problem: null,
        more: page.nextCursor !== null,
      })
      setReminderCursor(page.nextCursor)
      setCounts(count)
    } catch (error) {
      setReminders({ value: null, problem: readProblem(error), more: false })
    }
  }, [api, can.view, companyId])

  const loadSettings = useCallback(async () => {
    if (!can.view) return
    try {
      setSettings(await getReceivablesSettings(api, companyId))
    } catch {
      setSettings(null)
    }
  }, [api, can.view, companyId])

  const filterKey = `${address.bucket}|${address.party}|${address.q}|${address.asOf}`
  useEffect(() => {
    setAgeing({ value: null, problem: null, slow: false })
    setRows(null)
    void load()
  }, [load, filterKey])

  useEffect(() => {
    setReminders({ value: null, problem: null, more: false })
    void loadReminders()
  }, [loadReminders, address.reminders])

  useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  // The statement named by the address, in the period chosen in the dialog (default: 1 January → the as-of day).
  const ref = useMemo(() => statementOfAddress(address, companyId), [address, companyId])
  const refKey = ref ? statementKey(ref) : null
  const period = useRef<{ from: string | null; to: string | null }>({
    from: null,
    to: null,
  })
  const readStatement = useCallback(
    (target: StatementRef, chosen: { from: string | null; to: string | null }) => {
      setStatement((current) => ({
        ref: target,
        period: chosen,
        value: current && statementKey(current.ref) === statementKey(target) && current.value && current.period === chosen ? current.value : null,
        problem: null,
      }))
      getStatement(api, target.partyId, statementQueryOf(target, chosen, asked.current.asOf))
        .then((value) => setStatement((current) => (current && statementKey(current.ref) === statementKey(target) ? { ...current, value, problem: null } : current)))
        .catch((error: unknown) => setStatement((current) => (current && statementKey(current.ref) === statementKey(target) ? { ...current, value: null, problem: readProblem(error) } : current)))
    },
    [api],
  )
  useEffect(() => {
    if (!can.view) return
    if (!ref) {
      setStatement(null)
      period.current = { from: null, to: null }
      return
    }
    if (statement && statementKey(statement.ref) === refKey) return
    readStatement(ref, period.current)
  }, [refKey, can.view])

  const readReminder = useCallback(
    (id: string) => {
      setReminder((current) => (current?.id === id ? { ...current, problem: null } : { id, value: null, problem: null }))
      getReminder(api, id)
        .then((value) => setReminder((current) => (current?.id === id ? { ...current, id, value, problem: null } : current)))
        .catch((error: unknown) => setReminder((current) => (current?.id === id ? { id, value: null, problem: readProblem(error) } : current)))
    },
    [api],
  )
  useEffect(() => {
    if (!can.view) return
    if (!address.reminder) setReminder(null)
    else if (reminder?.id !== address.reminder) readReminder(address.reminder)
  }, [address.reminder, can.view])

  const live = useLive(
    (change) => {
      if (!liveTouches(change)) return
      setUpdates((count) => count + 1)
      if (change.type.startsWith('payment_reminder.') || change.type === 'receivables_settings.changed') {
        void loadReminders()
        if (change.type === 'receivables_settings.changed') void loadSettings()
      }
    },
    () => {
      void load()
      void loadReminders()
      void loadSettings()
    },
    can.view,
  )

  const go = (nextAddress: Partial<ReceivablesAddress>) =>
    router.replace(receivablesHref(prefix, { ...address, ...nextAddress }), {
      scroll: false,
    })
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
    },
    [],
  )

  const more = async () => {
    if (next === null) return
    try {
      const page = await getAgeing(api, ageingQueryOf(address, companyId, next))
      setRows((current) => [...(current ?? []), ...page.customers.filter((row) => !current?.some((seen) => statementKey(rowStatement(seen)) === statementKey(rowStatement(row))))])
      setNext(page.next)
    } catch (error) {
      setNotice({ tone: 'danger', words: { key: readProblem(error) } })
    }
  }

  const moreReminders = async () => {
    if (!reminderCursor) return
    try {
      const page = await listReminders(api, {
        companyId,
        view: address.reminders,
        cursor: reminderCursor,
      })
      setReminders((current) => ({
        value: [...(current.value ?? []), ...page.reminders.filter((entry) => !current.value?.some((seen) => seen.id === entry.id))],
        problem: null,
        more: page.nextCursor !== null,
      }))
      setReminderCursor(page.nextCursor)
    } catch (error) {
      setNotice({ tone: 'danger', words: { key: readProblem(error) } })
    }
  }

  /** One reminder move: the answer replaces the row and the open dialog; the list and the count read again. */
  const move = async (id: string, work: () => Promise<Reminder>, done: Notice): Promise<boolean> => {
    setBusy(true)
    try {
      const value = await work()
      setReminder((current) => (current?.id === id ? { id, value, problem: null } : current))
      setNotice(done)
      void loadReminders()
      return true
    } catch (error) {
      const problem = readProblem(error)
      setReminder((current) => (current?.id === id ? { ...current, actionProblem: problem } : current))
      if (!address.reminder || address.reminder !== id) setNotice({ tone: 'danger', words: { key: problem } })
      if (problem === 'problem.conflict' || problem === 'refusal.CHANGED') readReminder(id)
      return false
    } finally {
      setBusy(false)
    }
  }

  const model: ReceivablesModel = {
    prefix,
    can,
    today: romeToday(),
    address,
    ageing,
    rows,
    more: next !== null,
    readAt,
    live,
    updates,
    counts,
    reminders,
    settings,
    statement,
    reminder,
    busy,
    notice,
  }

  return (
    <ReceivablesView
      model={model}
      actions={{
        onAddress: go,
        onSearch: (text) => {
          if (searchTimer.current) clearTimeout(searchTimer.current)
          searchTimer.current = setTimeout(() => go({ q: text.trim() || null }), SEARCH_MS)
        },
        onRetry: (part) => {
          if (part === 'ageing') void load()
          if (part === 'reminders') void loadReminders()
          if (part === 'statement' && ref) readStatement(ref, period.current)
          if (part === 'reminder' && address.reminder) readReminder(address.reminder)
        },
        onMore: () => void more(),
        onMoreReminders: () => void moreReminders(),
        onShowUpdates: () => {
          void load()
          if (ref) readStatement(ref, period.current)
        },
        onExport: (picked, words, fileName) => downloadText(fileName, ageingCsv(picked, can, words, locale)),
        onPrint: (refs, chosen) => {
          if (refs.length === 0) return
          window.open(statementPdfHref(prefix, refs, chosen ?? { to: address.asOf }), '_blank', 'noopener')
        },
        onPeriod: (chosen) => {
          period.current = chosen
          if (ref) readStatement(ref, chosen)
        },
        onSendStatement: async (message) => {
          if (!ref) return false
          setBusy(true)
          try {
            const sent = await sendStatement(api, ref.partyId, {
              ...statementQueryOf(ref, period.current, address.asOf),
              message,
            })
            setStatement((current) => (current ? { ...current, sendProblem: null } : current))
            setNotice({
              tone: 'success',
              words: {
                key: 'notice.statementSent',
                params: { count: sent.to.length, to: sent.to.join(', ') },
              },
            })
            return true
          } catch (error) {
            setStatement((current) => (current ? { ...current, sendProblem: readProblem(error) } : current))
            return false
          } finally {
            setBusy(false)
          }
        },
        onApproveMany: async (picked) => {
          if (picked.length === 0) return false
          const send = settings?.switch.on ?? false
          setBusy(true)
          try {
            const approved = await approveReminders(
              api,
              picked.map((entry) => ({ id: entry.id, version: entry.version })),
              send,
            )
            setNotice({
              tone: 'success',
              words: {
                key: send ? 'notice.approvedSent' : 'notice.approvedWaiting',
                params: { count: approved.length },
              },
            })
            void loadReminders()
            return true
          } catch (error) {
            const refusals = bulkRefusalsOf(error)
            setNotice(
              refusals.length > 0
                ? {
                    tone: 'danger',
                    words: { key: 'notice.noneApproved' },
                    items: refusals.map((refusal) => ({
                      name: picked[refusal.index]?.customer.name ?? '?',
                      words: {
                        key: refusal.code === 'version' ? 'problem.conflict' : `refusal.${refusal.code}`,
                      },
                    })),
                  }
                : { tone: 'danger', words: { key: readProblem(error) } },
            )
            void loadReminders()
            return false
          } finally {
            setBusy(false)
          }
        },
        onApprove: (entry, input) =>
          move(
            entry.id,
            () =>
              approveReminder(api, entry.id, {
                version: entry.version,
                ...input,
              }),
            {
              tone: 'success',
              words: {
                key: input.send ? 'notice.approvedSent' : 'notice.approvedWaiting',
                params: { count: 1 },
              },
            },
          ),
        onSend: (entry, callNote) =>
          move(
            entry.id,
            () =>
              sendReminder(api, entry.id, {
                version: entry.version,
                ...(callNote ? { callNote } : {}),
              }),
            { tone: 'success', words: { key: 'notice.sent' } },
          ),
        onEdit: (entry, input) => move(entry.id, () => editReminder(api, entry.id, { version: entry.version, ...input }), { tone: 'success', words: { key: 'notice.edited' } }),
        onSkip: (entry, reason) => move(entry.id, () => skipReminder(api, entry.id, { version: entry.version, reason }), { tone: 'success', words: { key: 'notice.skipped' } }),
        onCancel: (entry, reason) => move(entry.id, () => cancelReminder(api, entry.id, { version: entry.version, reason }), { tone: 'success', words: { key: 'notice.cancelled' } }),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
