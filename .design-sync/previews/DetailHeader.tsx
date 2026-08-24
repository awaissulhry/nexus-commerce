import { Badge, Button, DetailHeader, Pill } from '@nexus/design-system'

/** The drill-in header: a back link above the row, a leading badge, the entity name, actions right. */
export const CampaignDetail = () => (
  <DetailHeader
    backLabel="Back to Ad Manager"
    onBack={() => {}}
    badge={<Badge program="auto">AUTO</Badge>}
    title="Helmets · Auto"
    actions={
      <>
        <Button>Duplicate</Button>
        <Button variant="primary">Edit targeting</Button>
      </>
    }
  />
)

/** The badge slot takes any leading chip — a status Pill reads as the entity's state. */
export const ListingDetail = () => (
  <DetailHeader
    backLabel="Back to Listings"
    onBack={() => {}}
    badge={<Pill tone="success">Live</Pill>}
    title="Casco Integrale AGV K6 · B0CJ4M2XQ1"
    actions={
      <>
        <Button>View on Amazon</Button>
        <Button variant="danger">End listing</Button>
      </>
    }
  />
)

/** Without `actions` the title owns the full row; `backLabel` names the route it returns to. */
export const NoActions = () => (
  <DetailHeader backLabel="Back to Rules & Automation" onBack={() => {}} title="Lower bids above 35% ACOS" />
)
