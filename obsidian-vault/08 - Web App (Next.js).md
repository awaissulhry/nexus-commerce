# Web App — Next.js

→ [[00 - Nexus Commerce MOC]] | [[01 - System Architecture Overview]]

## Stack

| Property | Value |
|----------|-------|
| Framework | Next.js 16.2.4 |
| Router | **App Router** |
| React | 18.2.0 |
| Styling | Tailwind CSS 3.4.0 + PostCSS 8.4 |
| Font Stack | Inter (body), Space Grotesk (display), JetBrains Mono (data) |
| Deployment | Vercel (fra1 Frankfurt) |
| Package name | `@nexus/web` |
| Location | `apps/web/` |

---

## App Router Structure (`apps/web/src/app/`)

### Route Groups

| Route | Purpose |
|-------|---------|
| `/dashboard` | Overview, global snapshot, sales/order/fulfillment widgets |
| `/products` | Master grid, editor, variants, images, SKU aliases |
| `/listings` | Channel publication status, recovery, wizard, templates |
| `/fulfillment` | Stock, replenishment, returns, inbound/outbound, carriers, FNSKU labels |
| `/orders` | Order list, detail, fulfillment, reviews, refunds, invoices |
| `/pricing` | Repricing rules, price history, buy-box tracking |
| `/marketing` | DAM hub, A+ Content, Brand Story/Kit, campaigns, automation, content |
| `/insights` | Sales, profit, ads, portfolio, scenarios, anomalies, customer RFM dashboards |
| `/bulk-operations` | CSV/Excel import, templates, bulk actions, scheduled tasks |
| `/catalog` | Organize, matrix view, families, categories |
| `/customers` | Segments, RFM analysis, outreach |
| `/inventory` | Forecast, ABC classification, cycle counts |
| `/settings` | Webhooks, API keys, connections, audit logs, privacy, team management |
| `/admin` | System health, data wipe, monitoring, system flags |
| `/design` | Component showcase / design system storybook |
| `/_shared` | Shared layouts, hooks, context providers |

See [[10 - Pages & Routes]] for per-route detail.

---

## Key Layout Components

| Component | Purpose |
|-----------|---------|
| `AppShell` | Root layout wrapper (sidebar + topbar + content area) |
| `AppSidebar` | Navigation sidebar with channel/marketplace indicators |
| `MobileTopBar` | Responsive mobile navigation |
| `CommandPalette` | Cmd+K global command search |
| `CommandMatrixPanel` | Matrix view for bulk edit operations |
| `NotificationsBell` | Real-time notification UI + browser opt-in |
| `GlobalDlqBanner` | Dead letter queue health warning banner |
| `GlobalAccountHealthBanner` | Amazon account health indicator |
| `CompetitiveAlertWatcher` | Competitive pricing alert monitor |
| `CopilotMount` | AI assistant chat integration |

---

## Custom Hooks

| Hook | File | Purpose |
|------|------|---------|
| `useOrderEventsRefresh` | `use-order-events-refresh.ts` | SSE stream for order updates |
| `useReviewEventsRefresh` | `use-review-events-refresh.ts` | SSE stream for review events |
| `useImageManagement` | `useImageManagement.ts` | Image DAM integration |

---

## API Routes (Next.js Server)

Minimal `/api/*` routes in the web app — mostly delegates to Fastify backend:
- `/api/catalog` — catalog operations
- `/api/inventory` — inventory reads
- `/api/listings` — listing status
- `/api/outbound` — outbound sync triggers
- `/api/products` — product reads
- `/api/sync` — sync triggers

---

## Internationalisation (i18n)

| Property | Value |
|----------|-------|
| Default locale | English |
| Content locales | Italian (listing content), German, French, Spanish |
| Server helpers | `getServerLocale()`, `getServerT()` |
| Rule | UI stays **English only**; Italian is for customer-facing listing content |

> Locale won't switch headlessly in Playwright — trust push-hook parity/resolve check instead.

---

## Design System

All new UI **must** use `apps/web/src/design-system` primitives. No hand-rolled components.

See [[09 - Design System]] for full component inventory.

---

## Styling

```css
/* Design tokens as CSS custom properties */
--color-primary: ...
--spacing-*: ...
--radius-*: ...
--shadow-*: ...
--transition-*: ...
```

- Tailwind CSS with custom preset
- Dark mode support via CSS variables
- `globals.css` for base styles + token definitions

---

## State Management

- **Server state:** React Query / SWR patterns (via Fastify API)
- **Client state:** React context + hooks (no Redux/Zustand detected)
- **Dirty tracking:** `useDirtyRegistry` + `useNavigationGuard` (DSP-series edit UX)
- **Tab preferences:** `useTabPrefs` (TC-series tab consolidation)

---

## Code Splitting

- 10 heavy components code-split out of `AmazonFlatFileClient.tsx` via `next/dynamic`
- `useOpenOnce` hook for lazy-open panels
- Hover-prefetch for common navigation paths

---

## Environment Variables (Web)

| Variable | Purpose |
|----------|---------|
| `NEXT_PUBLIC_API_URL` | Fastify API base URL |
| `NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME` | DAM upload config |

---

## Related Notes

- [[09 - Design System]] — component library
- [[10 - Pages & Routes]] — all page routes in detail
- [[07 - Real-time Architecture]] — SSE hooks used in web
- [[04 - API Layer (Fastify)]] — backend this app calls
