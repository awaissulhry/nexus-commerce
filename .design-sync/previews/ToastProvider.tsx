import { useEffect, useRef } from 'react'
import { Button, Card, Divider, Pill, ToastProvider, useToast } from '@nexus/design-system'

/**
 * `ToastProvider` is a provider, not a visual component: it renders its children
 * plus an empty bottom-centre viewport, and shows nothing at all until something
 * under it calls `useToast().toast(…)`. So every cell here is the real pair —
 * the provider wrapping a surface whose buttons raise real toasts.
 *
 * A toast is a timed thing and a capture is a single frame, so the two "raised"
 * cells call the SAME public API a click would, from an effect on mount, and
 * pass the per-toast `duration` override so the toast is still on screen when
 * the shutter opens. The provider itself keeps its default 4 s — nothing about
 * the markup is hand-written.
 */
type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

/** Long enough to survive the capture. A product passes nothing and gets 4 s. */
const HOLD = { duration: 10 * 60 * 1000 }

const Raise = ({
  toasts,
  children,
}: {
  toasts: { message: React.ReactNode; tone: Tone }[]
  children: React.ReactNode
}) => {
  const { toast } = useToast()
  const fired = useRef(false)
  useEffect(() => {
    if (fired.current) return
    fired.current = true
    for (const t of toasts) toast(t.message, t.tone, HOLD)
  }, [toast, toasts])
  return <>{children}</>
}

const label: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }
const hint: React.CSSProperties = { fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.45 }

/** The whole API on the consumer side: `const { toast } = useToast()`, then call it. */
const ApplyBar = () => {
  const { toast } = useToast()
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <Button variant="primary" size="sm" onClick={() => toast('Bid changes applied to 41 targets', 'success')}>
        Apply 41 bids
      </Button>
      <Button size="sm" onClick={() => toast('Export queued — we will email the CSV', 'info')}>
        Export CSV
      </Button>
      <Button size="sm" onClick={() => toast('Nothing selected', 'neutral')}>
        Archive
      </Button>
    </div>
  )
}

const ToneRow = () => {
  const { toast } = useToast()
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <Button size="sm" onClick={() => toast('Selection cleared', 'neutral')}>
        neutral
      </Button>
      <Button size="sm" onClick={() => toast('Export queued', 'info')}>
        info
      </Button>
      <Button size="sm" onClick={() => toast('Bid changes applied', 'success')}>
        success
      </Button>
      <Button size="sm" onClick={() => toast('Budget exhausted at 14:20 UTC', 'warning')}>
        warning
      </Button>
      <Button size="sm" onClick={() => toast('Amazon rejected 2 of 41 writes', 'danger')}>
        danger
      </Button>
    </div>
  )
}

/**
 * The wiring, at rest. The provider wraps a subtree once; its viewport is mounted
 * but empty, so a page under it looks exactly as it would without one.
 */
export const Wiring = () => (
  <ToastProvider>
    <Card header="Helmets · Auto" headerAction={<Pill tone="success">Active</Pill>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={hint}>
          Every button below is a real <code>useToast()</code> consumer — the provider renders nothing until one of
          them is pressed.
        </span>
        <ApplyBar />
      </div>
    </Card>
  </ToastProvider>
)

/** One raised toast: dark pill, bottom centre, a tone dot and 13px/600 inverse text. */
export const AppliedReceipt = () => (
  <ToastProvider>
    <Raise toasts={[{ message: 'Bid changes applied to 41 targets', tone: 'success' }]}>
      <Card header="Helmets · Auto" headerAction={<Pill tone="success">Active</Pill>}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>Targets updated</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>41</span>
          </div>
          <Divider />
          <ApplyBar />
        </div>
      </Card>
    </Raise>
  </ToastProvider>
)

/** The whole tone axis, stacked oldest-first the way the viewport queues them. */
export const Tones = () => (
  <ToastProvider>
    <Raise
      toasts={[
        { message: 'Selection cleared', tone: 'neutral' },
        { message: 'Export queued — we will email the CSV', tone: 'info' },
        { message: 'Bid changes applied to 41 targets', tone: 'success' },
        { message: 'Budget exhausted at 14:20 UTC', tone: 'warning' },
        { message: 'Amazon rejected 2 of 41 writes', tone: 'danger' },
      ]}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span style={label}>toast(message, tone)</span>
        <ToneRow />
        <span style={hint}>
          The dot carries the tone; the pill itself never changes colour. Each toast clears itself after the
          provider&apos;s <code>duration</code> (4 s by default).
        </span>
      </div>
    </Raise>
  </ToastProvider>
)
