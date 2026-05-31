/** Amazon-Ads-faithful console shell (standalone — registered in AppShell). */
import './amazon.css'
import type { ReactNode } from 'react'
import { ConsoleChrome } from './_shared/ConsoleChrome'

export default function AdsConsoleLayout({ children }: { children: ReactNode }) {
  return <div className="az-root"><ConsoleChrome>{children}</ConsoleChrome></div>
}
