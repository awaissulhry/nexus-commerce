import type { ReactNode } from 'react'

/**
 * NAF.SB.3 — the one header every fleet page wears, so ten pages cannot drift
 * into ten different headers. Mirrors the `acr` / `acr-head` shape the fleet
 * Overview and the Control Room already use.
 */
export function FleetPageShell({
  title,
  sub,
  children,
}: {
  title: string
  /** One sentence under the title. A page whose purpose cannot be said in one
   *  sentence is two pages. */
  sub: ReactNode
  children: ReactNode
}) {
  return (
    <div className="acr">
      <header className="acr-head">
        <div>
          <h1>{title}</h1>
          <p className="acr-sub">{sub}</p>
        </div>
      </header>
      {children}
    </div>
  )
}
