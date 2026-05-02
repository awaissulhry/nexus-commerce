'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Package,
  Layers,
  Upload,
  Boxes,
  ShoppingBag,
  FileText,
  Tag,
  BarChart3,
  Activity,
  HeartPulse,
  Plug,
  Settings,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface NavItem {
  label: string
  href: string
  icon: LucideIcon
  disabled?: boolean // not yet built — greyed out
}

interface NavGroup {
  label: string
  items: NavItem[]
}

const NAV: NavGroup[] = [
  {
    label: 'Catalog',
    items: [
      { label: 'Products', href: '/inventory', icon: Package },
      { label: 'PIM Review', href: '/pim/review', icon: Layers },
      { label: 'Bulk Upload', href: '/inventory/upload', icon: Upload },
    ],
  },
  {
    label: 'Listings',
    items: [
      { label: 'All Listings', href: '/listings', icon: Boxes },
      { label: 'Amazon', href: '/listings/amazon', icon: ShoppingBag, disabled: true },
      { label: 'eBay', href: '/listings/ebay', icon: ShoppingBag, disabled: true },
      { label: 'Shopify', href: '/listings/shopify', icon: ShoppingBag, disabled: true },
      { label: 'WooCommerce', href: '/listings/woocommerce', icon: ShoppingBag, disabled: true },
    ],
  },
  {
    label: 'Operations',
    items: [
      { label: 'Orders', href: '/orders', icon: FileText },
      { label: 'Pricing', href: '/pricing', icon: Tag },
      { label: 'Insights', href: '/insights', icon: BarChart3, disabled: true },
    ],
  },
  {
    label: 'Monitoring',
    items: [
      { label: 'Activity Log', href: '/sync-logs', icon: Activity },
      { label: 'Sync Status', href: '/dashboard/health', icon: HeartPulse },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Connections', href: '/settings/channels', icon: Plug },
      { label: 'Settings', href: '/settings/account', icon: Settings },
    ],
  },
]

export default function AppSidebar() {
  const pathname = usePathname() ?? '/'

  const isActive = (href: string) => {
    if (href === '/') return pathname === '/'
    return pathname === href || pathname.startsWith(href + '/')
  }

  return (
    <aside className="w-56 bg-white border-r border-slate-200 flex flex-col h-screen sticky top-0 flex-shrink-0">
      {/* Logo */}
      <div className="h-14 flex items-center px-5 border-b border-slate-200 flex-shrink-0">
        <Link href="/" className="flex items-center gap-2">
          <div className="w-6 h-6 bg-blue-600 rounded flex items-center justify-center">
            <span className="text-white text-[10px] font-bold leading-none">N</span>
          </div>
          <span className="text-[14px] font-semibold text-slate-900">Nexus</span>
        </Link>
      </div>

      {/* Nav groups */}
      <nav className="flex-1 overflow-y-auto py-3">
        {NAV.map((group) => (
          <div key={group.label} className="mb-5">
            <div className="px-5 mb-1.5">
              <h3 className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                {group.label}
              </h3>
            </div>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const active = isActive(item.href)
                const Icon = item.icon
                if (item.disabled) {
                  return (
                    <li key={item.href}>
                      <span
                        className="flex items-center gap-2.5 mx-2 px-3 py-1.5 rounded-md text-[13px] text-slate-400 cursor-not-allowed select-none"
                        title="Coming soon"
                      >
                        <Icon className="w-4 h-4 flex-shrink-0" />
                        <span className="flex-1">{item.label}</span>
                      </span>
                    </li>
                  )
                }
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={cn(
                        'flex items-center gap-2.5 mx-2 px-3 py-1.5 rounded-md text-[13px] transition-colors',
                        active
                          ? 'bg-blue-50 text-blue-700 font-medium'
                          : 'text-slate-700 hover:bg-slate-50'
                      )}
                    >
                      <Icon className="w-4 h-4 flex-shrink-0" />
                      <span className="flex-1">{item.label}</span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* User block */}
      <div className="border-t border-slate-200 p-3 flex-shrink-0">
        <div className="flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-slate-50 cursor-pointer">
          <div className="w-7 h-7 bg-slate-200 rounded-full flex items-center justify-center flex-shrink-0">
            <span className="text-[11px] font-medium text-slate-700">A</span>
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[12px] font-medium text-slate-900 truncate">Awa</div>
            <div className="text-[11px] text-slate-500 truncate">Xavia Racing</div>
          </div>
        </div>
      </div>
    </aside>
  )
}
