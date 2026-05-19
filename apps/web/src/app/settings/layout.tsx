/**
 * Settings rebuild — Phase A.2
 *
 * Two-pane shell for all /settings/* routes.
 *
 *   ┌─────────┬──────────────────────────────────────┐
 *   │  Rail   │  Sticky shell header (breadcrumb, ⌘K)│
 *   │ (left)  ├──────────────────────────────────────┤
 *   │ grouped │  Page content (preserved from old    │
 *   │   nav   │  per-page client components)         │
 *   └─────────┴──────────────────────────────────────┘
 *
 * Phase A is non-destructive: every existing sub-page is rendered
 * untouched as `{children}`. Sub-pages that still render their own
 * <PageHeader> show duplicated chrome until they migrate; that's
 * intentional during the phased rebuild — the visual duplication
 * signals which pages still need work.
 *
 * The palette + save-bar providers are mounted here so any page can
 * call useSettingsPalette() or useSettingsForm() without remounting.
 */

import { SettingsPaletteProvider } from './_shell/SettingsPaletteContext'
import { SettingsRail } from './_shell/SettingsRail'
import { SettingsSaveBarProvider } from './_shell/SettingsSaveBar'
import { SettingsShellHeader } from './_shell/SettingsShellHeader'

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <SettingsPaletteProvider>
      <SettingsSaveBarProvider>
        {/* Structural layer:
              Rail (left column on lg+, off-canvas drawer on mobile)
              + right column (header on top, content underneath).
            The negative margins cancel the global page-shell padding
            (RootLayout wraps {children} in p-3 md:p-6) so the rail
            spans the full viewport edge-to-edge. */}
        <div className="-m-3 md:-m-6 min-h-[calc(100vh-3.5rem)] flex bg-slate-50/40 dark:bg-slate-950/40">
          <SettingsRail />
          <div className="flex-1 min-w-0 flex flex-col">
            <SettingsShellHeader />
            <main className="flex-1 px-4 sm:px-6 py-6">{children}</main>
          </div>
        </div>
      </SettingsSaveBarProvider>
    </SettingsPaletteProvider>
  )
}
