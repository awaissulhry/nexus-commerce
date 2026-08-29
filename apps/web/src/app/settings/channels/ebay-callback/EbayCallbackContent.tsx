"use client";

/**
 * CX.1 — this page is a FORWARDER, kept only for the eBay RuName that still
 * points at `/settings/channels/ebay-callback`. The real callback lives on the
 * API host (`GET /api/cx/callback/ebay`): it consumes the single-use state,
 * checks the double-submit cookie, exchanges the code, places the grant, and
 * tells the opener. Nothing about the grant is decided in the browser any more
 * — the old page here posted a connection id it had minted itself, which was
 * the spoofable shape CX.0 retired.
 *
 * Once the RuName is re-pointed at the API callback, this file can go.
 */

import { useEffect } from "react";
import { getBackendUrl } from "@/lib/backend-url";

export default function EbayCallbackContent() {
  useEffect(() => {
    const qs = window.location.search;
    window.location.replace(`${getBackendUrl()}/api/cx/callback/ebay${qs}`);
  }, []);
  return (
    <div className="flex min-h-[40vh] items-center justify-center">
      <p className="text-sm" style={{ color: "var(--nds-text-muted)" }}>
        Finishing eBay sign-in…
      </p>
    </div>
  );
}
