import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import { color } from '@nexus/ui/tokens/colors'
import { messagesFor } from '../../lib/i18n/messages'
import { FloorApp } from '../../floor/FloorApp'

/**
 * The Floor view (A2 §1.6; SCR-020 … 025): an enrolled tablet's app under `/floor`, installable (its own web app
 * manifest, `start_url` /floor), on the floor density, with no office chrome. Its text (`floor`) comes in both
 * languages: the screen speaks the device's language until someone signs in, then the person's (PLT-062), so the
 * client switches without asking the server. Never imports the office view (check-view-boundaries).
 */
export const metadata: Metadata = {
  title: 'Nexus Factory · Floor',
  manifest: '/floor/manifest.webmanifest',
  robots: { index: false, follow: false },
  appleWebApp: { capable: true, title: 'Nexus Floor', statusBarStyle: 'default' },
  icons: { icon: '/floor/icon.svg', apple: '/floor/icon.svg' },
}

export const viewport: Viewport = {
  themeColor: color.primary,
  width: 'device-width',
  initialScale: 1,
  // Gloved hands: + and - buttons zoom where it matters (design "Gloved hands"); the page itself stays put.
  viewportFit: 'cover',
}

export default function FloorLayout({ children }: { children: ReactNode }) {
  return <FloorApp catalogues={{ it: messagesFor('it', ['floor']), en: messagesFor('en', ['floor']) }}>{children}</FloorApp>
}
