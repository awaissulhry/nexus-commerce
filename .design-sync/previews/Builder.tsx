import { useState } from 'react'
import { Builder, Input, Pill, Select, Toggle } from '@nexus/design-system'

const Field = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 16, maxWidth: 420 }}>
    <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>{label}</span>
    {children}
    {hint && <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{hint}</span>}
  </div>
)

const Note = ({ children }: { children: React.ReactNode }) => (
  <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-secondary)', margin: '0 0 12px', maxWidth: 520 }}>
    {children}
  </p>
)

/** The rule builder: full-screen top bar, a scroll-spy nav pinned left, sections scrolling right. */
export const RuleBuilder = () => {
  const [enabled, setEnabled] = useState(true)
  return (
    <Builder
      open
      onClose={() => {}}
      title="Create rule · Lower bids above target ACOS"
      primaryLabel="Create rule"
      onPrimary={() => {}}
      sections={[
        {
          id: 'name',
          label: 'Rule name',
          title: 'Rule name',
          content: (
            <>
              <Field label="Name" hint="Shown in Rules & Automation and in every action log entry.">
                <Input defaultValue="Lower bids above 35% ACOS" />
              </Field>
              <Field label="Run this rule">
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--text-secondary)' }}>
                  <Toggle checked={enabled} onChange={setEnabled} aria-label="Rule enabled" />
                  <span>Enabled · evaluates every day at 08:00 Europe/Rome</span>
                </label>
              </Field>
            </>
          ),
        },
        {
          id: 'scope',
          label: 'Scope',
          title: 'Scope',
          content: (
            <>
              <Note>Which campaigns the rule may touch. Anything outside the scope is never written to.</Note>
              <Field label="Ad program">
                <Select defaultValue="sp">
                  <option value="sp">Sponsored Products</option>
                  <option value="sb">Sponsored Brands</option>
                  <option value="sd">Sponsored Display</option>
                </Select>
              </Field>
              <Field label="Marketplace">
                <Select defaultValue="it">
                  <option value="it">Amazon Italy</option>
                  <option value="de">Amazon Germany</option>
                </Select>
              </Field>
            </>
          ),
        },
        {
          id: 'criteria',
          label: 'Criteria',
          title: 'Criteria',
          content: (
            <>
              <Note>
                IF <b>ACOS</b> is above <b>35%</b> over the last <b>14 days</b> AND the target has at least{' '}
                <b>20 clicks</b> in the same window.
              </Note>
              <Field label="Lookback window">
                <Select defaultValue="14">
                  <option value="7">Last 7 days</option>
                  <option value="14">Last 14 days</option>
                  <option value="30">Last 30 days</option>
                </Select>
              </Field>
              <Field label="Minimum clicks" hint="Below this the sample is too small to act on.">
                <Input defaultValue="20" style={{ width: 120 }} />
              </Field>
            </>
          ),
        },
        {
          id: 'action',
          label: 'Action',
          title: 'Action',
          content: (
            <>
              <Note>THEN lower the bid by 15%, never below the €0.18 floor.</Note>
              <Field label="Bid change">
                <Input suffix="%" defaultValue="15" style={{ width: 120 }} />
              </Field>
              <Field label="Bid floor">
                <Input prefix="€" defaultValue="0.18" style={{ width: 120 }} />
              </Field>
            </>
          ),
        },
        {
          id: 'review',
          label: 'Review',
          title: 'Review',
          content: (
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <Pill tone="success">Scope: 41 campaigns</Pill>
                <Pill tone="warning">Would change 168 targets today</Pill>
              </div>
              <Note>The first run is a dry evaluation — nothing reaches Amazon until you approve the preview.</Note>
            </>
          ),
        },
      ]}
    />
  )
}

/** `busy` holds the primary action while the create call is in flight. */
export const Submitting = () => (
  <Builder
    open
    onClose={() => {}}
    title="Create campaign · Helmets · Auto"
    primaryLabel="Launching…"
    busy
    onPrimary={() => {}}
    sections={[
      {
        id: 'basics',
        label: 'Basics',
        title: 'Campaign basics',
        content: (
          <>
            <Field label="Campaign name">
              <Input defaultValue="Helmets · Auto · IT" />
            </Field>
            <Field label="Daily budget" hint="Amazon resets the budget day at 00:00 UTC, not marketplace midnight.">
              <Input prefix="€" defaultValue="45.00" style={{ width: 140 }} />
            </Field>
          </>
        ),
      },
      {
        id: 'targeting',
        label: 'Targeting',
        title: 'Targeting',
        content: <Note>Automatic targeting, close and loose match enabled, complements off.</Note>,
      },
      {
        id: 'products',
        label: 'Products',
        title: 'Products',
        content: <Note>14 ASINs from the Helmets portfolio, all FBA and in stock.</Note>,
      },
      {
        id: 'review',
        label: 'Review',
        title: 'Review',
        content: <Note>Creating the campaign, then the ad group, then the product ads — in that order.</Note>,
      },
    ]}
  />
)
