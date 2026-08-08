import type { ReactNode } from 'react'

/**
 * NAF.SB.3 — the one header every fleet page wears, so ten pages cannot drift
 * into ten different headers. Mirrors the `acr` / `acr-head` shape the fleet
 * Overview and the Control Room already use.
 */
export function FleetPageShell({
  title,
  sub,
  aside,
  children,
}: {
  title: string
  /** One sentence under the title. A page whose purpose cannot be said in one
   *  sentence is two pages. */
  sub: ReactNode
  /**
   * NAF.SB.ACT.S1R — the right-hand slot of the title row.
   *
   * `.acr-head` has always been `display: flex; justify-content: space-between`
   * and this component has always handed it exactly ONE child, so the second
   * half of the row was unreachable: measured on production at 1728px, the row
   * is 1614px wide with a 427px child — **1187px of dead header row on every
   * page that uses this shell**. Pages that needed a freshness stamp or a
   * refresh control therefore grew a SECOND row underneath, which is how
   * Activity ended up with its "as of / Refresh" pair floating 1080px from the
   * sentence it belongs to.
   *
   * `control-room.css`'s `.acr-refresh` was written for exactly this slot and
   * the Control Room still uses it; the shell is what dropped it.
   *
   * Optional and additive: with nothing passed, `{aside ?? null}` renders no
   * node and the header is byte-identical to before. Meant for a small
   * page-level instrument — a freshness readout, a refresh control — never for
   * a primary action, and never for anything a page can only say once it has
   * loaded its data.
   */
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="acr">
      <header className="acr-head">
        <div>
          <h1>{title}</h1>
          <p className="acr-sub">{sub}</p>
        </div>
        {aside ?? null}
      </header>
      {children}
    </div>
  )
}
