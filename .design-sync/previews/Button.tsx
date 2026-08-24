import { Button } from '@nexus/design-system'

const Row = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>{children}</div>
)

/** The four variants. `secondary` is the base look; `primary` carries the page's one main action. */
export const Variants = () => (
  <Row>
    <Button variant="primary">Create campaign</Button>
    <Button variant="secondary">Duplicate</Button>
    <Button variant="ghost">Cancel</Button>
    <Button variant="danger">Archive</Button>
  </Row>
)

/** `sm` is the toolbar/row-action size; `md` is the default. */
export const Sizes = () => (
  <Row>
    <Button variant="primary">Save changes</Button>
    <Button variant="primary" size="sm">Save</Button>
    <Button variant="secondary">Export CSV</Button>
    <Button variant="secondary" size="sm">Export</Button>
  </Row>
)

/** Disabled reads as unavailable, not invisible — the label stays legible. */
export const Disabled = () => (
  <Row>
    <Button variant="primary" disabled>Publish</Button>
    <Button variant="secondary" disabled>Duplicate</Button>
    <Button variant="ghost" disabled>Cancel</Button>
    <Button variant="danger" disabled>Archive</Button>
  </Row>
)
