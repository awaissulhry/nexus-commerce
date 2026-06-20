/**
 * Rules & Automation sub-tree layout. Its only job is to load the Rules-specific
 * stylesheet (builder · rule-type modal · bulk-edit) in isolation from the shared
 * ads.css — so this session can add Rules styles without touching a file the
 * concurrent Keyword-Harvest session is also editing.
 */
import './rules-automation.css'
import type { ReactNode } from 'react'

export default function RulesAutomationLayout({ children }: { children: ReactNode }) {
  return <>{children}</>
}
