import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import {
  Banner,
  Button,
  DataGrid,
  Input,
  Listbox,
  Pill,
  SegmentedControl,
  Tag,
  Textarea,
  Modal,
  type Column,
} from '@nexus/design-system'

/**
 * Every cell renders the modal ALREADY OPEN (`open` is a required boolean, and
 * a closed Modal returns null — an empty card). `onClose` is a no-op here; in a
 * product it is the state setter that owns `open`.
 *
 * Modal portals to <body>, so the scrim covers the whole capture viewport
 * rather than sitting inside the story root. That is the real behaviour.
 */
const noop = () => {}

const field: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 }
const caption: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }
const hint: React.CSSProperties = { fontSize: 11.5, color: 'var(--text-tertiary)' }

const Field = ({ label, note, children }: { label: string; note?: string; children: React.ReactNode }) => (
  <label style={field}>
    <span style={caption}>{label}</span>
    {children}
    {note != null && <span style={hint}>{note}</span>}
  </label>
)

/** The default size (`sm`, 440px): one decision, a short justification, two buttons. */
export const ConfirmWrite = () => (
  <Modal
    open
    onClose={noop}
    title="Apply 41 bid changes?"
    subtitle="Helmets · Auto — Amazon Germany"
    footer={
      <>
        <Button onClick={noop}>Cancel</Button>
        <Button variant="primary" onClick={noop}>
          Apply to Amazon
        </Button>
      </>
    }
  >
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Banner
        tone="warning"
        icon={<AlertTriangle size={16} aria-hidden />}
        title="This writes live to Amazon"
      >
        Bids take effect within about fifteen minutes and cannot be rolled back in bulk.
      </Banner>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>Targets raised</span>
          <strong style={{ color: 'var(--text-primary)' }}>28</strong>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>Targets lowered</span>
          <strong style={{ color: 'var(--text-primary)' }}>13</strong>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>Projected daily spend</span>
          <strong style={{ color: 'var(--text-primary)' }}>€148.20</strong>
        </div>
      </div>
    </div>
  </Modal>
)

/** `size="md"` (560px) — the form modal: label-above fields, a hint line, Cancel / primary. */
export const CreateAdGroup = () => {
  const [name, setName] = useState('Helmets · Exact — top terms')
  const [bid, setBid] = useState('0.84')
  const [match, setMatch] = useState('exact')
  return (
    <Modal
      open
      onClose={noop}
      size="md"
      title="Create ad group"
      subtitle="Name it and set a default bid."
      footer={
        <>
          <Button onClick={noop}>Cancel</Button>
          <Button variant="primary" onClick={noop}>
            Create ad group
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Ad group name">
          <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Ad group name" size={40} />
        </Field>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          <Field label="Default bid" note="Amazon's suggested range is €0.61–€1.12.">
            <Input
              prefix="€"
              value={bid}
              onChange={(e) => setBid(e.target.value)}
              aria-label="Default bid"
              size={6}
            />
          </Field>
          <Field label="Match type" note="Applies to every keyword added below.">
            <Listbox
              options={[
                { value: 'exact', label: 'Exact' },
                { value: 'phrase', label: 'Phrase' },
                { value: 'broad', label: 'Broad' },
              ]}
              value={match}
              onChange={setMatch}
              ariaLabel="Match type"
            />
          </Field>
        </div>
        <Field label="Starting keywords" note="One per line. 24 terms harvested from the last 30 days.">
          <Textarea
            defaultValue={'motorradhelm integral\nhelm mit bluetooth\njethelm damen\nklapphelm test'}
            aria-label="Starting keywords"
          />
        </Field>
      </div>
    </Modal>
  )
}

type Change = { id: string; campaign: string; term: string; from: number; to: number; state: 'success' | 'warning' }

const CHANGES: Change[] = [
  { id: '1', campaign: 'Helmets · Auto', term: 'motorradhelm', from: 0.74, to: 0.91, state: 'success' },
  { id: '2', campaign: 'Helmets · Auto', term: 'integralhelm', from: 0.62, to: 0.78, state: 'success' },
  { id: '3', campaign: 'Brand Defense', term: 'xavia helm', from: 1.4, to: 1.12, state: 'warning' },
  { id: '4', campaign: 'Gloves · Exact', term: 'motorradhandschuhe', from: 0.55, to: 0.66, state: 'success' },
]

const eur = (n: number) => `€${n.toFixed(2)}`

const CHANGE_COLS: Column<Change>[] = [
  {
    key: 'term',
    label: 'Target',
    width: 210,
    render: (r) => (
      <span style={{ display: 'flex', flexDirection: 'column' }}>
        <span style={{ fontWeight: 600 }}>{r.term}</span>
        <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{r.campaign}</span>
      </span>
    ),
  },
  { key: 'from', label: 'Current', align: 'right', render: (r) => eur(r.from) },
  { key: 'to', label: 'New bid', align: 'right', render: (r) => <strong>{eur(r.to)}</strong> },
  {
    key: 'delta',
    label: 'Change',
    align: 'right',
    render: (r) => (
      <Pill tone={r.state}>
        {r.to > r.from ? '▲' : '▼'} {Math.abs(Math.round(((r.to - r.from) / r.from) * 100))}%
      </Pill>
    ),
  },
]

/** `size="lg"` (660px) — wide enough for a real DataGrid in the body. */
export const ReviewChanges = () => (
  <Modal
    open
    onClose={noop}
    size="lg"
    title="Review 4 staged bid changes"
    subtitle="Rank & Dayparting · run of 15 May, 12:00 UTC"
    footer={
      <>
        <Button onClick={noop}>Discard</Button>
        <Button variant="primary" onClick={noop}>
          Apply all
        </Button>
      </>
    }
  >
    <DataGrid<Change> columns={CHANGE_COLS} rows={CHANGES} rowKey={(r) => r.id} />
  </Modal>
)

/** `size="xl"` (920px) — the two-panel surface: an input column beside a live parse of it. */
export const NegativeImport = () => {
  const [scope, setScope] = useState('adgroup')
  return (
    <Modal
      open
      onClose={noop}
      size="xl"
      title="Add negative keywords"
      subtitle="3 ad groups selected · Amazon Germany, Italy"
      footer={
        <>
          <Button onClick={noop}>Cancel</Button>
          <Button variant="primary" onClick={noop}>
            Add 5 negatives
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="Paste terms" note="One per line. Duplicates and existing negatives are dropped.">
            <Textarea
              defaultValue={'fahrradhelm\nskihelm\nkinderhelm\nhelm aufkleber\nhelm gebraucht'}
              aria-label="Paste terms"
            />
          </Field>
          <Field label="Apply at">
            <SegmentedControl
              options={[
                { value: 'adgroup', label: 'Ad group' },
                { value: 'campaign', label: 'Campaign' },
              ]}
              value={scope}
              onChange={setScope}
              size="sm"
            />
          </Field>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span style={caption}>5 terms will be negated</span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Tag tone="danger">fahrradhelm</Tag>
            <Tag tone="danger">skihelm</Tag>
            <Tag tone="danger">kinderhelm</Tag>
            <Tag tone="danger">helm aufkleber</Tag>
            <Tag tone="danger">helm gebraucht</Tag>
          </div>
          <span style={caption}>Already negated — skipped</span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Tag tone="neutral">reithelm</Tag>
            <Tag tone="neutral">bauhelm</Tag>
          </div>
          <span style={hint}>
            Negatives take effect on the next delivery cycle. They never remove existing spend — only future
            impressions.
          </span>
        </div>
      </div>
    </Modal>
  )
}
