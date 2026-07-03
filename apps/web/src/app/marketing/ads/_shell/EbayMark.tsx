/**
 * ER1 — the eBay wordmark for the header account cluster (same 4-color
 * lettering as the sidebar channel button), rendered where Amazon pages show
 * the `.amz` "amazon" span. Sized to the account-button text line.
 */
export function EbayMark() {
  return (
    <svg width="34" height="14" viewBox="0 0 34 14" aria-label="eBay" role="img">
      <text x="0" y="11.5" fontSize="12.5" fontWeight="700" fontFamily="Arial, Helvetica, sans-serif" letterSpacing="-0.4">
        <tspan fill="#E53238">e</tspan>
        <tspan fill="#0064D2">b</tspan>
        <tspan fill="#F5AF02">a</tspan>
        <tspan fill="#86B817">y</tspan>
      </text>
    </svg>
  )
}
