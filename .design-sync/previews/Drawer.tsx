import { useState } from 'react'
import {
  Badge,
  Banner,
  Button,
  Card,
  Divider,
  Drawer,
  Input,
  Listbox,
  Pill,
  SegmentedControl,
  Tag,
  Toggle,
} from '@nexus/design-system'

/**
 * Every cell renders the drawer ALREADY OPEN — `open` is a required boolean and
 * a closed Drawer returns null, which would be an empty card. `onClose` is a
 * no-op; in a product it is the state setter that owns `open`.
 *
 * Drawer portals to <body> and is `position: fixed`, so the panel pins to the
 * right edge of the whole capture viewport with the scrim over everything else.
 * That is the real behaviour, not a preview artefact.
 *
 * Each cell puts `autoFocus` on the control a keyboard user should land on. That
 * is the house pattern the component itself defers to — it only focuses the
 * panel when nothing inside has claimed focus first — and it keeps the browser's
 * focus ring on a control instead of drawing it around the whole panel.
 */
const noop = () => {}

const caption: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }
const hint: React.CSSProperties = { fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.45 }

const Field = ({ label, note, children }: { label: string; note?: string; children: React.ReactNode }) => (
  <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    <span style={caption}>{label}</span>
    {children}
    {note != null && <span style={hint}>{note}</span>}
  </label>
)

const Stat = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
    <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>{label}</span>
    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{value}</span>
  </div>
)

/** The default panel (420px): `title` + `subtitle`, a scrolling body, a right-aligned footer. */
export const CampaignDetails = () => (
  <Drawer
    open
    onClose={noop}
    title="Helmets · Auto"
    subtitle="Amazon Germany · created 12 Mar 2026"
    footer={
      <>
        <Button autoFocus onClick={noop}>
          Close
        </Button>
        <Button variant="primary" onClick={noop}>
          Edit campaign
        </Button>
      </>
    }
  >
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <Badge program="sp">SP</Badge>
        <Pill tone="success">Active</Pill>
        <Tag tone="neutral">Dynamic bids — down only</Tag>
      </div>
      <Divider />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Stat label="Spend (7d)" value="€1,284.40" />
        <Stat label="Ad sales (7d)" value="€8,640.10" />
        <Stat label="ACOS" value="14.9%" />
        <Stat label="Orders" value="212" />
        <Stat label="Daily budget" value="€180.00" />
      </div>
      <Divider />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={caption}>Ad groups</span>
        <Stat label="Integral helmets" value="€612.20" />
        <Stat label="Jet helmets" value="€438.90" />
        <Stat label="Flip-up helmets" value="€233.30" />
      </div>
      <span style={hint}>
        Figures are Amazon&apos;s 14-day attribution window, last synced 12:40 UTC. Spend is reported in the
        marketplace currency and never re-converted.
      </span>
    </div>
  </Drawer>
)

/** `width` widens the panel — a number is px. The house editor drawer: fields, a toggle, a warning. */
export const EditBudget = () => {
  const [budget, setBudget] = useState('180.00')
  const [strategy, setStrategy] = useState('down')
  const [pacing, setPacing] = useState('even')
  const [carryOver, setCarryOver] = useState(true)
  return (
    <Drawer
      open
      onClose={noop}
      width={520}
      title="Budget & bidding"
      subtitle="Helmets · Auto — writes live to Amazon"
      footer={
        <>
          <Button onClick={noop}>Discard</Button>
          <Button variant="primary" onClick={noop}>
            Save changes
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Banner tone="info" title="The Amazon budget day starts at 00:00 UTC">
          A change made now applies to the remainder of today&apos;s budget, not to a fresh day.
        </Banner>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <Field label="Daily budget" note="Yesterday spent €148.20 of €180.00.">
            <Input
              autoFocus
              prefix="€"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              aria-label="Daily budget"
              size={8}
            />
          </Field>
          <Field label="Bidding strategy">
            <Listbox
              options={[
                { value: 'down', label: 'Dynamic — down only' },
                { value: 'updown', label: 'Dynamic — up and down' },
                { value: 'fixed', label: 'Fixed bids' },
              ]}
              value={strategy}
              onChange={setStrategy}
              ariaLabel="Bidding strategy"
            />
          </Field>
        </div>
        <Field label="Pacing" note="Accelerated spends the budget as fast as demand allows.">
          <SegmentedControl
            options={[
              { value: 'even', label: 'Even' },
              { value: 'accel', label: 'Accelerated' },
            ]}
            value={pacing}
            onChange={setPacing}
            size="sm"
          />
        </Field>
        <Divider />
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <Toggle checked={carryOver} onChange={setCarryOver} aria-label="Carry unspent budget forward" />
          <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
              Carry unspent budget forward
            </span>
            <span style={hint}>Amazon may spend up to 25% over on a high-demand day and settle over the month.</span>
          </span>
        </div>
      </div>
    </Drawer>
  )
}

/**
 * `overlay` renders a confirmation INSIDE the panel, over header, body and footer.
 * A drawer sits at z-61 and the app's own modal sits lower, so anything a drawer
 * must confirm belongs here rather than in a second pop-up.
 */
export const ConfirmInside = () => (
  <Drawer
    open
    onClose={noop}
    title="Budget & bidding"
    subtitle="Helmets · Auto — writes live to Amazon"
    footer={
      <>
        <Button onClick={noop}>Discard</Button>
        <Button variant="primary" onClick={noop}>
          Save changes
        </Button>
      </>
    }
    overlay={
      <Card padded elevated>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
            Lower the daily budget to €120?
          </div>
          <span style={hint}>
            This campaign spent €148.20 yesterday. Delivery will stop earlier in the day and the change reaches
            Amazon within about fifteen minutes.
          </span>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button autoFocus onClick={noop}>
              Keep €180
            </Button>
            <Button variant="danger" onClick={noop}>
              Lower budget
            </Button>
          </div>
        </div>
      </Card>
    }
  >
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Field label="Daily budget">
        <Input prefix="€" defaultValue="120.00" aria-label="Daily budget" size={8} />
      </Field>
      <Field label="Bidding strategy">
        <Listbox
          options={[{ value: 'down', label: 'Dynamic — down only' }]}
          value="down"
          onChange={noop}
          ariaLabel="Bidding strategy"
        />
      </Field>
    </div>
  </Drawer>
)
