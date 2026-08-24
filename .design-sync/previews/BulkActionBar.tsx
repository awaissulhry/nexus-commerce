import { BulkActionBar, Button } from '@nexus/design-system'

/** A selection in the campaigns grid: the count leads, the actions and Clear sit right. */
export const CampaignSelection = () => (
  <BulkActionBar count={12} onClear={() => {}}>
    <Button size="sm">Set status</Button>
    <Button size="sm">Adjust bids</Button>
    <Button size="sm">Move to portfolio</Button>
    <Button size="sm" variant="primary">Apply to 12</Button>
  </BulkActionBar>
)

/** `noun` renames what was selected — "128 products selected" instead of the default "selected". */
export const ProductSelection = () => (
  <BulkActionBar count={128} noun="products selected" onClear={() => {}}>
    <Button size="sm">Assign tags</Button>
    <Button size="sm">Change channel</Button>
    <Button size="sm" variant="primary">Bulk edit</Button>
  </BulkActionBar>
)

/** A destructive selection reads the same — the `danger` button carries the weight, not the bar. */
export const DestructiveActions = () => (
  <BulkActionBar count={3} noun="listings selected" onClear={() => {}}>
    <Button size="sm">Remove from portfolio</Button>
    <Button size="sm" variant="danger">End listings</Button>
  </BulkActionBar>
)
