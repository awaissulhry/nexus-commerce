/**
 * AMC.0 — this page stays, and now says why it is empty.
 *
 * It read "This screen is being rebuilt to match Adtomic — pixel-match in progress",
 * which describes our schedule rather than the blocker and reads as unfinished work.
 * It is not unfinished: AMC is blocked at Amazon, and would be blocked a second time
 * even if Amazon unblocked it. Both were re-measured on 2026-08-20.
 *
 * The page is deliberately NOT deleted. A surface waiting on a dependency is a
 * roadmap item, and removing it would lose the only place either fact is visible
 * from the product rather than from an audit document.
 *
 * Do not build against AMC until the first line below changes — the entitlement
 * audit's standing verdict is that code written against AMC or DSP today is dead
 * code. See reference_amazon_stack_entitlements.
 */
export default function Page() {
  return (
    <div className="h10-stub">
      <div className="crumb">Amazon Marketing Cloud</div>
      <h1>AMC Insights</h1>
      <p>
        AMC answers one question no other Amazon feed can: whether a shopper needed to see
        several kinds of ad before buying. This account cannot answer it yet, for two
        separate reasons — and the second one would still apply if the first were fixed
        tomorrow.
      </p>

      <div className="panel" style={{ textAlign: 'left', padding: '22px 24px', lineHeight: 1.6 }}>
        <p style={{ margin: '0 0 14px', color: '#5b6573' }}>
          <b style={{ color: '#1c2530' }}>1 · No AMC instance is provisioned.</b>{' '}
          Measured 20 August 2026: <code>GET /amc/accounts</code> returns{' '}
          <code>{'{"amcAccounts": []}'}</code>. The API is reachable and our credentials are
          accepted — there is simply no instance behind them. An instance is granted through an
          application to the Amazon representative, not by a setting in this console. Amazon DSP
          is separate and also absent: <code>/dsp/advertisers</code> answers{' '}
          <i>&ldquo;Selected profile type is not agency&rdquo;</i>.
        </p>
        <p style={{ margin: '0 0 14px', color: '#5b6573' }}>
          <b style={{ color: '#1c2530' }}>2 · There is nothing to overlap.</b>{' '}
          Every AMC view compares ad types against each other. This account runs{' '}
          <b>4 Sponsored Brands and 15 Sponsored Display campaigns, and all 19 are paused</b>,
          with no Sponsored TV. An instance provisioned today would draw a diagram of one circle.
        </p>
        <p style={{ margin: 0, color: '#5b6573' }}>
          <b style={{ color: '#1c2530' }}>What would light this up.</b> An AMC instance from
          Amazon, and at least one Sponsored Brands or Display campaign running long enough to
          attribute. Until both hold, the honest place to spend effort is the Sponsored Products
          reporting the account actually runs — and the four Sponsored Brands and Display
          Marketing Stream datasets that are already subscribed, already delivering to our queue,
          and currently ingested by nothing.
        </p>
      </div>
    </div>
  )
}
