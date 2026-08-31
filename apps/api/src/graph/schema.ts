// PH.3 — the product graph schema.
//
// Schema-first SDL on purpose: the contract is reviewable as text, the same
// way packages/events/catalog.ts is. A code-first schema is only readable by
// running it, and this is the surface other teams build against.
//
// READ-ONLY. There are no mutations, and that is a decision rather than an
// omission: the platform has 171 registered REST route groups, and a parallel
// write surface would mean two paths to every mutation with two sets of
// guards. The value described for the graph — stitching catalog text and
// inventory stock in one round trip — is entirely on the read side.
//
// ── Where each field comes from ─────────────────────────────────────────────
// The Product facet reads ProductReadCache, the denormalised projection that
// already exists (39 columns). `costPrice` is NOT in that projection, so it
// resolves lazily against the Product table — which is the graph earning its
// keep: a query that does not ask for it pays nothing for it.
//
// ── Honesty about staleness ────────────────────────────────────────────────
// `cacheRefreshedAt` is exposed, not hidden. The projection can lag, and a
// consumer that cannot see the vintage of what it received has no way to know
// whether it is looking at the present.

export const schema = /* GraphQL */ `
  """
  A product, stitched across bounded contexts. Catalog fields come from the
  read projection; inventory and channels are resolved per context.
  """
  type Product {
    id: ID!
    sku: String!
    name: String!
    brand: String
    status: String!
    productType: String
    """
    FBA or FBM. Drives which stock pool backs the published quantity.
    """
    fulfillmentMethod: String
    asin: String
    imageUrl: String
    basePrice: Float
    """
    Restricted. Stripped for callers without the financial permission by the
    same preSerialization filter that guards every REST response — verified
    against this endpoint, not assumed.
    """
    costPrice: Float
    isParent: Boolean!
    parentId: ID
    family: Family
    workflowStage: WorkflowStage

    """When the read projection behind the catalog fields was last rebuilt."""
    cacheRefreshedAt: String!

    inventory: Inventory!
    channels: [ChannelListing!]!
  }

  type Family {
    id: ID!
    code: String
    label: String
  }

  type WorkflowStage {
    id: ID!
    code: String
    label: String
  }

  """
  Stock, from the inventory context.
  """
  type Inventory {
    """
    The merchant pool: SUM(StockLevel.quantity) over WAREHOUSE locations.
    FBA and channel-mirror locations are deliberately NOT counted — they are
    not stock we can promise against.
    """
    poolTotal: Int!
    reservedTotal: Int!
    availableTotal: Int!
    locations: [StockAtLocation!]!
  }

  type StockAtLocation {
    locationId: ID!
    code: String!
    """WAREHOUSE, AMAZON_FBA, ..."""
    type: String!
    quantity: Int!
    reserved: Int!
    available: Int!
  }

  """
  What each channel is currently publishing, from the channel context.
  """
  type ChannelListing {
    id: ID!
    channel: String!
    """Country code for region-scoped channels, GLOBAL for single-store ones."""
    marketplace: String
    listingStatus: String!
    quantity: Int
    fulfillmentMethod: String
    """A paused listing stops receiving pushes; its published quantity goes stale."""
    syncPaused: Boolean!
  }

  type Query {
    """One product by id or sku. Exactly one argument must be supplied."""
    product(id: ID, sku: String): Product

    """
    Several products by sku. Capped server-side; the cap is returned rather
    than silently truncating without saying so.
    """
    products(skus: [String!]!): [Product!]!
  }
`
