'use client'

/**
 * CR rebuild 5 — one campaign's limits, opened from its Campaigns row. Every field here changes the DRAFT only; the
 * page's Review step saves it. A typed value that is not a number stays in its box with the reason under it, and is
 * not put in the draft. Without the ads campaigns permission every field is shown and none can be changed.
 */
import { useEffect, useState } from 'react'
import { Button, Input, Toggle } from '@/design-system/primitives'
import { Banner, Drawer, Field, KeyValue } from '@/design-system/components'
import {
  CEILING_WORD, PARTS, PART_WORD, currencyOf, moneyInput, moneyWords, parseMoney, parseMultiple, problemsOf, suppressedWords, valuesOf,
  type CampaignEdit, type CampaignRow,
} from './campaignDraft'
import styles from './campaigns.module.css'

const symbolOf = (currency: string | null) => {
  if (!currency) return null
  const part = new Intl.NumberFormat('en-IE', { style: 'currency', currency }).formatToParts(0).find((p) => p.type === 'currency')
  return part?.value ?? currency
}

export function CampaignDrawer({ row, edit, canEdit, onEdit, onClose }: {
  row: CampaignRow
  edit: CampaignEdit | undefined
  /** False without the ads campaigns permission: the panel only shows. */
  canEdit: boolean
  onEdit: (patch: CampaignEdit) => void
  onClose: () => void
}) {
  const v = valuesOf(row, edit)
  const currency = currencyOf(row.marketplace)
  const symbol = symbolOf(currency)
  // The boxes keep what was typed, so half-typed text is never replaced while the person types.
  const [minText, setMinText] = useState(moneyInput(v.minBidCents))
  const [maxText, setMaxText] = useState(moneyInput(v.maxBidCents))
  const [cpcText, setCpcText] = useState(v.cpcMultiple == null ? '' : String(v.cpcMultiple))
  useEffect(() => {
    setMinText(moneyInput(valuesOf(row, edit).minBidCents))
    setMaxText(moneyInput(valuesOf(row, edit).maxBidCents))
    const m = valuesOf(row, edit).cpcMultiple
    setCpcText(m == null ? '' : String(m))
    // Only when another campaign opens: an edit made here must not reset its own box.
  }, [row.id])

  const minBad = Number.isNaN(parseMoney(minText) as number)
  const maxBad = Number.isNaN(parseMoney(maxText) as number)
  const cpcBad = Number.isNaN(parseMultiple(cpcText) as number)
  const problems = problemsOf(row, edit)

  return (
    <Drawer
      open
      onClose={onClose}
      title={row.name}
      subtitle={[row.marketplace ?? 'No market', row.portfolioName, row.status !== 'ENABLED' ? row.status.toLowerCase() : null].filter(Boolean).join(' · ')}
      width="min(560px, 94vw)"
      footer={(
        <span className={styles.footer}>
          <span className={styles.muted}>{canEdit ? 'Changes here are not saved yet. Review them on the page.' : 'You can see these limits. Changing them needs the ads campaigns permission.'}</span>
          <Button size="sm" variant="primary" onClick={onClose}>Done</Button>
        </span>
      )}
    >
      <div className={styles.stack}>
        {problems.length > 0 && (
          <Banner tone="danger" title="This cannot be saved yet">
            {problems.join(' ')}
          </Banner>
        )}

        <Field
          label="Automation may change it"
          hint="No: every automated change to this campaign is refused. Turning a paused campaign back on does not set this back to Yes."
        >
          <span className={styles.inline}>
            <Toggle checked={v.allowed} disabled={!canEdit} onChange={(next) => onEdit({ allowed: next })} aria-label="Automation may change it" />
            <span>{v.allowed ? 'Yes' : 'No'}</span>
          </span>
        </Field>

        <div className={styles.pair}>
          <Field label="Lowest bid" hint="Empty: no lowest bid of its own." error={minBad ? 'Type an amount, like 0.20.' : undefined}>
            <Input
              size="sm"
              inputMode="decimal"
              prefix={symbol ?? undefined}
              disabled={!canEdit}
              value={minText}
              placeholder="—"
              onChange={(e) => {
                setMinText(e.target.value)
                const cents = parseMoney(e.target.value)
                if (cents === null || Number.isFinite(cents)) onEdit({ minBidCents: cents })
              }}
            />
          </Field>
          <Field label="Highest bid" hint="Empty: no highest bid of its own." error={maxBad ? 'Type an amount, like 1.50.' : undefined}>
            <Input
              size="sm"
              inputMode="decimal"
              prefix={symbol ?? undefined}
              disabled={!canEdit}
              value={maxText}
              placeholder="—"
              onChange={(e) => {
                setMaxText(e.target.value)
                const cents = parseMoney(e.target.value)
                if (cents === null || Number.isFinite(cents)) onEdit({ maxBidCents: cents })
              }}
            />
          </Field>
        </div>
        <span className={styles.muted}>Every engine and rule keeps bids inside these two, on every change sent to Amazon.</span>

        <Field
          label={`${CEILING_WORD} (× usual click cost)`}
          hint="From 1 to 10 times the usual click cost. Empty: off. It limits your own bid edits and Claude’s tools only — not the engines."
          error={cpcBad ? 'Type a number, like 1.5.' : undefined}
        >
          <Input
            size="sm"
            inputMode="decimal"
            disabled={!canEdit}
            suffix="×"
            value={cpcText}
            placeholder="—"
            onChange={(e) => {
              setCpcText(e.target.value)
              const m = parseMultiple(e.target.value)
              if (m === null || Number.isFinite(m)) onEdit({ cpcMultiple: m })
            }}
          />
        </Field>

        <Field label="Locked" hint="Automation may not change a locked part. Lowering bids to stop a campaign is still allowed.">
          <span className={styles.locks}>
            {PARTS.map((part) => (
              <span key={part} className={styles.inline}>
                <Toggle
                  size="sm"
                  checked={v.pins[part]}
                  disabled={!canEdit}
                  onChange={(next) => onEdit({ pins: { [part]: next } })}
                  aria-label={`${PART_WORD[part]} locked`}
                />
                <span>{PART_WORD[part]}</span>
              </span>
            ))}
          </span>
        </Field>

        <KeyValue
          columns={2}
          items={[
            { label: 'Target ACoS', value: row.targetAcosPct == null ? 'None of its own' : `${row.targetAcosPct} %`, hint: row.targetAcosPct == null ? 'The strategy’s target (or the account’s) applies.' : undefined },
            { label: 'Budget a day', value: moneyWords(row.dailyBudgetCents, currency) },
            { label: 'Bids held low', value: suppressedWords(row) },
            { label: 'Its own rules', value: row.boundRules.length ? row.boundRules.map((r) => r.name).join(', ') : 'None' },
            ...(row.pinnedBy ? [{ label: 'Locked by', value: row.pinnedBy.startsWith('user:') ? 'A person' : row.pinnedBy, hint: row.pinNote ?? undefined }] : []),
          ]}
        />
      </div>
    </Drawer>
  )
}
