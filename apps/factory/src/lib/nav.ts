/**
 * F1 — the factory nav registry: the 11 approved F0-IA pages with their page
 * permission, FP cycle, purpose line and capability bullets (rendered by the
 * designed empty states until each page's cycle lands). Icons are lucide
 * names resolved in FactoryShell (this module stays server-safe).
 */
import { PAGES } from "@/lib/auth/permissions";

export type FactoryPage = {
  id: string;
  label: string;
  href: string;
  icon:
    | "inbox"
    | "file-text"
    | "clipboard-list"
    | "hammer"
    | "layers"
    | "package"
    | "users"
    | "truck"
    | "euro"
    | "bar-chart-3"
    | "settings";
  permission: string;
  fp: string; // page-cycle code, or "F1" for pages live in the foundation
  purpose: string;
  bullets: string[];
};

export const FACTORY_PAGES: FactoryPage[] = [
  {
    id: "inbox",
    label: "Inbox",
    href: "/inbox",
    icon: "inbox",
    permission: PAGES.inbox,
    fp: "FP1",
    purpose: "Where orders are born: every factory conversation, matched to its party, linked to its quote and order.",
    bullets: [
      "Four-pane thread workspace — list, thread, and a context rail showing the matched party and LIVE linked quote/order state",
      "Internal comments interleaved in the thread, visually distinct from customer messages (a mis-send to a brand is unrecoverable)",
      "Assignment + close-vs-archive semantics: done is a state of the work, not of someone's inbox view",
      "Snooze and follow-up reminders that cancel themselves when the customer replies",
      "Reply-with-quote: opens the configurator pre-scoped to the sender's price list",
    ],
  },
  {
    id: "quotes",
    label: "Quotes",
    href: "/quotes",
    icon: "file-text",
    permission: PAGES.quotes,
    fp: "FP3",
    purpose: "The configurator and RFQ pipeline: options → live price with margin visible → send into the same Gmail thread → track to won/lost → convert.",
    bullets: [
      "Option groups with requires/excludes constraints, re-checked on every toggle with plain-language explanations",
      "4-line visible waterfall per line: Cost → List (party's price list) → Adjustment (with reason) → Net, margin € and % beside",
      "Capable-to-promise date beside the price, derived from current floor load",
      "Goal-seek: type the customer's target price → margin shows; type target margin → price fills",
      "Snapshot-on-send versioning — sent quotes freeze; edits create v2",
    ],
  },
  {
    id: "orders",
    label: "Orders",
    href: "/orders",
    icon: "clipboard-list",
    permission: PAGES.orders,
    fp: "FP4",
    purpose: "The operational board: every confirmed job's status, owner, promise date and money summary, one click from its thread, quote, work order and shipment.",
    bullets: [
      "One-click Start production → Work Order with shared identity (ORD-214/1) and synced priority",
      "Status-words-as-UI: Materials \"In stock / Expected / Not available\" — click the word for the why and the fix",
      "The full linked chain as ONE timeline: email → quote v2 → confirmed → stages → label → delivered → review",
      "B2B size runs enter as a matrix row that explodes into per-size work orders",
      "monday-grade row grammar: status cells, hover choreography, batch bar, undo toast backed by ledger events",
    ],
  },
  {
    id: "production",
    label: "Production",
    href: "/production",
    icon: "hammer",
    permission: PAGES.production,
    fp: "FP6",
    purpose: "Work orders through CUTTING → STITCHING → ASSEMBLY → QC → PACKING: the Owner's board and the workers' zero-training shop-floor view.",
    bullets: [
      "Drag to reprioritize — material reservations reallocate by priority instantly",
      "Worker view: my next task, big Start / Pause / Finish buttons, timers feed actual costs",
      "Actual hide usage prompted at CUTTING finish and diffed against the estimate — the profit leak, watched",
      "QC stage: checklist + photo evidence + fit-check gate; PACKING blocks if the EN 17092 cert is missing or expired",
      "Estimated-vs-actual cost per work order, side by side — workers never see either",
    ],
  },
  {
    id: "materials",
    label: "Materials",
    href: "/materials",
    icon: "layers",
    permission: PAGES.materials,
    fp: "FP7",
    purpose: "Raw materials on an immutable movement ledger — stock is always a derived number with a full paper trail.",
    bullets: [
      "In stock / Committed / Expected / Calculated per material, perpetual from buy-make-sell activity",
      "Lots = hides and dye batches: color consistency and recall trace per work order",
      "\"+ Buy\" turns any shortage into a pre-filled purchase order in two clicks",
      "Reservations at order confirmation; released or consumed at stage completion",
      "Supplier price edit → visible ripple: which templates and open quotes it touches",
    ],
  },
  {
    id: "products",
    label: "Products",
    href: "/products",
    icon: "package",
    permission: PAGES.products,
    fp: "FP2",
    purpose: "The pricing model's home: templates, option groups with cost+price deltas, BOM composition, constraints, and the certificate registry.",
    bullets: [
      "Bundle → option groups (min–max) → options, each carrying cost and price deltas (absolute or %)",
      "One constraint table: requires/excludes with human messages (\"perforation excludes waterproof liner\")",
      "Per-option material draws — kangaroo and cowhide consume different hides",
      "Cost roll-up → target-margin suggested price, with cost-change reprice ripple",
      "EN 17092 certificate registry: class, number, notified body, expiry, covered styles/sizes",
    ],
  },
  {
    id: "contacts",
    label: "Contacts",
    href: "/contacts",
    icon: "users",
    permission: PAGES.contacts,
    fp: "FP5",
    purpose: "Brands, customers and suppliers as one Party model: price lists, terms, measurement profiles, and the full relationship history.",
    bullets: [
      "Sender emails are the Inbox matching keys — unmatched senders become parties in one click",
      "Named, versioned measurement profiles with fit notes and photos, referenced by many orders",
      "Side-by-side price comparison per party for the same configuration, discounts visible",
      "Per-party configurator defaults and deposit terms",
      "Reviews and ratings recorded against the party and its orders",
    ],
  },
  {
    id: "shipping",
    label: "Shipping",
    href: "/shipping",
    icon: "truck",
    permission: PAGES.shipping,
    fp: "FP8",
    purpose: "Carrier connections in action: the label queue, two-click purchase, pickups and tracking timelines that push status back into orders and threads.",
    bullets: [
      "Two clicks from order to printed label — service pre-assigned by rules, rates compared inline",
      "Sendcloud first: BRT, Poste, GLS, InPost, DHL, UPS through the account you already have",
      "Tracking by polling — no public endpoint needed; events land on the order timeline and in the thread",
      "Day-sheet manifest + pickup booking fused into one action",
      "Return authorizations born from the email thread, label attached",
    ],
  },
  {
    id: "financials",
    label: "Financials",
    href: "/financials",
    icon: "euro",
    permission: PAGES.financials,
    fp: "FP9",
    purpose: "Order-level money truth rolling up to party and period: quoted → invoiced → paid → balance, estimated vs actual margin, deposits outstanding.",
    bullets: [
      "Every number drills to its orders — every code a link",
      "Deposit requests gate production (FD13): work orders unlock when the deposit is recorded",
      "Estimated-vs-actual margin closed by production actuals, feeding the next quote",
      "Exports are the accountant interface — full period CSV/XLSX",
      "Field-gated by role: this page simply does not exist in a Worker's nav",
    ],
  },
  {
    id: "analytics",
    label: "Analytics",
    href: "/analytics",
    icon: "bar-chart-3",
    permission: PAGES.analytics,
    fp: "FP10",
    purpose: "The factory's rhythm: throughput, stage lead times, on-time rate, margin trends, quote win/loss, review scores.",
    bullets: [
      "Three live counters over leaderboards: unanswered threads, quotes awaiting approval, overdue promises",
      "Which stage eats lead time; which party's discounts erode margin; win rate by garment type",
      "Every aggregate drills to its rows",
      "Local SQLite: any question is one query away",
    ],
  },
  {
    id: "settings",
    label: "Settings",
    href: "/settings",
    icon: "settings",
    permission: PAGES.settings,
    fp: "F1",
    purpose: "Integrations, team & roles, import/export center, pricing defaults, stage configuration, backup health.",
    bullets: [],
  },
];

export const pageForPath = (pathname: string): FactoryPage | undefined =>
  FACTORY_PAGES.find((p) => pathname === p.href || pathname.startsWith(p.href + "/"));
