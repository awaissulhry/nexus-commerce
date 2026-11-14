'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useCoalesced, useLive } from '../../_shared/hooks'
import { readProblem } from '../../_shared/model'
import { addCurrency, getCurrencies, listRates, readEcbNow, removeManualRate, setManualRate, switchCurrency, switchFeed, type Currencies, type Currency, type RateDay, type Rates } from './api'
import { abilitiesOf, currenciesTouched, currencyProblem, currencyViewOf, shiftDay, typedRate, type CurrencyProblem, type RateDialog, type RateDraft, type RatePeriod, type Read } from './model'
import { CurrenciesSection, type CurrenciesSectionModel } from './view/CurrenciesSection'

/**
 * Finance › Settings › Currencies & rates (B-W2b-389), the container: reads the company's currencies (GET /currencies) and
 * the rates table of the chosen days and currency (GET /exchange-rates), writes through the API (a currency added or
 * switched, the daily ECB switch, reading the ECB file now, a manual rate kept, corrected or removed: each with an
 * Idempotency-Key and the row's version), and reads again on a live change of another person. The view draws it.
 */
export function CurrenciesContainer({ companyId }: { companyId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const view = currencyViewOf(session.permissions)
  const [currencies, setCurrencies] = useState<Read<Currencies>>({ value: null, problem: null })
  const [rates, setRates] = useState<Read<Rates>>({ value: null, problem: null })
  const [quote, setQuote] = useState<string | null>(null)
  const [period, setPeriod] = useState<RatePeriod>(30)
  const [dialog, setDialog] = useState<RateDialog | null>(null)
  const [dialogProblem, setDialogProblem] = useState<CurrencyProblem | null>(null)
  const [removing, setRemoving] = useState<readonly RateDay[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<CurrenciesSectionModel['notice']>(null)
  const can = useMemo(() => abilitiesOf(session.permissions, currencies.value), [session.permissions, currencies.value])

  const readCurrencies = useCallback(async () => {
    if (!view) return
    try {
      setCurrencies({ value: await getCurrencies(api, companyId), problem: null })
    } catch (error) {
      setCurrencies({ value: null, problem: readProblem(error) })
    }
  }, [api, companyId, view])

  const readRates = useCallback(async () => {
    if (!view) return
    try {
      const to = currencies.value?.today
      setRates({ value: await listRates(api, { quote, ...(to ? { to, from: shiftDay(to, -period) } : {}) }), problem: null })
    } catch (error) {
      setRates({ value: null, problem: readProblem(error) })
    }
  }, [api, currencies.value?.today, period, quote, view])

  useEffect(() => {
    setCurrencies({ value: null, problem: null })
    void readCurrencies()
  }, [readCurrencies])
  useEffect(() => {
    void readRates()
  }, [readRates])
  const reread = useCoalesced(() => {
    void readCurrencies()
    void readRates()
  }, 800)
  useLive(
    (change) => {
      if (currenciesTouched(change)) reread()
    },
    () => reread(),
    view,
  )

  /** One write: busy while it runs, a notice when done, the problem in words when refused (and a read again when moved). */
  const write = async <T,>(work: () => Promise<T>, done: (result: T) => CurrenciesSectionModel['notice'], onProblem?: (problem: CurrencyProblem) => void) => {
    if (busy) return
    setBusy(true)
    try {
      setNotice(done(await work()))
      await Promise.all([readCurrencies(), readRates()])
    } catch (error) {
      const problem = currencyProblem(error)
      if (onProblem) onProblem(problem)
      else setNotice({ tone: 'danger', words: problem })
      if (problem.reload) await Promise.all([readCurrencies(), readRates()])
    } finally {
      setBusy(false)
    }
  }

  const model: CurrenciesSectionModel = { can, currencies, rates, quote, period, dialog, dialogProblem, removing, busy, notice }
  return (
    <CurrenciesSection
      model={model}
      actions={{
        onRetry: () => {
          void readCurrencies()
          void readRates()
        },
        onQuote: setQuote,
        onPeriod: setPeriod,
        onAdd: (code) => void write(() => addCurrency(api, companyId, code, newIdempotencyKey()), () => ({ tone: 'success', words: { key: 'notice.added', params: { code } } })),
        onSwitch: (currency: Currency, active: boolean) => void write(() => switchCurrency(api, currency, active, newIdempotencyKey()), () => ({ tone: 'success', words: { key: active ? 'notice.on' : 'notice.off', params: { code: currency.code } } })),
        onFeed: (on) => void write(() => switchFeed(api, on, newIdempotencyKey()), () => ({ tone: 'success', words: { key: on ? 'notice.feedOn' : 'notice.feedOff' } })),
        onReadNow: () =>
          void write(
            () => readEcbNow(api, newIdempotencyKey()),
            (answer) => (answer.rows > 0 ? { tone: 'success', words: { key: 'notice.read', params: { count: answer.addedDays.length } } } : { tone: 'info', words: { key: 'notice.readNothing' } }),
          ),
        onDialog: (next) => {
          setDialog(next)
          setDialogProblem(null)
        },
        onSaveRate: (current: RateDialog, draft: RateDraft) =>
          void write(
            async () => {
              await setManualRate(api, { base: currencies.value?.company.base ?? 'EUR', quote: draft.quote, day: draft.day.trim(), rate: typedRate(draft.rate), ...(current.mode === 'correct' && current.row.manual ? { version: current.row.manual.version } : {}) }, newIdempotencyKey())
              setDialog(null)
            },
            () => ({ tone: 'success', words: { key: 'notice.rateSaved', params: { quote: draft.quote, day: draft.day } } }),
            setDialogProblem,
          ),
        onRemove: (rows) => setRemoving(rows),
        onConfirmRemove: () =>
          void write(
            async () => {
              for (const row of removing ?? []) if (row.manual) await removeManualRate(api, { id: row.manual.id, version: row.manual.version }, newIdempotencyKey())
              setRemoving(null)
            },
            () => ({ tone: 'success', words: { key: 'notice.removed', params: { count: removing?.length ?? 0 } } }),
          ),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
