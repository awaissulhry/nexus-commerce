'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { AsyncListboxPanel, DetailPopover, type ListboxOption } from '@nexus/ui/components'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { switcherFace, switcherLines, type Phrase, type SwitcherCustomer, type SwitcherState } from '../model'
import '../customer-switcher.css'

/** The switcher's words: the `orders-sheet` catalogue (`switcher.*`), one set for every list. */
const NAMESPACE = 'orders-sheet'

export interface CustomerSwitcherProps {
  state: SwitcherState
  party: string | null
  /** The chosen customer's name when the switcher's page does not hold it (from the rows or its record); null: not available. */
  partyName: string | null | undefined
  /** The search typed in the open list (Orders: the page reads the customers that match; the others search what they read). */
  query: string
  searching: boolean
  onQuery?: (query: string) => void
  /** A customer, null for all of them, or the value of an `extra` choice. */
  onPick?: (party: string | null) => void
  onRetry?: () => void
  /** Each customer's words after its name (Orders: "3 open · 1 late"); none: names only (no number rather than a wrong one). */
  trailing?: (customer: SwitcherCustomer) => ReactNode
  /** Choices after the first one that are not a customer (Incoming: "Prospects only (no customer yet)"). */
  extra?: ReadonlyArray<{ readonly value: string; readonly label: string }>
  /** The `extra` choice the list shows now (its face names it). */
  extraValue?: string | null
  /** The first choice's words (default "All customers"; Incoming: "Every customer and prospect"). */
  allLabel?: string
  /** How many customers are "Recent" (Orders reads them recent first: 2; a names-only list: 0). */
  recent?: number
  /** What it chooses for: the sheet's orders (default), or a list's rows (Quotes, Incoming, Riders: their own words). */
  subject?: 'orders' | 'list'
  /** Design cases: open at start. */
  open?: boolean
}

/**
 * F-SA-224 (sales page plan N5, pick P18; 12-lists-board §5 rule 4): "Customer: All customers ▾" beside a Sales list's views
 * (SHEET.switcher-F01; moved here from the Orders sheet, B-TH-226) — a DS DetailPopover whose panel is the DS AsyncListboxPanel:
 * search, then "All customers" (or "All my customers (n)") on top, the recent customers, the others by name, each with what its
 * list counts (`trailing`, Orders only). A reader limited to one customer reads a fixed label; with no customer yet it is absent.
 */
export function CustomerSwitcher(props: CustomerSwitcherProps) {
  return (
    <WithMessages namespaces={[NAMESPACE]}>
      <Switcher {...props} />
    </WithMessages>
  )
}

function Switcher({ state, party, partyName, query, searching, onQuery, onPick, onRetry, trailing, extra, extraValue, allLabel, recent = 2, subject = 'orders', open: startOpen }: CustomerSwitcherProps) {
  const t = useT(NAMESPACE)
  const say = (phrase: Phrase) => t(phrase.key, phrase.params)
  // A design case opens it after the first paint (a popover is portaled to <body>: never in the server's HTML).
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (startOpen) setOpen(true)
  }, [startOpen])
  const chosenExtra = extraValue ? (extra?.find((choice) => choice.value === extraValue) ?? null) : null
  const face = switcherFace(state, party, partyName)
  if (face.kind === 'hidden' && !extra?.length) return null
  if (face.kind === 'fixed')
    return (
      <span className="fw-switcher-fixed" title={t('switcher.fixedHint')}>
        {t('switcher.fixed', { name: face.name })}
      </span>
    )
  const all = allLabel ?? (state.limited ? t('switcher.allMine', { count: state.total }) : t('switcher.all'))
  const label = chosenExtra ? chosenExtra.label : face.kind === 'button' ? (allLabel && !party && !state.limited ? allLabel : say(face.label)) : all
  const lines = switcherLines(state.customers ?? [], query.trim() !== '', { all, recent: t('switcher.recent'), others: t(state.limited ? 'switcher.mine' : 'switcher.everyone', { count: state.total }) }, recent)
  const byId = new Map((state.customers ?? []).map((customer) => [customer.id, customer]))
  const options: ListboxOption[] = [
    ...lines.slice(0, query.trim() ? 0 : 1).map((line) => ({ value: line.value, label: line.label })),
    ...(query.trim() ? [] : (extra ?? []).map((choice) => ({ value: choice.value, label: choice.label }))),
    ...lines.slice(query.trim() ? 0 : 1).map((line) => {
      const customer = byId.get(line.value)
      const after = customer && trailing ? trailing(customer) : null
      return {
        value: line.value,
        label: line.label,
        ...(line.group ? { group: line.group } : {}),
        title: line.archived ? `${line.label} · ${t('switcher.archived')}` : line.label,
        ...(after || line.archived
          ? {
              trailing: (
                <span className="fw-switcher-n">
                  {after}
                  {line.archived && `${after ? ' · ' : ''}${t('switcher.archived')}`}
                </span>
              ),
            }
          : {}),
      }
    }),
  ]
  const shown = state.customers?.length ?? 0
  const message = state.customers && state.total > shown ? t('switcher.typeToFind', { count: state.total - shown }) : undefined
  return (
    <DetailPopover
      open={open}
      onOpenChange={setOpen}
      hoverDelay={0}
      trigger={
        <span className="fw-switcher">
          {label}
          <ChevronDown size={13} aria-hidden />
        </span>
      }
      triggerClassName="nds-btn sm fw-switcher-btn"
      triggerLabel={`${label} — ${t(subject === 'list' ? 'switcher.triggerList' : 'switcher.trigger')}`}
      label={t('switcher.title')}
      panelClassName="fw-switcher-panel"
    >
      {({ close }) => (
        <AsyncListboxPanel
          label={t('switcher.search')}
          placeholder={t('switcher.searchHint')}
          query={query}
          onQueryChange={(next) => onQuery?.(next)}
          options={options}
          value={chosenExtra ? chosenExtra.value : (party ?? '')}
          loading={state.customers === null || searching}
          error={state.problem ? t('switcher.failed') : undefined}
          onRetry={onRetry}
          message={state.customers === null || searching ? t('switcher.reading') : message}
          emptyMessage={query.trim() ? t('switcher.noMatch', { q: query.trim() }) : t(subject === 'list' ? 'switcher.noneList' : 'switcher.none')}
          onCommit={(value) => {
            onPick?.(value || null)
            close({ returnFocus: true })
          }}
          onCancel={() => close({ returnFocus: true })}
        />
      )}
    </DetailPopover>
  )
}
