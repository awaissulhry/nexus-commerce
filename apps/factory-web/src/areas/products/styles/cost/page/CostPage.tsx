'use client'

import { useCallback, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import type { ApiClient } from '../../../../../lib/api/client'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { StyleView } from '../../api'
import { moneyText, revisionInView } from '../../model'
import type { StyleRecordActions, StyleRecordViewModel } from '../../record/record-model'
import { lineWords } from '../../components/model'
import { useOfficeReach } from '../../routing/route/office'
import { CS_NS } from '../../versions/model'
import { useCostSheets } from '../../versions/use-cost-sheets'
import { keepCost, readPriceAgainstCost, type PriceAgainstCost } from '../now/api'
import { costOfOne, costSizeOf, howOf, keepDoneOf, keepHeldOf, linesOfPart, problemKeyOf, refusalOf, topLineOf, type Words } from '../now/model'
import { readSettings } from '../rates/api'
import { settingsInForce } from '../rates/model'
import { whatIf, whatIfBaseOf, type WhatIfInput } from '../whatif/model'
import { CostPageView, type CostPageModel } from './view/CostPageView'

/**
 * owb-pd5b step 5.3 (S4) — the container of the product tab "Cost" (mounted by the tab's view, as the Route tab mounts its own): the
 * cost sheets of W2b (versions/use-cost-sheets: the live components, the versions, by size, the target price, the size mix — read ONCE
 * here; the record's `costSheets` slot draws nothing now), the price against cost (pd3), the company's switch for Keep, and Keep itself.
 * After Keep: a notice (kept, version n · sent to Finance), the price against cost read again, the record told (its reads follow).
 * Outside the office (the design index, a test's render) it is not mounted: the tab draws today's sheet (view/CostTab.tsx).
 */

export interface CostPageProps {
  readonly style: StyleView
  readonly model: StyleRecordViewModel
  readonly actions?: StyleRecordActions
  /** Today's sheet line by line (W1), drawn under "More". */
  readonly detail?: ReactNode
  /** What the tab draws outside the office (no session: the design index, a test's render). */
  readonly fallback?: ReactNode
}

export function CostPage(props: CostPageProps): ReactElement | null {
  const { api, companyId } = useOfficeReach()
  if (!api) return <>{props.fallback ?? null}</>
  return (
    <WithMessages namespaces={[CS_NS, 'products-cost']}>
      <Page {...props} api={api} companyId={props.style.companyId ?? companyId} />
    </WithMessages>
  )
}

type Read<T> = { status: 'reading' } | { status: 'failed'; problem: string } | { status: 'ready'; value: T }

const NO_INPUT: WhatIfInput = { materialsPct: '', workPct: '', price: '' }

function Page({ style, model, actions, detail, api, companyId }: CostPageProps & { api: ApiClient; companyId: string | null }): ReactElement {
  const t = useT('products-cost')
  const ts = useT(CS_NS)
  const tp = useT('products')
  const locale = useLocale()
  const revision = revisionInView(style.revisions, model.revisionId)
  const revisionId = revision?.id ?? null
  const sheets = useCostSheets({ style, revisionId, cell: model.costCell })
  const [price, setPrice] = useState<Read<PriceAgainstCost>>({ status: 'reading' })
  const [alone, setAlone] = useState(false)
  const [round, setRound] = useState(0)
  const again = useCallback(() => setRound((value) => value + 1), [])
  const [keepOpen, setKeepOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [keeping, setKeeping] = useState(false)
  const [keepProblem, setKeepProblem] = useState<Words | null>(null)
  const [notice, setNotice] = useState<Words | null>(null)
  const [input, setInput] = useState<WhatIfInput>(NO_INPUT)

  useEffect(() => {
    if (!revisionId) return
    const control = new AbortController()
    readPriceAgainstCost(api, style.id, revisionId, control.signal).then(
      (value) => setPrice({ status: 'ready', value }),
      (error: unknown) => {
        if (!control.signal.aborted) setPrice({ status: 'failed', problem: problemKeyOf(error) })
      },
    )
    return () => control.abort()
  }, [api, style.id, revisionId, round])

  // The company's switch "one person may keep a cost": the Keep window says before the press who keeps it.
  useEffect(() => {
    const control = new AbortController()
    readSettings(api, companyId, control.signal).then(
      (settings) => setAlone(settingsInForce(settings).oneKeeper),
      () => undefined, // unknown: the window says Finance approves it (the default); the server's answer says what happened
    )
    return () => control.abort()
  }, [api, companyId, round])

  const pac = price.status === 'ready' ? price.value : null
  const currency = pac?.currency ?? 'EUR'
  const money = useCallback((amount: string | null | undefined) => moneyText(amount, currency, locale), [currency, locale])
  const components = sheets.model.steps?.components
  const view = components?.status === 'ready' ? components.value : null
  const size = view ? costSizeOf(view, model.costCell?.size ?? null, style.baseSize) : null
  const cost = view && size ? costOfOne(view, size) : null
  const costNow = pac?.costNow ?? cost?.total ?? null
  const kindWords = (kind: string) => tp(`kind.${kind}`)
  const number = (value: string) => new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: 3 }).format(Number(value))

  const rows = useMemo(() => {
    if (!view || !size || !cost) return []
    return cost.parts.map((part) => {
      const lines = linesOfPart(view, size, part.part)
      const shown = lines.slice(0, 3).map((line, index) => {
        const phrase = lineWords(line, kindWords)
        const name = line.category === 'LABOUR' && line.workCentreKind ? tp(`department.${line.workCentreKind}`) : ts(phrase.key, phrase.params)
        const how = line.uom === null && line.category === 'LABOUR' ? t('now.line.minutes', { minutes: number(line.quantity) }) : line.uom ? `${number(line.quantity)} ${tp(`uom.${line.uom}`)}` : ''
        return { key: `${line.category}:${line.sourceRecordId ?? index}`, name, how, amount: line.cost ?? null }
      })
      return { part: part.part, amount: part.amount, share: part.share, how: howOf(view, size, part.part), lines: shown, more: Math.max(0, lines.length - 3) }
    })
    // The words functions follow the language: the language is the dependency.
  }, [view, size, cost, locale])

  const keep = async () => {
    if (!revisionId || !pac || keepHeldOf({ costNow: pac.costNow, kept: pac.kept, reason, busy: keeping })) return
    setKeeping(true)
    setKeepProblem(null)
    try {
      const answer = await keepCost(api, style.id, revisionId, { reason: reason.trim(), expectedTotal: pac.costNow! })
      setNotice(keepDoneOf(answer, money))
      setKeepOpen(false)
      setReason('')
      again()
      actions?.onReload?.()
    } catch (error) {
      setKeepProblem(refusalOf(error))
      // The cost moved meanwhile: read again, so the window shows the new cost before the next press.
      if ((error as { kind?: string } | null)?.kind === 'conflict') again()
    } finally {
      setKeeping(false)
    }
  }

  const target = pac?.targetPct ?? '0'
  const pageModel: CostPageModel = {
    top: topLineOf({ kept: pac ? pac.kept : undefined, costNow, rows: pac ? pac.rows : null, targetPct: target }, (amount) => money(amount)),
    frozen: revision && revision.status !== 'DRAFT' ? { revision: revision.revision } : null,
    notice,
    now: {
      state: components === undefined || components.status === 'idle' || components.status === 'loading' ? 'reading' : components.status === 'error' ? 'failed' : cost ? 'ready' : 'empty',
      problem: components?.status === 'error' ? 'problem.unavailable' : null,
      cost,
      rows,
      missing: view ? view.missing.filter((entry) => entry.size === null || entry.size === size).length : 0,
      money,
      keepHeld: pac ? keepHeldOf({ costNow: pac.costNow, kept: pac.kept, reason: '·', busy: keeping }) : price.status === 'reading' ? { key: 'keep.held.reading' } : { key: 'keep.held.noPrices' },
    },
    price: { state: price.status, problem: price.status === 'failed' ? price.problem : null, targetPct: target, rows: pac?.rows ?? [], lowest: pac?.lowestPriceForTarget ?? null, money },
    whatIf: cost ? { input, answer: whatIf(whatIfBaseOf(cost), input, Number(target)), targetPct: Number(target), partial: !cost.complete, money } : null,
    keep:
      keepOpen && pac && pac.costNow !== null
        ? {
            counts: pac.kept ? { key: 'keep.counts', params: { amount: money(pac.kept.amount) } } : { key: 'keep.countsRough' },
            costNow: money(pac.costNow),
            reason,
            alone,
            held: keepHeldOf({ costNow: pac.costNow, kept: pac.kept, reason, busy: keeping }),
            busy: keeping,
            problem: keepProblem,
          }
        : null,
    sheets: sheets.model,
  }

  return (
    <CostPageView
      model={pageModel}
      actions={{
        onKeepOpen: () => {
          setKeepOpen(true)
          setKeepProblem(null)
          setNotice(null)
        },
        onKeepReason: setReason,
        onKeep: () => void keep(),
        onKeepClose: () => setKeepOpen(false),
        onRetryNow: () => actions?.onReload?.(),
        onRetryPrice: again,
        onWhatIf: setInput,
        onWhatIfClear: () => setInput(NO_INPUT),
        sheets: sheets.actions,
      }}
      detail={detail}
    />
  )
}
