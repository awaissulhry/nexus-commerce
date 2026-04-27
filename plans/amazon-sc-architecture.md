# Amazon Seller Central — Full Architecture Replication Plan

## 1. Current Codebase Audit

### 1.1 Existing Navigation (Sidebar)
| Current Route | Label | Status |
|---|---|---|
| `/` | Dashboard | Basic stats (product count, order count, unlinked alerts) |
| `/catalog` | Catalog | Product card list with stock/price |
| `/catalog/new` | Add New Product | Simple 4-field form |
| `/catalog/[id]/edit` | Edit Product | 5-tab editor (Vital Info, Offer, Images, Description, Variations) |
| `/products/[id]` | Product Detail | Amazon-style PDP with gallery, buy box, variations |
| `/orders` | Orders | Basic order table |
| `/listings` | Listings | Link/unlink listings to products |
| `/logs` | Sync Logs | MarketplaceSync table with status badges |
| `/inventory/manage` | Manage Inventory | TanStack Table with parent/child, inline edit, bulk actions |
| `/inventory/upload` | Bulk Upload | Excel/CSV drag-drop import with validation |

### 1.2 Existing Data Models (Prisma)
- `Product` — core entity with SKU, pricing, identifiers, physical attrs, content, fulfillment
- `ProductVariation` — child SKUs with name/value/price/stock
- `ProductImage` — MAIN/ALT/LIFESTYLE images
- `MarketplaceSync` — per-product per-channel sync status
- `Channel` — marketplace connection (Amazon, eBay)
- `Listing` — channel-specific listing linked to product
- `Order` / `OrderItem` — order tracking
- `StockLog` — inventory change audit trail

### 1.3 Existing API Backend (Fastify)
- `POST /listings/sync-amazon-catalog` — SP-API catalog sync
- `POST /listings/force-sync-ebay` — manual eBay sync trigger
- `POST /inventory/bulk-upload` — bulk product upsert
- `AmazonService` — SP-API integration (EU/Italy)
- `EbayService` — eBay REST API integration
- `GeminiService` — AI listing generation
- `sync.job.ts` — 3-phase cron (Amazon catalog → eBay publish → price parity)

---

## 2. Amazon Seller Central Navigation Architecture

Below is the complete Amazon SC menu hierarchy mapped to our new routing structure. Each section mirrors the real SC sidebar exactly.

### 2.1 Target Navigation Tree

```
┌─────────────────────────────────────────────────────┐
│  NEXUS COMMERCE                                      │
│  Amazon-to-eBay Sync Engine                          │
├─────────────────────────────────────────────────────┤
│                                                      │
│  📊 HOME                                             │
│     Dashboard                          /             │
│                                                      │
│  📦 CATALOG                                          │
│     Add Products                       /catalog/add  │
│     Complete Your Drafts               /catalog/drafts│
│     Upload via Spreadsheet             /catalog/upload│
│                                                      │
│  📋 INVENTORY                                        │
│     Manage All Inventory               /inventory    │
│     Manage FBA Inventory               /inventory/fba│
│     FBA Shipments                      /inventory/shipments│
│     Stranded Inventory                 /inventory/stranded│
│     Inventory Planning                 /inventory/planning│
│     Restock Inventory                  /inventory/restock│
│     Inventory Age                      /inventory/age│
│     Inventory Health                   /inventory/health│
│     Multi-Channel Fulfillment          /inventory/mcf│
│     Removal Orders                     /inventory/removals│
│     Global Selling                     /inventory/global│
│                                                      │
│  💰 PRICING                                          │
│     Automate Pricing                   /pricing/automate│
│     Manage Pricing                     /pricing      │
│     Fix Price Alerts                   /pricing/alerts│
│     Sale Dashboard                     /pricing/sales│
│                                                      │
│  🛒 ORDERS                                           │
│     Manage Orders                      /orders       │
│     Order Reports                      /orders/reports│
│     Upload Order Related Files         /orders/upload│
│     Returns                            /orders/returns│
│     A-to-Z Claims                      /orders/claims│
│                                                      │
│  📢 ADVERTISING                                      │
│     Campaign Manager                   /advertising/campaigns│
│     Stores                             /advertising/stores│
│     A+ Content                         /advertising/aplus│
│     Brand Analytics                    /advertising/analytics│
│     Deals                              /advertising/deals│
│     Coupons                            /advertising/coupons│
│     Vine                               /advertising/vine│
│                                                      │
│  📊 REPORTS                                          │
│     Business Reports                   /reports/business│
│     Fulfillment Reports                /reports/fulfillment│
│     Payments                           /reports/payments│
│     Return Reports                     /reports/returns│
│     Tax Document Library               /reports/tax│
│     Custom Reports                     /reports/custom│
│                                                      │
│  ⚡ PERFORMANCE                                      │
│     Account Health                     /performance/health│
│     Feedback                           /performance/feedback│
│     Voice of the Customer              /performance/voc│
│                                                      │
│  🏢 B2B                                              │
│     Manage Quotes                      /b2b/quotes   │
│     B2B Product Opportunities          /b2b/opportunities│
│                                                      │
│  🔌 APPS & SERVICES                                  │
│     Marketplace Appstore               /apps         │
│     Selling Partner API                /apps/api     │
│                                                      │
│  ─────────────────────────────────                   │
│  ⚙️ NEXUS ENGINE (custom section)                    │
│     Sync Logs                          /engine/logs  │
│     eBay Sync Control                  /engine/ebay  │
│     AI Listing Generator               /engine/ai    │
│     Channel Connections                /engine/channels│
│                                                      │
└─────────────────────────────────────────────────────┘
```

---

## 3. Consolidation Mapping — Current → New

### 3.1 Pages That Move

| Current Path | New Path | Action |
|---|---|---|
| `/` | `/` | **Enhance** — add SC-style dashboard widgets |
| `/catalog` | `/inventory` | **Merge** — catalog card list becomes the Manage All Inventory TanStack table |
| `/catalog/new` | `/catalog/add` | **Move** — becomes full Add Product wizard |
| `/catalog/[id]/edit` | `/catalog/[id]/edit` | **Keep** — product editor stays, linked from inventory table |
| `/products/[id]` | `/catalog/[id]` | **Move** — product detail page moves under catalog |
| `/orders` | `/orders` | **Keep** — enhance with SC features |
| `/listings` | **Remove** | **Absorb** — listing linking moves into inventory table actions |
| `/logs` | `/engine/logs` | **Move** — under Nexus Engine section |
| `/inventory/manage` | `/inventory` | **Promote** — becomes the primary inventory page |
| `/inventory/upload` | `/catalog/upload` | **Move** — upload via spreadsheet under Catalog |

### 3.2 New Pages to Create

| New Path | SC Feature | Description |
|---|---|---|
| `/catalog/drafts` | Complete Your Drafts | Products with missing required fields |
| `/inventory/fba` | Manage FBA Inventory | Filtered view: FBA-only products |
| `/inventory/shipments` | FBA Shipments | Inbound shipment tracking |
| `/inventory/stranded` | Stranded Inventory | Products listed but not buyable |
| `/inventory/planning` | Inventory Planning | Demand forecasting dashboard |
| `/inventory/restock` | Restock Inventory | Restock recommendations |
| `/inventory/age` | Inventory Age | Aging analysis by date range |
| `/inventory/health` | Inventory Health | Sell-through rate, excess, stranded |
| `/inventory/mcf` | Multi-Channel Fulfillment | Cross-channel FBA orders |
| `/inventory/removals` | Removal Orders | FBA removal/disposal requests |
| `/inventory/global` | Global Selling | Multi-marketplace inventory view |
| `/pricing/automate` | Automate Pricing | Rule-based repricing engine |
| `/pricing` | Manage Pricing | Price list with inline edit |
| `/pricing/alerts` | Fix Price Alerts | Price validation errors |
| `/pricing/sales` | Sale Dashboard | Active promotions/sales |
| `/orders/reports` | Order Reports | Downloadable order reports |
| `/orders/upload` | Upload Order Files | Bulk order file processing |
| `/orders/returns` | Returns | Return request management |
| `/orders/claims` | A-to-Z Claims | Guarantee claim tracking |
| `/advertising/campaigns` | Campaign Manager | PPC campaign dashboard |
| `/advertising/stores` | Stores | Brand storefront builder |
| `/advertising/aplus` | A+ Content | Enhanced brand content editor |
| `/advertising/analytics` | Brand Analytics | Search terms, demographics |
| `/advertising/deals` | Deals | Lightning deals, 7-day deals |
| `/advertising/coupons` | Coupons | Coupon creation/management |
| `/advertising/vine` | Vine | Product review program |
| `/reports/business` | Business Reports | Sales, traffic, conversion |
| `/reports/fulfillment` | Fulfillment Reports | FBA performance metrics |
| `/reports/payments` | Payments | Settlement reports, disbursements |
| `/reports/returns` | Return Reports | Return analytics |
| `/reports/tax` | Tax Document Library | Tax invoices, 1099s |
| `/reports/custom` | Custom Reports | Build custom report queries |
| `/performance/health` | Account Health | Policy compliance dashboard |
| `/performance/feedback` | Feedback | Seller feedback management |
| `/performance/voc` | Voice of Customer | Customer experience metrics |
| `/b2b/quotes` | Manage Quotes | B2B quote requests |
| `/b2b/opportunities` | B2B Opportunities | Business pricing suggestions |
| `/apps` | Marketplace Appstore | Third-party app integrations |
| `/apps/api` | Selling Partner API | API credentials, webhooks |
| `/engine/logs` | Sync Logs | Existing sync log page |
| `/engine/ebay` | eBay Sync Control | Manual sync triggers, status |
| `/engine/ai` | AI Listing Generator | Gemini AI listing preview |
| `/engine/channels` | Channel Connections | Amazon/eBay credential management |

---

## 4. Navigation Component Architecture

### 4.1 Collapsible Sidebar with Section Groups

```
Sidebar
├── SidebarHeader (logo + collapse toggle)
├── SidebarSection (repeating)
│   ├── SectionLabel (e.g. CATALOG) — clickable to collapse
│   └── SectionItems[]
│       └── NavItem (icon + label + optional badge + optional sub-items)
└── SidebarFooter (settings, help)
```

### 4.2 Implementation

Replace the current flat `<nav>` in `layout.tsx` with a new `Sidebar` component:

- **File**: `apps/web/src/components/layout/Sidebar.tsx`
- **State**: `expandedSections: Set<string>` persisted in localStorage
- **Active detection**: `usePathname()` from `next/navigation`
- **Responsive**: Drawer on mobile, fixed on desktop
- **Badge support**: Notification counts (e.g., "3 drafts", "2 price alerts")

---

## 5. Detailed Feature Specifications

### 5.1 Dashboard (`/`)

**Current**: 2 stat cards + unlinked listing alert
**Target**: Amazon SC-style dashboard with:
- Sales summary (today, 7d, 30d) with sparkline charts
- Order metrics (pending, shipped, returns)
- Inventory health widget (in-stock %, stranded count, restock needed)
- Account health score
- Recent activity feed
- Quick action buttons (Add Product, Create Shipment, Run Sync)
- Marketplace connection status cards (Amazon ✓, eBay ✓)

### 5.2 Catalog Section

#### `/catalog/add` — Add Products
**Migrates from**: `/catalog/new`
**Enhancements**:
- Search Amazon catalog by ASIN/keyword to pre-fill
- Full product editor form (reuse existing 5-tab `ProductEditorForm`)
- Category browse tree
- Match existing ASIN flow

#### `/catalog/drafts` — Complete Your Drafts
**New page**
- Query: Products where required fields are null/empty
- Table with: SKU, Name, Missing Fields count, Last Updated, Actions
- Inline "Complete" button → opens editor with missing tab highlighted
- Badge count shown in sidebar

#### `/catalog/upload` — Upload via Spreadsheet
**Migrates from**: `/inventory/upload`
- Keep existing drag-drop + validation + preview flow
- Add template download button
- Add "Upload History" section showing past imports

### 5.3 Inventory Section

#### `/inventory` — Manage All Inventory (PRIMARY)
**Consolidates**: `/catalog` + `/inventory/manage`
- This becomes THE main inventory page
- Existing TanStack Table with parent/child, inline edit, bulk actions
- Add column visibility toggle (SC has this)
- Add pagination (SC shows 25/50/100/250 per page)
- Add "Preferences" gear icon for saved column layouts
- Enhanced filters: Status, Fulfillment, Date Range, Brand, Condition
- Export to CSV/Excel button
- "Add a Product" button in header

#### `/inventory/fba` — Manage FBA Inventory
- Same TanStack Table, pre-filtered to `fulfillmentMethod = FBA`
- Additional columns: FBA fees, storage fees, inbound quantity
- Shipment status integration

#### `/inventory/shipments` — FBA Shipments
**New page**
- Shipment creation wizard (select products → set quantities → choose destination)
- Shipment tracking table: ID, Status, Destination FC, Items, Created, ETA
- Status workflow: WORKING → SHIPPED → IN_TRANSIT → RECEIVING → CLOSED

#### `/inventory/stranded` — Stranded Inventory
**New page**
- Products that are in FBA but have no active listing
- Columns: SKU, ASIN, Condition, Available, Stranded Reason, Date Stranded
- Actions: Relist, Create Removal Order, Edit Listing

#### `/inventory/planning` — Inventory Planning
**New page**
- Demand forecasting based on sales velocity
- Recommended restock dates
- Seasonal trend indicators
- Days of supply calculator

#### `/inventory/restock` — Restock Inventory
**New page**
- Products sorted by urgency (days of supply remaining)
- Columns: SKU, Name, Available, Sales/Day, Days of Supply, Recommended Qty
- "Create Shipment" bulk action

#### `/inventory/age` — Inventory Age
**New page**
- Aging buckets: 0-90, 91-180, 181-270, 271-365, 365+ days
- Long-term storage fee estimates
- Removal recommendations for aged inventory

#### `/inventory/health` — Inventory Health
**New page**
- Dashboard with KPIs: Sell-through rate, In-stock rate, Stranded %, Excess units
- Product-level health scores
- Actionable recommendations

#### `/inventory/mcf` — Multi-Channel Fulfillment
**New page**
- eBay orders fulfilled via Amazon FBA
- Create MCF order form
- MCF order tracking table

#### `/inventory/removals` — Removal Orders
**New page**
- Create removal/disposal orders for FBA inventory
- Tracking table: Order ID, Type, Status, Units, Created

#### `/inventory/global` — Global Selling
**New page**
- Multi-marketplace inventory view (Italy, Spain, Germany, France, UK)
- Per-marketplace stock levels
- Cross-border fulfillment options

### 5.4 Pricing Section

#### `/pricing` — Manage Pricing
**New page** (partially exists as inline edit in inventory)
- Dedicated pricing table with: SKU, Name, Your Price, Min Price, Max Price, Buy Box Price, Competitor Price
- Inline editing for all price fields
- Bulk price update via selection
- Price change history

#### `/pricing/automate` — Automate Pricing
**New page**
- Rule builder: "Match lowest price", "Stay X% below competitor", "Floor at cost + margin"
- Rule assignment to products/groups
- Rule execution log

#### `/pricing/alerts` — Fix Price Alerts
**New page**
- Products with pricing errors (below min, above max, missing price)
- One-click fix actions
- Badge count in sidebar

#### `/pricing/sales` — Sale Dashboard
**New page**
- Active promotions list
- Create sale: select products, set discount %, date range
- Sale performance metrics

### 5.5 Orders Section

#### `/orders` — Manage Orders
**Enhances existing**
- Add filter tabs: All, Pending, Shipped, Cancelled, Returns
- Add search by Order ID, buyer name, SKU
- Order detail slide-out panel
- Ship/Cancel actions
- Print packing slip / shipping label

#### `/orders/reports` — Order Reports
**New page**
- Pre-built report types: All Orders, Unshipped, Returns, Cancellations
- Date range picker
- Download as CSV/Excel
- Scheduled report generation

#### `/orders/upload` — Upload Order Related Files
**New page**
- Upload shipping confirmations, tracking numbers
- Template download
- Processing status

#### `/orders/returns` — Returns
**New page**
- Return request table: Order ID, SKU, Reason, Status, Requested Date
- Approve/Deny actions
- Return label generation
- Refund processing

#### `/orders/claims` — A-to-Z Claims
**New page**
- Guarantee claim tracking
- Respond to claims
- Claim status: Open, Under Review, Granted, Denied

### 5.6 Advertising Section

#### `/advertising/campaigns` — Campaign Manager
**New page**
- PPC campaign table: Name, Type, Status, Budget, Spend, Sales, ACoS
- Create campaign wizard
- Campaign performance charts

#### `/advertising/stores` — Stores
**New page**
- Brand storefront builder (drag-drop modules)
- Store analytics: visits, sales, conversion

#### `/advertising/aplus` — A+ Content
**New page**
- Enhanced brand content editor
- Module library: comparison charts, image carousels, text blocks
- Preview and publish workflow
- Links to existing `aPlusContent` field in Product model

#### `/advertising/analytics` — Brand Analytics
**New page**
- Search term reports
- Market basket analysis
- Demographics data
- Repeat purchase behavior

#### `/advertising/deals` — Deals
**New page**
- Lightning Deals, 7-Day Deals, Best Deals
- Deal creation: select product, set deal price, schedule
- Deal performance tracking

#### `/advertising/coupons` — Coupons
**New page**
- Coupon creation: percentage or fixed amount
- Targeting: all customers, Prime, specific segments
- Redemption tracking

#### `/advertising/vine` — Vine
**New page**
- Enroll products in Vine program
- Track review generation
- Vine order status

### 5.7 Reports Section

#### `/reports/business` — Business Reports
**New page**
- Sales Dashboard: units, revenue, conversion rate
- Traffic reports: page views, sessions, buy box %
- Date range comparison
- Chart visualizations (line, bar, pie)

#### `/reports/fulfillment` — Fulfillment Reports
**New page**
- FBA inventory reports
- Removal reports
- Long-term storage reports
- Stranded inventory reports

#### `/reports/payments` — Payments
**New page**
- Settlement reports by date range
- Transaction-level detail
- Fee breakdown: referral, FBA, storage, advertising
- Disbursement schedule

#### `/reports/returns` — Return Reports
**New page**
- Return rate by product
- Return reason analysis
- Refund amounts
- Trend charts

#### `/reports/tax` — Tax Document Library
**New page**
- Tax invoices
- VAT reports (EU-specific)
- 1099-K forms
- Download/export

#### `/reports/custom` — Custom Reports
**New page**
- Report builder: select dimensions, metrics, filters
- Save report templates
- Schedule recurring reports
- Export formats: CSV, Excel, PDF

### 5.8 Performance Section

#### `/performance/health` — Account Health
**New page**
- Overall health score (green/yellow/red)
- Policy compliance metrics
- Order defect rate
- Late shipment rate
- Pre-fulfillment cancel rate
- Valid tracking rate

#### `/performance/feedback` — Feedback
**New page**
- Seller feedback table: Rating, Comment, Order ID, Date
- Response actions
- Feedback score trend chart
- Request removal for policy-violating feedback

#### `/performance/voc` — Voice of the Customer
**New page**
- CX Health by product
- Negative experience rate
- Top customer complaints
- Action items

### 5.9 B2B Section

#### `/b2b/quotes` — Manage Quotes
**New page**
- Quote request table: Buyer, Product, Quantity, Requested Price
- Accept/Counter/Decline actions
- Quote history

#### `/b2b/opportunities` — B2B Product Opportunities
**New page**
- Products with B2B demand signals
- Recommended business pricing
- Quantity discount tiers

### 5.10 Apps & Services Section

#### `/apps` — Marketplace Appstore
**New page**
- Available integrations catalog
- Installed apps management
- App categories: Inventory, Pricing, Shipping, Analytics

#### `/apps/api` — Selling Partner API
**New page**
- API credentials management
- Webhook configuration
- API call logs
- Rate limit monitoring

### 5.11 Nexus Engine Section (Custom)

#### `/engine/logs` — Sync Logs
**Migrates from**: `/logs`
- Keep existing MarketplaceSync table
- Add filtering by channel, status, date range

#### `/engine/ebay` — eBay Sync Control
**New page**
- Manual sync trigger buttons
- Last sync timestamp per product
- Sync queue status
- Error log

#### `/engine/ai` — AI Listing Generator
**New page**
- Select product → generate eBay listing via Gemini
- Preview generated HTML
- Edit and publish
- Generation history

#### `/engine/channels` — Channel Connections
**New page**
- Amazon SP-API connection status + credentials
- eBay API connection status + credentials
- Test connection buttons
- Credential rotation

---

## 6. Schema Enhancements Required

```prisma
// New models needed for full SC parity

model FBAShipment {
  id              String   @id @default(cuid)
  shipmentId      String   @unique // Amazon shipment ID
  status          String   // WORKING, SHIPPED, IN_TRANSIT, RECEIVING, CLOSED
  destinationFC   String   // Fulfillment center code
  items           FBAShipmentItem[]
  createdAt       DateTime @default(now)
  updatedAt       DateTime @updatedAt
}

model FBAShipmentItem {
  id          String      @id @default(cuid)
  shipment    FBAShipment @relation(fields: [shipmentId], references: [id])
  shipmentId  String
  product     Product     @relation(fields: [productId], references: [id])
  productId   String
  quantitySent     Int
  quantityReceived Int    @default(0)
}

model PricingRule {
  id          String   @id @default(cuid)
  name        String
  type        String   // MATCH_LOW, PERCENTAGE_BELOW, COST_PLUS_MARGIN
  parameters  Json     // Rule-specific config
  isActive    Boolean  @default(true)
  products    PricingRuleProduct[]
  createdAt   DateTime @default(now)
  updatedAt   DateTime @updatedAt
}

model PricingRuleProduct {
  id            String      @id @default(cuid)
  rule          PricingRule @relation(fields: [ruleId], references: [id])
  ruleId        String
  product       Product     @relation(fields: [productId], references: [id])
  productId     String
  @@unique([ruleId, productId])
}

model Return {
  id          String   @id @default(cuid)
  order       Order    @relation(fields: [orderId], references: [id])
  orderId     String
  sku         String
  reason      String
  status      String   // REQUESTED, APPROVED, RECEIVED, REFUNDED, DENIED
  refundAmount Decimal? @db.Decimal(10, 2)
  createdAt   DateTime @default(now)
  updatedAt   DateTime @updatedAt
}

model SellerFeedback {
  id        String   @id @default(cuid)
  orderId   String?
  rating    Int      // 1-5
  comment   String?
  buyerName String?
  createdAt DateTime @default(now)
}

model Campaign {
  id          String   @id @default(cuid)
  name        String
  type        String   // SP, SB, SD (Sponsored Products/Brands/Display)
  status      String   // ENABLED, PAUSED, ARCHIVED
  dailyBudget Decimal  @db.Decimal(10, 2)
  startDate   DateTime
  endDate     DateTime?
  createdAt   DateTime @default(now)
  updatedAt   DateTime @updatedAt
}

model Coupon {
  id            String   @id @default(cuid)
  name          String
  discountType  String   // PERCENTAGE, FIXED
  discountValue Decimal  @db.Decimal(10, 2)
  startDate     DateTime
  endDate       DateTime
  redemptions   Int      @default(0)
  maxRedemptions Int?
  createdAt     DateTime @default(now)
  updatedAt     DateTime @updatedAt
}

// Add to existing Product model:
// - costPrice Decimal? (for margin calculations)
// - minPrice Decimal? (pricing floor)
// - maxPrice Decimal? (pricing ceiling)
// - buyBoxPrice Decimal? (current buy box)
// - competitorPrice Decimal? (lowest competitor)
// - firstInventoryDate DateTime? (for aging)
// - b2bPrice Decimal? (business pricing)
// - b2bMinQty Int? (minimum B2B quantity)

// Add to existing Order model:
// - buyerName String?
// - shippingAddress Json?
// - trackingNumber String?
// - shippedAt DateTime?
// - returns Return[]
```

---

## 7. Component Architecture

### 7.1 Shared Components to Create

```
apps/web/src/components/
├── layout/
│   ├── Sidebar.tsx              # Collapsible section-based nav
│   ├── SidebarSection.tsx       # Expandable section group
│   ├── NavItem.tsx              # Individual nav link with badge
│   ├── TopBar.tsx               # Search bar + notifications + user menu
│   └── PageHeader.tsx           # Reusable page title + breadcrumb + actions
├── data/
│   ├── DataTable.tsx            # Generic TanStack Table wrapper
│   ├── ColumnVisibilityToggle.tsx
│   ├── Pagination.tsx           # 25/50/100/250 per page
│   ├── DateRangePicker.tsx
│   ├── FilterBar.tsx            # Composable filter chips
│   └── ExportButton.tsx         # CSV/Excel export
├── charts/
│   ├── SparklineChart.tsx       # Mini inline charts
│   ├── LineChart.tsx
│   ├── BarChart.tsx
│   └── PieChart.tsx
├── feedback/
│   ├── StatusBadge.tsx          # Reusable status pill
│   ├── HealthScore.tsx          # Green/yellow/red indicator
│   └── EmptyState.tsx           # Consistent empty state
└── forms/
    ├── InlineInput.tsx          # Extract from columns.tsx
    ├── SearchInput.tsx
    └── FileDropzone.tsx         # Extract from upload page
```

### 7.2 Page Layout Pattern

Every page follows the SC pattern:
```
PageHeader (title + breadcrumb + action buttons)
├── FilterBar (tabs + search + date range + filters)
├── BulkActionBar (appears on selection)
├── DataTable (TanStack Table with pagination)
└── Footer (row count + pagination controls)
```

---

## 8. Implementation Flow Diagram

```mermaid
graph TD
    A[Phase 1: Navigation Shell] --> B[Phase 2: Consolidate Existing]
    B --> C[Phase 3: Core New Pages]
    C --> D[Phase 4: Advanced Features]
    D --> E[Phase 5: Reports and Analytics]
    E --> F[Phase 6: Polish and Integration]

    A --> A1[Sidebar component with sections]
    A --> A2[TopBar with search]
    A --> A3[PageHeader component]
    A --> A4[Update layout.tsx]

    B --> B1[Merge catalog into /inventory]
    B --> B2[Move upload to /catalog/upload]
    B --> B3[Move logs to /engine/logs]
    B --> B4[Move product detail to /catalog/id]
    B --> B5[Absorb listings into inventory actions]

    C --> C1[/catalog/drafts]
    C --> C2[/inventory/fba filtered view]
    C --> C3[/pricing + /pricing/alerts]
    C --> C4[/orders enhancements]
    C --> C5[/orders/returns]

    D --> D1[/pricing/automate rule engine]
    D --> D2[/inventory/shipments]
    D --> D3[/inventory/health dashboard]
    D --> D4[/advertising/campaigns]
    D --> D5[/advertising/aplus]

    E --> E1[/reports/business]
    E --> E2[/reports/payments]
    E --> E3[/performance/health]
    E --> E4[/performance/feedback]

    F --> F1[/b2b section]
    F --> F2[/apps section]
    F --> F3[/engine section completion]
    F --> F4[Global search]
    F --> F5[Notification system]
```

---

## 9. Phased Implementation Plan

### Phase 1 — Navigation Shell
- [ ] Create `Sidebar.tsx` with collapsible section groups
- [ ] Create `SidebarSection.tsx` and `NavItem.tsx` components
- [ ] Create `TopBar.tsx` with global search and notification bell
- [ ] Create `PageHeader.tsx` reusable component
- [ ] Rewrite `layout.tsx` to use new Sidebar + TopBar
- [ ] Add all section labels and route links (pages can be placeholder)
- [ ] Add active route highlighting with `usePathname()`
- [ ] Add localStorage persistence for collapsed sections
- [ ] Mobile responsive drawer

### Phase 2 — Consolidate Existing Pages
- [ ] Move `/inventory/manage` to `/inventory` (primary inventory page)
- [ ] Remove old `/catalog` card list — inventory table replaces it
- [ ] Move `/catalog/new` to `/catalog/add` with enhanced form
- [ ] Move `/products/[id]` to `/catalog/[id]` (product detail)
- [ ] Move `/inventory/upload` to `/catalog/upload`
- [ ] Move `/logs` to `/engine/logs`
- [ ] Absorb `/listings` functionality into inventory table actions dropdown
- [ ] Update all internal links and redirects
- [ ] Extract `InlineInput` to shared component
- [ ] Extract `DataTable` wrapper from `InventoryTable`
- [ ] Create `Pagination` component (25/50/100/250)
- [ ] Add column visibility toggle to inventory table

### Phase 3 — Core New Pages
- [ ] `/catalog/drafts` — incomplete products query + table
- [ ] `/inventory/fba` — FBA-filtered inventory view
- [ ] `/inventory/stranded` — products with no active listing
- [ ] `/pricing` — dedicated pricing table with inline edit
- [ ] `/pricing/alerts` — products with pricing errors
- [ ] Enhance `/orders` — add filter tabs, search, detail panel, ship/cancel
- [ ] `/orders/returns` — return request management table
- [ ] Schema migration: add `costPrice`, `minPrice`, `maxPrice`, `buyBoxPrice`, `competitorPrice`, `firstInventoryDate` to Product
- [ ] Schema migration: create `Return` model
- [ ] Create shared `DataTable`, `Pagination`, `FilterBar`, `ExportButton` components

### Phase 4 — Advanced Features
- [ ] `/pricing/automate` — rule builder UI + `PricingRule` / `PricingRuleProduct` models
- [ ] `/pricing/sales` — sale/promotion creation and tracking
- [ ] `/inventory/shipments` — FBA shipment wizard + `FBAShipment` / `FBAShipmentItem` models
- [ ] `/inventory/planning` — demand forecasting dashboard
- [ ] `/inventory/restock` — restock recommendations based on sales velocity
- [ ] `/inventory/age` — aging bucket analysis
- [ ] `/inventory/health` — KPI dashboard with sell-through, in-stock rate, excess
- [ ] `/inventory/mcf` — multi-channel fulfillment order creation
- [ ] `/inventory/removals` — removal/disposal order management
- [ ] `/inventory/global` — multi-marketplace inventory view
- [ ] `/orders/reports` — downloadable order reports with date range
- [ ] `/orders/upload` — bulk shipping confirmation upload
- [ ] `/orders/claims` — A-to-Z guarantee claim tracking
- [ ] `/advertising/campaigns` — PPC campaign dashboard + `Campaign` model
- [ ] `/advertising/aplus` — A+ Content editor linking to existing `aPlusContent` field
- [ ] `/advertising/coupons` — coupon management + `Coupon` model

### Phase 5 — Reports & Analytics
- [ ] Install chart library — recharts
- [ ] `/reports/business` — sales, traffic, conversion dashboards with charts
- [ ] `/reports/fulfillment` — FBA performance metrics
- [ ] `/reports/payments` — settlement reports, fee breakdown
- [ ] `/reports/returns` — return rate analysis with trend charts
- [ ] `/reports/tax` — tax document library with EU VAT focus
- [ ] `/reports/custom` — report builder with dimension/metric selection
- [ ] `/performance/health` — account health score dashboard
- [ ] `/performance/feedback` — seller feedback table + `SellerFeedback` model
- [ ] `/performance/voc` — voice of customer metrics

### Phase 6 — Polish & Integration
- [ ] `/b2b/quotes` — B2B quote management
- [ ] `/b2b/opportunities` — B2B product opportunity suggestions
- [ ] `/apps` — marketplace appstore catalog
- [ ] `/apps/api` — SP-API credential management + webhook config
- [ ] `/engine/ebay` — manual eBay sync control panel
- [ ] `/engine/ai` — Gemini AI listing generator with preview
- [ ] `/engine/channels` — channel connection management
- [ ] `/advertising/stores` — brand storefront builder
- [ ] `/advertising/analytics` — brand analytics dashboards
- [ ] `/advertising/deals` — deal creation and tracking
- [ ] `/advertising/vine` — Vine program enrollment
- [ ] Global search across all entities — products, orders, SKUs
- [ ] Notification system — bell icon + dropdown
- [ ] Keyboard shortcuts — Cmd+K for search
- [ ] Dark mode toggle

---

## 10. File Structure — Final Target

```
apps/web/src/
├── app/
│   ├── layout.tsx                          # New sidebar + topbar shell
│   ├── page.tsx                            # Enhanced dashboard
│   │
│   ├── catalog/
│   │   ├── add/page.tsx                    # Add product wizard
│   │   ├── drafts/page.tsx                 # Incomplete products
│   │   ├── upload/page.tsx                 # Spreadsheet upload - moved
│   │   └── [id]/
│   │       ├── page.tsx                    # Product detail - moved from /products
│   │       └── edit/
│   │           ├── page.tsx                # Product editor - existing
│   │           ├── actions.ts
│   │           ├── schema.ts
│   │           ├── ProductEditorForm.tsx
│   │           └── tabs/                   # Existing 5 tabs
│   │
│   ├── inventory/
│   │   ├── page.tsx                        # Manage All Inventory - primary
│   │   ├── actions.ts                      # Quick save + bulk actions
│   │   ├── fba/page.tsx                    # FBA-filtered view
│   │   ├── shipments/page.tsx
│   │   ├── stranded/page.tsx
│   │   ├── planning/page.tsx
│   │   ├── restock/page.tsx
│   │   ├── age/page.tsx
│   │   ├── health/page.tsx
│   │   ├── mcf/page.tsx
│   │   ├── removals/page.tsx
│   │   └── global/page.tsx
│   │
│   ├── pricing/
│   │   ├── page.tsx                        # Manage Pricing
│   │   ├── automate/page.tsx
│   │   ├── alerts/page.tsx
│   │   └── sales/page.tsx
│   │
│   ├── orders/
│   │   ├── page.tsx                        # Manage Orders - enhanced
│   │   ├── reports/page.tsx
│   │   ├── upload/page.tsx
│   │   ├── returns/page.tsx
│   │   └── claims/page.tsx
│   │
│   ├── advertising/
│   │   ├── campaigns/page.tsx
│   │   ├── stores/page.tsx
│   │   ├── aplus/page.tsx
│   │   ├── analytics/page.tsx
│   │   ├── deals/page.tsx
│   │   ├── coupons/page.tsx
│   │   └── vine/page.tsx
│   │
│   ├── reports/
│   │   ├── business/page.tsx
│   │   ├── fulfillment/page.tsx
│   │   ├── payments/page.tsx
│   │   ├── returns/page.tsx
│   │   ├── tax/page.tsx
│   │   └── custom/page.tsx
│   │
│   ├── performance/
│   │   ├── health/page.tsx
│   │   ├── feedback/page.tsx
│   │   └── voc/page.tsx
│   │
│   ├── b2b/
│   │   ├── quotes/page.tsx
│   │   └── opportunities/page.tsx
│   │
│   ├── apps/
│   │   ├── page.tsx
│   │   └── api/page.tsx
│   │
│   ├── engine/
│   │   ├── logs/page.tsx                   # Sync logs - moved
│   │   ├── ebay/page.tsx
│   │   ├── ai/page.tsx
│   │   └── channels/page.tsx
│   │
│   ├── actions/                            # Shared server actions
│   │   ├── product.ts
│   │   ├── listings.ts
│   │   ├── pricing.ts
│   │   ├── orders.ts
│   │   └── inventory.ts
│   │
│   └── api/                                # API routes - existing
│       ├── listings/route.ts
│       └── products/route.ts
│
├── components/
│   ├── layout/
│   │   ├── Sidebar.tsx
│   │   ├── SidebarSection.tsx
│   │   ├── NavItem.tsx
│   │   ├── TopBar.tsx
│   │   └── PageHeader.tsx
│   ├── data/
│   │   ├── DataTable.tsx
│   │   ├── ColumnVisibilityToggle.tsx
│   │   ├── Pagination.tsx
│   │   ├── DateRangePicker.tsx
│   │   ├── FilterBar.tsx
│   │   └── ExportButton.tsx
│   ├── charts/
│   │   ├── SparklineChart.tsx
│   │   ├── LineChart.tsx
│   │   ├── BarChart.tsx
│   │   └── PieChart.tsx
│   ├── feedback/
│   │   ├── StatusBadge.tsx
│   │   ├── HealthScore.tsx
│   │   └── EmptyState.tsx
│   ├── forms/
│   │   ├── InlineInput.tsx
│   │   ├── SearchInput.tsx
│   │   └── FileDropzone.tsx
│   ├── inventory/                          # Existing - kept
│   │   ├── columns.tsx
│   │   ├── InventoryTable.tsx
│   │   └── BulkActionBar.tsx
│   └── StatCard.tsx                        # Existing
│
└── types/
    ├── inventory.ts                        # Existing
    ├── pricing.ts
    ├── orders.ts
    └── navigation.ts
```

---

## 11. Key Technical Decisions

### 11.1 Routing Strategy
- Use Next.js App Router file-based routing exclusively
- Each SC section gets its own route group folder
- Shared layouts per section via `layout.tsx` files where needed
- Loading states via `loading.tsx` skeletons

### 11.2 Data Fetching
- Server Components for all list/table pages with direct Prisma queries
- Client Components only for interactive elements like inline edit, filters, charts
- Server Actions for all mutations — no API routes for web-initiated writes
- Keep Fastify API for external integrations like Amazon SP-API, eBay, cron jobs

### 11.3 State Management
- URL search params for filters, pagination, sort to enable shareable URLs
- `useOptimistic` for inline edits
- localStorage for sidebar collapse state and column preferences
- No global state library needed — Server Components + URL params suffice

### 11.4 Reusable Table Pattern
- Extract generic `DataTable<T>` from existing `InventoryTable`
- Accept: `data`, `columns`, `enableSelection`, `enableExpansion`, `pagination`
- All SC-style tables reuse this component
- Column definitions stay per-page for customization

### 11.5 Chart Library
- **recharts** — React-native, composable, SSR-friendly
- Used in: Dashboard, Reports, Performance, Analytics pages

### 11.6 Prisma Pattern
- Continue using `(prisma as any)` for stale type workaround
- Run `prisma generate` after each schema migration
- All new models follow existing naming conventions

---

## 12. Dependencies to Add

```json
{
  "recharts": "^2.x",
  "date-fns": "^3.x",
  "react-day-picker": "^8.x"
}
```

Already installed: `@tanstack/react-table`, `xlsx`, `zod`, `react-hook-form`, `@hookform/resolvers`

---

## 13. Summary

This plan transforms the current 10-page Nexus Commerce dashboard into a **60+ page** Amazon Seller Central replica with:

- **10 navigation sections** — Home, Catalog, Inventory, Pricing, Orders, Advertising, Reports, Performance, B2B, Apps — plus 1 custom section: Nexus Engine
- **Full consolidation** of overlapping Catalog and Inventory pages into a unified structure
- **8 new Prisma models** — FBAShipment, FBAShipmentItem, PricingRule, PricingRuleProduct, Return, SellerFeedback, Campaign, Coupon
- **15+ shared components** — DataTable, Pagination, FilterBar, Charts, Sidebar, etc.
- **Phased delivery** across 6 implementation phases
- **Zero breaking changes** to existing API backend — all new pages are additive