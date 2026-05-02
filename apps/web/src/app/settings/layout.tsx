import Link from 'next/link'

const SETTINGS_TABS = [
  { label: 'Account', href: '/settings/account', icon: '🏢' },
  { label: 'Notifications', href: '/settings/notifications', icon: '🔔' },
  { label: 'API Keys', href: '/settings/api-keys', icon: '🔑' },
  { label: 'Profile', href: '/settings/profile', icon: '👤' },
  { label: 'Terminology', href: '/settings/terminology', icon: '🌐' },
]

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      {/* Settings sub-navigation */}
      <div className="bg-white border-b border-gray-200 mb-6 -mx-6 -mt-6 px-6">
        <nav className="flex gap-1 overflow-x-auto">
          {SETTINGS_TABS.map((tab) => (
            <Link
              key={tab.href}
              href={tab.href}
              className="flex items-center gap-2 px-4 py-3 text-sm font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-50 rounded-t-lg transition-colors whitespace-nowrap border-b-2 border-transparent hover:border-gray-300"
            >
              <span>{tab.icon}</span>
              <span>{tab.label}</span>
            </Link>
          ))}
        </nav>
      </div>
      {children}
    </div>
  )
}
