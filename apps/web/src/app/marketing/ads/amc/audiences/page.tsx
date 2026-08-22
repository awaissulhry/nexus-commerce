/**
 * AMC.0 — this page stays, and now says what is and is not reachable.
 *
 * Unlike its sibling, this one is not uniformly blocked. `ads-audience.service.ts`
 * already sizes PAST_PURCHASERS and SUPPRESSION audiences from our OWN order
 * history — no AMC involved — and returns null with an `amc-estimate` basis for
 * the browsing-signal types that genuinely need it. So the honest message here is
 * a split, not a wall.
 *
 * What is still missing is not the estimate but the activation: creating a live
 * audience needs an AMC or DSP destination to create it IN, and this account has
 * neither. See ../page.tsx for the measurement.
 */
export default function Page() {
  return (
    <div className="h10-stub">
      <div className="crumb">Amazon Marketing Cloud</div>
      <h1>Audience Insights</h1>
      <p>
        Half of this is reachable today and half is not, and the line between them is
        where the signal comes from rather than how much work it would take.
      </p>

      <div className="panel" style={{ textAlign: 'left', padding: '22px 24px', lineHeight: 1.6 }}>
        <p style={{ margin: '0 0 14px', color: '#5b6573' }}>
          <b style={{ color: '#1c2530' }}>Reachable from our own data.</b>{' '}
          Past purchasers and suppression lists are built from order history we already hold,
          so their size is a real computed number rather than an estimate. The sizing already
          exists in the audience service.
        </p>
        <p style={{ margin: '0 0 14px', color: '#5b6573' }}>
          <b style={{ color: '#1c2530' }}>Needs AMC.</b>{' '}
          Viewers, cart abandoners, lookalikes and competitor audiences are all built from
          browsing signals, which only AMC carries. The service returns no size for these and
          labels the reason rather than guessing one.
        </p>
        <p style={{ margin: 0, color: '#5b6573' }}>
          <b style={{ color: '#1c2530' }}>And activation needs a destination.</b>{' '}
          Even a fully-sized audience has nowhere to go: creating a live one requires an AMC
          instance or a DSP advertiser, and this account has neither — measured 20 August 2026.
          See <b>AMC Insights</b> for the probe results.
        </p>
      </div>
    </div>
  )
}
