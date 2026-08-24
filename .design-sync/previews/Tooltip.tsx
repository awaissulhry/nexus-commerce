import { Button, Kbd, Pill, Tooltip } from '@nexus/design-system'

const Row = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>{children}</div>
)

/** Above the trigger, centred: give the bubble vertical room so it is not clipped. */
const Above = ({ children }: { children: React.ReactNode }) => (
  <div style={{ paddingTop: 72, display: 'flex', justifyContent: 'center' }}>{children}</div>
)

const RichLabelBody = () => (
  <span style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 180 }}>
    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontWeight: 700 }}>Columns</span>
      <Kbd>⌘G</Kbd>
    </span>
    <span style={{ opacity: 0.85, lineHeight: 1.4 }}>Show, hide and reorder the grid&apos;s columns.</span>
  </span>
)

/** Wrap any trigger — a button, a pill, a truncated cell. The bubble appears on hover or focus. */
export const Triggers = () => (
  <Row>
    <Tooltip label="Push the staged bid changes to Amazon. This writes live.">
      <Button variant="primary" size="sm">Apply 41 bids</Button>
    </Tooltip>
    <Tooltip label="Downloads the rows currently in view, with the filters applied.">
      <Button size="sm">Export CSV</Button>
    </Tooltip>
    <Tooltip label="Amazon stopped delivery at 14:20 UTC — the daily budget was exhausted.">
      <Pill tone="warning">Out of budget</Pill>
    </Tooltip>
  </Row>
)

/** The bubble itself — dark fill, 11.5px text, arrow pointing down at the trigger. */
export const OpenBubble = () => (
  <Above>
    <Tooltip label="Writes live to Amazon.">
      <Button variant="primary" size="sm" autoFocus>
        Apply 41 bids
      </Button>
    </Tooltip>
  </Above>
)

/** `label` is a ReactNode, so the bubble can carry a heading, a Kbd chip and a body line. */
export const RichLabel = () => (
  <Above>
    <Tooltip label={<RichLabelBody />}>
      <Button size="sm" autoFocus>
        Columns
      </Button>
    </Tooltip>
  </Above>
)
