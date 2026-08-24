import { useState } from 'react'
import { Search } from 'lucide-react'
import { Input, Select } from '@nexus/design-system'

const Row = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>{children}</div>
)

/** Label above field — the house form idiom. The DS field carries no label of its own. */
const Field = ({
  label,
  hint,
  danger,
  children,
}: {
  label: string
  hint?: string
  danger?: boolean
  children: React.ReactNode
}) => (
  <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>{label}</span>
    {children}
    {hint != null && (
      <span style={{ fontSize: 11.5, color: danger ? 'var(--status-danger-strong)' : 'var(--text-tertiary)' }}>
        {hint}
      </span>
    )}
  </label>
)

/** The four adornment forms: plain, `leadingIcon`, shaded `prefix`, shaded `suffix`. */
export const Adornments = () => {
  const [sku, setSku] = useState('XAV-J100-BK-M')
  const [query, setQuery] = useState('helmets')
  const [bid, setBid] = useState('0.84')
  const [acos, setAcos] = useState('28')
  return (
    <Row>
      <Input value={sku} onChange={(e) => setSku(e.target.value)} aria-label="Seller SKU" size={18} />
      <Input
        leadingIcon={<Search size={15} aria-hidden />}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search campaigns"
        aria-label="Search campaigns"
        size={18}
      />
      <Input prefix="€" value={bid} onChange={(e) => setBid(e.target.value)} aria-label="Bid" size={6} />
      <Input suffix="%" value={acos} onChange={(e) => setAcos(e.target.value)} aria-label="Target ACOS" size={4} />
    </Row>
  )
}

/** Filled, empty-with-placeholder and `disabled` — disabled shades the whole field, not just the text. */
export const States = () => {
  const [asin, setAsin] = useState('B0CJ4K2QMB')
  const [note, setNote] = useState('')
  return (
    <Row>
      <Input value={asin} onChange={(e) => setAsin(e.target.value)} aria-label="ASIN" size={14} />
      <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note…" aria-label="Note" size={16} />
      <Input value="Helmets · Auto" readOnly disabled aria-label="Campaign (locked)" size={16} />
      <Input prefix="€" value="12.00" readOnly disabled aria-label="Daily budget (locked)" size={8} />
    </Row>
  )
}

/** A real settings form: label over field, a €/% pair on one line, and a validation line
 *  in `--status-danger-strong`. The field has no `error` prop — the message is composed. */
export const CampaignForm = () => {
  const [name, setName] = useState('Helmets · Auto · DE')
  const [budget, setBudget] = useState('4.00')
  const [acos, setAcos] = useState('26')
  const [marketplace, setMarketplace] = useState('de')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 420 }}>
      <Field label="Campaign name">
        <Input value={name} onChange={(e) => setName(e.target.value)} size={34} />
      </Field>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <Field label="Daily budget" hint="Below the €5.00 floor for Sponsored Products." danger>
          <Input
            prefix="€"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            aria-invalid
            size={8}
          />
        </Field>
        <Field label="Target ACOS" hint="Used by bid rules as the break-even.">
          <Input suffix="%" value={acos} onChange={(e) => setAcos(e.target.value)} size={5} />
        </Field>
      </div>
      <Field label="Marketplace">
        <Select value={marketplace} onChange={(e) => setMarketplace(e.target.value)}>
          <option value="de">Amazon.de — Germany</option>
          <option value="it">Amazon.it — Italy</option>
          <option value="fr">Amazon.fr — France</option>
        </Select>
      </Field>
    </div>
  )
}
