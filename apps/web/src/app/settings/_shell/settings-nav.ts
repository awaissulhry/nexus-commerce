/**
 * Settings rebuild — Phase A.1
 *
 * Single source of truth for every settings route. Drives:
 *  - Left rail rendering (Settings shell)
 *  - Breadcrumb labels (no per-page hardcoding)
 *  - Cmd+K palette index (label + keywords + per-page deep-links)
 *
 * Add a new settings page in ONE place — here — and the shell,
 * breadcrumbs, and palette pick it up automatically.
 *
 * Keep this file framework-free: no React, no client/server split,
 * no Prisma. The palette indexer and breadcrumb resolver both
 * import it from both server and client contexts.
 */
import {
  Building2,
  User,
  Bell,
  KeyRound,
  Receipt,
  Plug,
  Languages,
  Sparkles,
  Image as ImageIcon,
  Megaphone,
  Layers,
  Workflow,
  ShieldCheck,
  Database,
  Webhook,
  History,
  type LucideIcon,
} from 'lucide-react'

/**
 * A single settings page. `keywords` feed the Cmd+K palette so an
 * operator can find a page by a field name even if the page label
 * doesn't include it (e.g. searching "Codice Fiscale" lands on
 * /settings/account because the keyword is registered here).
 */
export interface SettingsNavItem {
  /** URL — must match the file route exactly. */
  href: string
  /** Label shown in the rail, breadcrumb, and palette. */
  label: string
  /** Lucide icon component for the rail + palette. */
  icon: LucideIcon
  /** One-line description for the landing card + palette subtitle. */
  description: string
  /** Cmd+K search keywords beyond the label. Lowercase. */
  keywords: string[]
  /**
   * Status badge in the rail. 'live' = working today.
   * 'beta' = present but rough. 'soon' = stubbed/coming-in-this-phase.
   * Used by Phase A so users see where rebuild work is happening.
   */
  status?: 'live' | 'beta' | 'soon'
}

export interface SettingsNavGroup {
  /** Header text in the left rail. */
  label: string
  /** One-line description for the landing page card. */
  description: string
  items: SettingsNavItem[]
}

/**
 * Order matters — this is the rail render order top-to-bottom.
 * Categories follow the Stripe/Shopify pattern: personal first,
 * then workspace/fiscal, then integrations, then developer, then
 * compliance + audit.
 */
export const SETTINGS_NAV: SettingsNavGroup[] = [
  {
    label: 'Account',
    description: 'Your personal profile, security, and notifications.',
    items: [
      {
        href: '/settings/profile',
        label: 'Profile',
        icon: User,
        description:
          'Display name, email, avatar, timezone, working hours.',
        keywords: ['name', 'email', 'avatar', 'photo', 'timezone', 'locale'],
        status: 'live',
      },
      {
        href: '/settings/notifications',
        label: 'Notifications',
        icon: Bell,
        description:
          'In-app, email, and SMS preferences per event type.',
        keywords: [
          'email',
          'sms',
          'alerts',
          'digest',
          'quiet hours',
          'low stock',
          'orders',
        ],
        status: 'live',
      },
    ],
  },
  {
    label: 'Workspace',
    description:
      'Business identity, fiscal info, branding, and terminology.',
    items: [
      {
        href: '/settings/account',
        label: 'Business',
        icon: Building2,
        description:
          'Business name, address, timezone, currency, primary marketplace.',
        keywords: [
          'business',
          'address',
          'timezone',
          'currency',
          'marketplace',
          'country',
        ],
        status: 'live',
      },
      {
        href: '/settings/company',
        label: 'Company & fiscal',
        icon: Receipt,
        description:
          'Letterhead, VAT, Codice Fiscale, SDI, PEC, logo, signature.',
        keywords: [
          'vat',
          'piva',
          'p.iva',
          'codice fiscale',
          'sdi',
          'pec',
          'logo',
          'letterhead',
          'invoice',
          'tax id',
          'fiscal',
        ],
        status: 'live',
      },
      {
        href: '/settings/terminology',
        label: 'Terminology',
        icon: Languages,
        description:
          'Brand vocabulary — Giacca vs Giubbotto, channel-specific glossary.',
        keywords: ['glossary', 'translation', 'vocabulary', 'italian', 'brand voice'],
        status: 'live',
      },
    ],
  },
  {
    label: 'Catalog',
    description: 'PIM templates and DAM library.',
    items: [
      {
        href: '/settings/pim/families',
        label: 'Product families',
        icon: Layers,
        description: 'Akeneo-style attribute templates per product type.',
        keywords: ['pim', 'attributes', 'template', 'akeneo', 'category'],
        status: 'live',
      },
      {
        href: '/settings/pim/attributes',
        label: 'PIM attributes',
        icon: Layers,
        description: 'Reusable attribute groups for product enrichment.',
        keywords: ['pim', 'attribute group'],
        status: 'live',
      },
      {
        href: '/settings/pim/workflows',
        label: 'Workflows',
        icon: Workflow,
        description:
          'Content workflow stages — draft → review → published.',
        keywords: ['workflow', 'stages', 'review', 'approval'],
        status: 'live',
      },
      {
        href: '/settings/dam',
        label: 'DAM library',
        icon: ImageIcon,
        description:
          'Digital asset management — bulk upload, dedup, quality retry.',
        keywords: ['images', 'assets', 'dam', 'media', 'photos'],
        status: 'live',
      },
    ],
  },
  {
    label: 'Integrations',
    description:
      'Channel connections, advertising providers, AI providers.',
    items: [
      {
        href: '/settings/channels',
        label: 'Channels',
        icon: Plug,
        description:
          'Amazon, eBay, Shopify OAuth connections + token health.',
        keywords: [
          'amazon',
          'ebay',
          'shopify',
          'oauth',
          'connection',
          'reauth',
          'token',
        ],
        status: 'live',
      },
      {
        href: '/settings/advertising',
        label: 'Advertising',
        icon: Megaphone,
        description:
          'Amazon Ads provider status + spend rollup.',
        keywords: ['ads', 'sponsored', 'amazon ads', 'spend'],
        status: 'live',
      },
      {
        href: '/settings/ai',
        label: 'AI providers',
        icon: Sparkles,
        description:
          'AI provider usage and spend tracking.',
        keywords: ['ai', 'openai', 'anthropic', 'claude', 'gpt', 'tokens', 'spend'],
        status: 'live',
      },
    ],
  },
  {
    label: 'Developer',
    description: 'API keys, webhooks, and developer tooling.',
    items: [
      {
        href: '/settings/api-keys',
        label: 'API keys',
        icon: KeyRound,
        description:
          'Personal access tokens — scopes, IP allowlist, rotation.',
        keywords: [
          'api',
          'token',
          'key',
          'pat',
          'integration',
          'curl',
          'sdk',
        ],
        status: 'live',
      },
      {
        href: '/settings/webhooks',
        label: 'Webhooks',
        icon: Webhook,
        description:
          'Outbound webhook subscriptions — delivery log, retry, HMAC secret.',
        keywords: ['webhook', 'callback', 'event', 'http post', 'hmac', 'signature'],
        status: 'live',
      },
    ],
  },
  {
    label: 'Compliance & audit',
    description:
      'Data privacy, exports, audit trail, settings change history.',
    items: [
      {
        href: '/settings/audit',
        label: 'Audit log',
        icon: History,
        description:
          'Who changed which setting, when, with before/after diff.',
        keywords: ['audit', 'history', 'changelog', 'who changed'],
        status: 'live',
      },
      {
        href: '/settings/privacy',
        label: 'Data & privacy',
        icon: Database,
        description:
          'GDPR export, data retention, consent tracking, delete-account preview.',
        keywords: [
          'gdpr',
          'export',
          'privacy',
          'data',
          'retention',
          'consent',
          'cookie',
          'dpa',
          'delete account',
          'portability',
        ],
        status: 'live',
      },
      {
        href: '/settings/security',
        label: 'Security',
        icon: ShieldCheck,
        description:
          '2FA, recovery codes, sessions, login history.',
        keywords: ['2fa', 'totp', 'mfa', 'security', 'sessions', 'password', 'login'],
        status: 'live',
      },
    ],
  },
]

/**
 * Flat lookup of every nav item keyed by href. Used by:
 *  - Breadcrumb resolver (URL → label)
 *  - Cmd+K palette (full search index)
 *  - Active-state highlighting in the rail
 */
export const SETTINGS_NAV_BY_HREF: Record<string, SettingsNavItem> =
  Object.fromEntries(
    SETTINGS_NAV.flatMap((g) => g.items).map((i) => [i.href, i]),
  )

/**
 * Resolve a (possibly nested) settings URL to its parent nav item.
 * E.g. /settings/pim/families/abc123 → the "Product families" item
 * so the breadcrumb says "Settings > Catalog > Product families > abc123".
 */
export function findNavItemForPath(
  pathname: string,
): SettingsNavItem | undefined {
  // Exact match first.
  if (SETTINGS_NAV_BY_HREF[pathname]) return SETTINGS_NAV_BY_HREF[pathname]
  // Longest-prefix match for nested routes (e.g. families/[id]).
  let best: SettingsNavItem | undefined
  for (const item of Object.values(SETTINGS_NAV_BY_HREF)) {
    if (pathname.startsWith(item.href + '/')) {
      if (!best || item.href.length > best.href.length) best = item
    }
  }
  return best
}

/**
 * Group lookup for the same prefix-resolution as findNavItemForPath
 * — used for the breadcrumb's middle segment ("Catalog" in the
 * example above).
 */
export function findGroupForPath(
  pathname: string,
): SettingsNavGroup | undefined {
  const item = findNavItemForPath(pathname)
  if (!item) return undefined
  return SETTINGS_NAV.find((g) => g.items.includes(item))
}
