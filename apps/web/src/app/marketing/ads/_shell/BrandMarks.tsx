/**
 * CH1 — the square channel marks, shared by the rail's channel switch and the
 * SP super-wizard product rows.
 *
 * Both render as a 20x20 tile so they can be dropped in at any size and stay
 * optically matched: Amazon is its navy app tile (white "a" + orange smile),
 * eBay is its white app tile carrying the four-colour wordmark. Neither is a
 * new invention — the Amazon tile moved here verbatim from the super-wizard,
 * and the eBay lettering is the same four colours as `EbayMark`.
 *
 * Sized down to a corner chip (15px) the wordmark stops being readable, but the
 * pair still separates instantly on colour alone — navy block vs white block —
 * which is all the chip has to do.
 */

/** Amazon's app tile. Unchanged from the super-wizard original, so product rows render identically. */
export function AmazonBadge({ size = 15 }: { size?: number }) {
  return (
    <span className="h10-bmk" style={{ width: size, height: size }} aria-hidden>
      <svg viewBox="0 0 20 20" width={size} height={size}>
        <rect width="20" height="20" rx="3" fill="#232f3e" />
        <text x="4.5" y="13.5" fontSize="11" fontWeight="700" fill="#fff" fontFamily="Arial, sans-serif">a</text>
        <path d="M3.5 14.5c3 1.7 6.5 1.7 9.4-.2" stroke="#ff9900" strokeWidth="1.3" fill="none" strokeLinecap="round" />
      </svg>
    </span>
  )
}

/**
 * eBay's app tile. The wordmark runs nearly edge-to-edge exactly as it does on
 * the real icon; the hairline border keeps the white tile from dissolving into
 * the rail surface (#f1f3f5), which a plain white fill would.
 */
export function EbayBadge({ size = 15 }: { size?: number }) {
  return (
    <span className="h10-bmk" style={{ width: size, height: size }} aria-hidden>
      <svg viewBox="0 0 20 20" width={size} height={size}>
        <rect x="0.5" y="0.5" width="19" height="19" rx="2.5" fill="#fff" stroke="rgba(0,0,0,0.14)" strokeWidth="1" />
        <text x="10" y="13.2" textAnchor="middle" fontSize="7.5" fontWeight="700" letterSpacing="-0.3" fontFamily="Arial, sans-serif">
          <tspan fill="#E53238">e</tspan><tspan fill="#0064D2">b</tspan><tspan fill="#F5AF02">a</tspan><tspan fill="#86B817">y</tspan>
        </text>
      </svg>
    </span>
  )
}
