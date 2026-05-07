import Link from 'next/link'
import { type LucideIcon } from 'lucide-react'
import { Button } from './Button'

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description: string
  action?:
    | { label: string; href: string; onClick?: never }
    | { label: string; onClick: () => void; href?: never }
}

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  const button = action ? (
    <Button variant="primary" size="sm" onClick={action.onClick}>
      {action.label}
    </Button>
  ) : null

  return (
    <div className="flex flex-col items-center justify-center py-12 px-6 text-center bg-white border border-slate-200 rounded-lg">
      <div className="w-12 h-12 rounded-lg bg-slate-100 flex items-center justify-center mb-3">
        <Icon className="w-6 h-6 text-slate-400" />
      </div>
      <h3 className="text-lg font-semibold text-slate-900 mb-1">{title}</h3>
      <p className="text-md text-slate-500 max-w-sm mb-4">{description}</p>
      {action?.href ? <Link href={action.href}>{button}</Link> : button}
    </div>
  )
}
