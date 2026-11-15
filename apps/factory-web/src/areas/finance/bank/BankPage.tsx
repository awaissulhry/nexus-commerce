'use client'

import { useMemo } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { downloadText, useCoalesced, useLive } from '../_shared/hooks'
import { romeToday } from '../_shared/model'
import { addressOf, amountText, bankCanOf, bankHref, bestOf, BANK_NAMESPACES, figuresTouched, linesCsv, linesTouched, type BankAddress } from './model'
import type { BankLine } from './api'
import { useFigures } from './use-figures'
import { useImport } from './use-import'
import { useLines } from './use-lines'
import { BankView, type BankModel } from './view/BankView'

/**
 * `/w/<company>/finance/bank` (SCR-152; B-W2b-406 on B-W2b-393's API and its own `modules/receivables/their-figures`): the
 * tiles and the lines (`useLines`), the import (`useImport`), their figures vs ours (`useFigures`); the address keeps the
 * view (a tile = a saved filter), the open line, the statement, the import and the figures open. Live: a bank, payment,
 * invoice or deposit event counts behind "N updates · Show" (the tiles and the open line are read again at once); their
 * figures are read again on theirs or on our books moving. Without payments.bank.view it asks the API nothing (the view
 * says why).
 */
export function BankPage() {
  return (
    <WithMessages namespaces={[...BANK_NAMESPACES]}>
      <Bank />
    </WithMessages>
  )
}

function Bank() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const t = useT('finance-bank')
  const locale = useLocale()
  const prefix = pathname.replace(/\/finance\/bank\/?$/, '')
  const can = useMemo(() => bankCanOf(session.permissions), [session.permissions])
  const address = useMemo(() => addressOf(params), [params])
  const companyId = session.company?.id ?? null
  const today = romeToday()
  const go = (next: Partial<BankAddress>) => router.replace(bankHref(prefix, { ...address, ...next }), { scroll: false })

  const lines = useLines(api, can, companyId, address, go)
  const importing = useImport(api, can, companyId, address.importing, () => void lines.reload())
  const figures = useFigures(api, can, companyId, address, go, today, locale)

  const again = useCoalesced(() => {
    void lines.loadCounts()
    if (address.line) void lines.loadAlone()
  }, 800)
  const figuresAgain = useCoalesced(() => {
    void figures.loadList()
    if (address.figures && address.figures !== 'new') void figures.loadOpen()
  }, 1500)
  const live = useLive(
    (change) => {
      if (linesTouched(change)) {
        lines.bump()
        again()
      }
      if (can.receivables && figuresTouched(change)) figuresAgain()
    },
    () => {
      void lines.reload()
      void figures.loadList()
    },
    can.view || can.receivables,
  )

  const words = {
    header: (key: string) => t(`csv.${key}`),
    state: (line: BankLine) => t(line.state === 'MATCHED' ? 'lines.matched' : 'view.TO_MATCH'),
    confidence: (line: BankLine) => {
      const match = line.accepted ?? bestOf(line)
      return match ? t(`confidence.${match.confidence}`) : ''
    },
    amount: (minor: number) => amountText(minor, locale),
  }

  const model: BankModel = {
    prefix,
    can,
    today,
    address,
    ...lines.model,
    notice: lines.model.notice ?? figures.notice,
    live,
    importing: address.importing ? importing.model : null,
    figures: figures.model,
  }

  return (
    <BankView
      model={model}
      actions={{
        onAddress: go,
        onRetry: (part) => void (part === 'counts' ? lines.loadCounts() : part === 'lines' ? lines.loadLines() : lines.loadAlone()),
        onMore: () => void lines.more(),
        onShowUpdates: () => void lines.reload(),
        onOpenLine: (lineId) => go({ line: lineId }),
        onRefresh: () => void lines.refresh(),
        onExport: (rows) => downloadText(`${t('csv.file')}-${today}.csv`, linesCsv(rows, can.price, words)),
        onReview: (rows) => void lines.openReview(rows),
        onDismissNotice: () => {
          lines.setNotice(null)
          figures.setNotice(null)
        },
        match: {
          onPick: (matchId) => lines.setMatch((state) => ({ ...state, picked: matchId, writeOff: { ...state.writeOff, on: false }, problems: null })),
          onWriteOff: (next) => lines.setMatch((state) => ({ ...state, writeOff: next })),
          onLockReason: (text) => lines.setMatch((state) => ({ ...state, lockReason: text })),
          onAccept: () => void lines.accept(),
          onChoose: () => lines.openChoose(),
          onReverse: () => lines.openReverse(),
          onStep: (by) => lines.step(by),
        },
        review: { onSave: () => void lines.saveReview(), onClose: () => lines.closeReview() },
        choose: {
          onSearch: (q) => void lines.searchCustomers(q),
          onCustomer: (customer) => {
            lines.setChoose((state) => (state ? { ...state, customer, items: null, itemsProblem: null, typed: {}, problems: null } : state))
            if (customer) void lines.loadItems(customer.id)
            else void lines.searchCustomers('')
          },
          onTyped: (typed) => lines.setChoose((state) => (state ? { ...state, typed, problems: null } : state)),
          onWriteOff: (next) => lines.setChoose((state) => (state ? { ...state, writeOff: next } : state)),
          onLockReason: (text) => lines.setChoose((state) => (state ? { ...state, lockReason: text } : state)),
          onRetryItems: () => {
            const partyId = lines.model.choose?.customer?.id
            if (partyId) void lines.loadItems(partyId)
          },
          onSubmit: () => void lines.submitChoose(),
          onClose: () => lines.setChoose(null),
        },
        reverse: {
          onReason: (text) => lines.setReverse((state) => (state ? { ...state, reason: text } : state)),
          onLockReason: (text) => lines.setReverse((state) => (state ? { ...state, lockReason: text } : state)),
          onSubmit: () => void lines.submitReverse(),
          onClose: () => lines.setReverse(null),
        },
        importing: {
          ...importing.actions,
          onClose: () => {
            importing.reset()
            go({ importing: false })
          },
        },
        figures: {
          ...figures.actions,
          onExport: (rows) =>
            downloadText(
              `${t('csv.figuresFile')}-${today}.csv`,
              `﻿${[
                [t('figures.col.customer'), t('figures.col.asOf'), ...(can.price ? [t('figures.theirBalance'), t('figures.ourBalance'), t('figures.col.difference')] : []), t('figures.col.state')],
                ...rows.map((row) => [
                  `${row.customer.name} (${row.customer.code})`,
                  row.asOf,
                  ...(can.price ? [amountText(row.theirs.balance ?? 0, locale), amountText(row.summary.ours ?? 0, locale), amountText(row.summary.difference ?? 0, locale)] : []),
                  row.summary.state === 'AGREES' ? t('figures.agrees') : t('figures.differs', { count: row.summary.differences }),
                ]),
              ]
                .map((row) => row.map((cell) => (/[;"\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(';'))
                .join('\r\n')}\r\n`,
            ),
        },
      }}
    />
  )
}
