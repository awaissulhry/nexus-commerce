'use client'

/**
 * ACP.7b — global copilot mount.
 *
 * Renders ONE page-aware copilot for the whole app. Mounted once in the
 * root layout (a body-level sibling so it also floats over the standalone
 * Trading-Desk / Ads-Console surfaces). It reads the current pathname,
 * picks a per-section profile (title + example prompts) and hands the
 * route to the backend, which frames the model for that surface. This is
 * how the copilot reaches every page + subpage — including the
 * untouchable flat-file editors — without editing a single page file.
 *
 * Customer-facing public routes are excluded (the copilot is an operator
 * tool).
 */

import { usePathname } from '@/lib/workspaces/navigation'
import AiCopilot from './AiCopilot'
import { WORKSPACES_ENABLED, isIdentityPath } from '@/lib/workspaces/paths'

/** Public / customer-facing routes that must NOT show the operator copilot. */
const EXCLUDED_PREFIXES = ['/track', '/unsubscribed', '/login', '/profiles', '/accept-invite', '/accept-workspace-invite', '/forgot-password', '/reset-password', '/po', '/r']
/*
 * Routes that own their whole viewport. The Product Edit Studio is a full-bleed sheet: it already
 * drops the app top bar (AppShell `NO_TOPBAR_PATTERNS`), and the floating "Ask AI" button was
 * measured sitting on the sheet's horizontal scrollbar and footer strip (y 834–882 over 845–897 at
 * 1728×906, 2026-09-04, CT.1). A sheet has no spare corner, so the button is not shown there — the
 * same pattern as the top bar, one line to reverse.
 */
const EXCLUDED_PATTERNS = [/^\/products\/[^/]+\/edit\/studio(\/|$)/]

interface Profile {
  match: string[]
  title: string
  placeholder: string
  suggestions: string[]
}

// First matching profile wins; falls through to a generic commerce copilot.
const PROFILES: Profile[] = [
  {
    match: ['/products', '/catalog', '/list'],
    title: 'Catalog copilot',
    placeholder: 'Ask about your catalog…',
    suggestions: [
      'Which SKUs are missing images or bullets?',
      'What’s blocking a product from publishing?',
      'Draft better bullets + SEO for a SKU',
    ],
  },
  {
    match: ['/listings'],
    title: 'Listings copilot',
    placeholder: 'Ask about listings…',
    suggestions: [
      'What’s blocking a clean publish on each channel?',
      'Which listings are unpublished or incomplete?',
      'Draft improved listing content for a SKU',
    ],
  },
  {
    match: ['/orders'],
    title: 'Orders copilot',
    placeholder: 'Ask about orders…',
    suggestions: [
      'How many orders this month, and from which marketplaces?',
      'Find recent orders from a buyer',
      'Draft a friendly reply to a customer about their order',
    ],
  },
  {
    match: ['/fulfillment', '/inventory'],
    title: 'Inventory copilot',
    placeholder: 'Ask about stock…',
    suggestions: [
      'Where is channel stock drifting?',
      'What should I reorder, and how urgently?',
      'Show stock levels for a SKU',
    ],
  },
  {
    match: ['/pricing'],
    title: 'Pricing copilot',
    placeholder: 'Ask about pricing…',
    suggestions: [
      'Which products are priced below cost or floor?',
      'What’s the price spread across channels for a SKU?',
      'Propose a price change for a SKU',
    ],
  },
  {
    match: ['/marketing'],
    title: 'Marketing copilot',
    placeholder: 'Ask about marketing…',
    suggestions: [
      'How are campaigns performing?',
      'What looks anomalous in spend or ACOS?',
      'Summarise this week’s marketing results',
    ],
  },
  {
    match: ['/insights', '/analytics', '/performance', '/reports', '/dashboard'],
    title: 'Insights copilot',
    placeholder: 'Ask about performance…',
    suggestions: [
      'How are sales tracking this month?',
      'What looks anomalous right now?',
      'What should I act on next?',
    ],
  },
  {
    match: ['/customers'],
    title: 'Customers copilot',
    placeholder: 'Ask about customers…',
    suggestions: [
      'Who are my top customers this quarter?',
      'How are orders trending by marketplace?',
      'Draft a message to a customer',
    ],
  },
  {
    match: [
      '/sync-logs',
      '/monitoring',
      '/logs',
      '/audit-log',
      '/reconciliation',
      '/outbound',
      '/engine',
    ],
    title: 'Operations copilot',
    placeholder: 'Ask about operations…',
    suggestions: [
      'What looks anomalous right now?',
      'Any unresolved channel stock drift?',
      'Summarise recent sync activity',
    ],
  },
  {
    match: ['/settings'],
    title: 'Settings copilot',
    placeholder: 'Ask…',
    suggestions: [
      'How is AI spend trending?',
      'What can the copilot do here?',
      'What’s waiting for my approval?',
    ],
  },
]

const DEFAULT_PROFILE: Omit<Profile, 'match'> = {
  title: 'Commerce copilot',
  placeholder: 'Ask…',
  suggestions: [
    'How are sales tracking this month?',
    'What looks anomalous right now?',
    'What should I act on next?',
  ],
}

function profileFor(path: string): Omit<Profile, 'match'> {
  const hit = PROFILES.find((p) =>
    p.match.some((m) => path === m || path.startsWith(`${m}/`)),
  )
  return hit ?? DEFAULT_PROFILE
}

export default function CopilotMount() {
  const pathname = usePathname() || ''
  if (
    (WORKSPACES_ENABLED && isIdentityPath(pathname)) ||
    EXCLUDED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ||
    EXCLUDED_PATTERNS.some((r) => r.test(pathname))
  )
    return null
  const profile = profileFor(pathname)
  return (
    <AiCopilot
      pageContext={{ route: pathname }}
      title={profile.title}
      placeholder={profile.placeholder}
      suggestions={profile.suggestions}
    />
  )
}
