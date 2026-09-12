import { SettingsPaletteProvider } from './_shell/SettingsPaletteContext'
import { SettingsSaveBarProvider } from './_shell/SettingsSaveBar'
import { SettingsShellHeader } from './_shell/SettingsShellHeader'
import styles from './_shell/settings-shell.module.css'

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <SettingsPaletteProvider>
      <SettingsSaveBarProvider>
        <div className={styles.shell}>
          <SettingsShellHeader />
          {/* The navigation toggle occupies the header only; pages use the full content width. */}
          <div className={styles.content}>{children}</div>
        </div>
      </SettingsSaveBarProvider>
    </SettingsPaletteProvider>
  )
}
