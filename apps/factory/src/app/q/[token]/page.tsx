/**
 * FP3.4 — the PUBLIC quote page the customer opens from the email link. No app
 * chrome, no session, no cost/margin (fed the frozen snapshot). Italian, since
 * it is customer-facing. Accept or request changes with one click.
 * EPQ.2 — failures render an inline banner (no alert()) and re-fetch the
 * quote's state, so a page that went stale (decided/expired after load) falls
 * back to the truthful banner instead of dead buttons (gap 16). Every open of
 * this page is view-tracked server-side by GET /api/q/[token].
 */
"use client";

import { use, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";

type SnapshotLine = { description: string; options: string[]; qty: number; unitNetCents: number; lineTotalCents: number };
type PublicQuote = {
  number: string;
  partyName: string;
  state: string;
  validUntilAt: string | null;
  expired: boolean;
  decided: boolean;
  converted: boolean;
  superseded?: boolean; // EPQ.1 — this link belongs to an older send of the quote
  latestExists?: boolean;
  snapshot: { depositPct: number | null; depositCents: number; lines: SnapshotLine[]; totalCents: number };
};

const eur = (c: number) => "€ " + (c / 100).toFixed(2).replace(".", ",");
const dmy = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("it-IT") : "—");

export default function PublicQuotePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [quote, setQuote] = useState<PublicQuote | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "notfound" | "done">("loading");
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [outcome, setOutcome] = useState<"accepted" | "rejected" | null>(null);
  const [actError, setActError] = useState<string | null>(null); // EPQ.2 — inline, not alert()

  const load = () => {
    fetch(`/api/q/${token}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: PublicQuote) => { setQuote(d); setStatus("ready"); })
      .catch(() => setStatus("notfound"));
  };
  useEffect(load, [token]);

  const act = async (kind: "accept" | "reject") => {
    setBusy(true);
    setActError(null);
    try {
      // same CSRF handshake as the app (apiFetch fetches a token first) — the
      // unguessable link token is the auth; CSRF double-submit stays uniform.
      const res = await apiFetch(`/api/q/${token}/${kind}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(kind === "reject" ? { note } : {}) });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error ?? "error"); }
      setOutcome(kind === "accept" ? "accepted" : "rejected");
      setStatus("done");
    } catch (e) {
      // EPQ.2 — inline banner + state auto-refresh: if the quote was decided
      // or expired after this page loaded, re-fetching swaps the dead buttons
      // for the truthful banner (gap 16)
      const msg = (e as Error).message;
      setActError(msg === "expired" ? "Questo preventivo è scaduto." : msg === "already_decided" ? "Questo preventivo è già stato gestito." : "Si è verificato un errore. Riprova tra qualche istante.");
      setRejecting(false);
      load();
    } finally {
      setBusy(false);
    }
  };

  const wrap: React.CSSProperties = { minHeight: "100dvh", background: "#f4f6f9", display: "grid", placeItems: "start center", padding: "40px 16px", fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", color: "#1c2530" };
  const card: React.CSSProperties = { width: 560, maxWidth: "100%", background: "#fff", border: "1px solid #e6e9ee", borderRadius: 14, padding: 28, boxShadow: "0 6px 22px rgb(20 28 38 / 0.08)" };

  if (status === "loading") return <div style={wrap}><div style={card}>Caricamento…</div></div>;
  if (status === "notfound") return <div style={wrap}><div style={card}><h2>Preventivo non trovato</h2><p style={{ color: "#5b6573" }}>Il link non è valido o è scaduto.</p></div></div>;
  if (status === "done") return <div style={wrap}><div style={card}><h2>{outcome === "accepted" ? "Grazie! Preventivo accettato." : "Grazie, abbiamo ricevuto la tua richiesta."}</h2><p style={{ color: "#5b6573" }}>{outcome === "accepted" ? "Ti contatteremo a breve per procedere." : "Rivedremo il preventivo e ti risponderemo."}</p></div></div>;

  const q = quote!;
  const s = q.snapshot;
  // EPQ.1 — a superseded link never offers a decision (the customer uses the
  // newest email's link; we deliberately do not surface the new token here)
  const openForDecision = q.state === "SENT" && !q.expired && !q.superseded;

  return (
    <div style={wrap}>
      <div style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <h1 style={{ fontSize: 20, margin: 0 }}>Preventivo {q.number}</h1>
          <span style={{ fontSize: 12, color: "#5b6573" }}>Valido fino al {dmy(q.validUntilAt)}</span>
        </div>
        <div style={{ fontSize: 13, color: "#5b6573", marginTop: 4, marginBottom: 18 }}>{q.partyName}</div>

        <div style={{ borderTop: "1px solid #e6e9ee" }}>
          {s.lines.map((l, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "12px 0", borderBottom: "1px solid #eef1f5" }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{l.description}{l.qty > 1 ? ` × ${l.qty}` : ""}</div>
                {l.options.length > 0 && <div style={{ fontSize: 12, color: "#5b6573", marginTop: 2 }}>{l.options.join(" · ")}</div>}
              </div>
              <div style={{ fontWeight: 700, fontFamily: "ui-monospace, monospace" }}>{eur(l.lineTotalCents)}</div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16 }}>
          <span style={{ fontSize: 15, fontWeight: 800 }}>Totale</span>
          <span style={{ fontSize: 15, fontWeight: 800, fontFamily: "ui-monospace, monospace" }}>{eur(s.totalCents)}</span>
        </div>
        {s.depositPct ? <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 13, color: "#5b6573" }}><span>Acconto ({s.depositPct}%)</span><span>{eur(s.depositCents)}</span></div> : null}

        {/* EPQ.2 — inline error (replaces alert()); the state below is re-fetched */}
        {actError && (
          <div style={{ marginTop: 18, padding: 12, background: "#fdecec", border: "1px solid #f5c2c4", borderRadius: 8, fontSize: 13, color: "#a12126" }}>{actError}</div>
        )}

        {q.superseded ? (
          <div style={{ marginTop: 22, padding: 12, background: "#eef4fd", borderRadius: 8, fontSize: 13, color: "#1c4d94" }}>
            Questa offerta è stata sostituita da una versione più recente — trovi il link aggiornato nell&apos;ultima email ricevuta.
          </div>
        ) : q.decided || q.converted ? (
          <div style={{ marginTop: 22, padding: 12, background: "#f4f6f9", borderRadius: 8, fontSize: 13, color: "#5b6573" }}>
            {q.converted ? "Questo preventivo è stato accettato ed è in lavorazione." : q.state === "ACCEPTED" ? "Questo preventivo è stato accettato." : "Questo preventivo non è più disponibile."}
          </div>
        ) : q.expired ? (
          <div style={{ marginTop: 22, padding: 12, background: "#fdf3d3", borderRadius: 8, fontSize: 13, color: "#9a6700" }}>Questo preventivo è scaduto — contattaci per un aggiornamento.</div>
        ) : openForDecision ? (
          rejecting ? (
            <div style={{ marginTop: 22, display: "grid", gap: 8 }}>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Cosa vorresti modificare? (facoltativo)" rows={3} style={{ border: "1px solid #d8dde4", borderRadius: 8, padding: 10, fontSize: 13, fontFamily: "inherit" }} />
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => void act("reject")} disabled={busy} style={btn("#e5484d")}>Invia richiesta</button>
                <button onClick={() => setRejecting(false)} style={btn("#8a93a1", true)}>Annulla</button>
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 22, display: "flex", gap: 10 }}>
              <button onClick={() => void act("accept")} disabled={busy} style={btn("#1f6fde")}>{busy ? "…" : "Accetta preventivo"}</button>
              <button onClick={() => setRejecting(true)} style={btn("#8a93a1", true)}>Richiedi modifiche</button>
            </div>
          )
        ) : null}
      </div>
    </div>
  );
}

const btn = (color: string, outline = false): React.CSSProperties => ({
  border: outline ? `1px solid #d8dde4` : "none",
  background: outline ? "#fff" : color,
  color: outline ? "#3a4452" : "#fff",
  borderRadius: 8, padding: "9px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer",
});
