import type { ReactNode } from 'react'

export interface TabItem {
  id: string
  label: ReactNode
}

export interface TabsProps {
  tabs: TabItem[]
  active: string
  onChange: (id: string) => void
  className?: string
}

/** Underline tab bar (active = primary text + 2px primary indicator). Controlled. */
export function Tabs({ tabs, active, onChange, className }: TabsProps) {
  return (
    <div className={['nds-tabs', className ?? ''].filter(Boolean).join(' ')} role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === active}
          className={['nds-tab', t.id === active ? 'on' : ''].filter(Boolean).join(' ')}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}
