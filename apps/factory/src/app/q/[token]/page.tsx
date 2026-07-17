/**
 * FP3.4 — the PUBLIC quote page the customer opens from the email link. No app
 * chrome, no session, no cost/margin (fed the frozen snapshot). Italian, since
 * it is customer-facing. Accept or request changes with one click.
 * EPQ.2 — failures render an inline banner (no alert()) and re-fetch the
 * quote's state; every open is view-tracked server-side by GET /api/q/[token].
 * EPQ.5 — per-tax-mode totals from the FROZEN snapshot (IT_B2C gross-first —
 * the compliance fix; IT_B2B net + IVA + totale; EU/extra-EU non-imponibile
 * note), deposit labeled by its legal character, legal clauses + CGV
 * reference, a required "Nome e cognome" on accept (SES practice — feeds the
 * evidence bundle), the deposit-payment block after acceptance (Stripe
 * env-gated + bank-transfer fallback), and the art. 2220 retention notice.
 */
"use client";

import { use, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";
import { RETENTION_NOTICE, depositPdfLabel, normalizeDepositKind, normalizeValidityWording, validityLine } from "@/lib/quotes/legal";

type SnapshotLine = {
  description: string; options: string[]; qty: number;
  unitNetCents: number; lineTotalCents: number;
  unitGrossCents?: number; lineGrossCents?: number; // EPQ.5 — gross-first only
};
type SnapshotTax = {
  mode: string; vatRatePct: number; imponibileCents: number; ivaCents: number;
  totaleCents: number; grossFirst: boolean; note: string | null; natura: string | null;
};
type DepositBlock = { depositCents: number; paid: boolean; stripePayable: boolean; bankDetails: string | null };
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
  snapshot: {
    depositPct: number | null; depositCents: number; lines: SnapshotLine[]; totalCents: number;
    tax?: SnapshotTax; depositKind?: string; validityWording?: string; clauses?: string[];
    cgv?: { version: string; url: string | null } | null;
  };
  deposit?: DepositBlock | null; // EPQ.5 — accepted quotes only
};

const eur = (c: number) => "€ " + (c / 100).toFixed(2).replace(".", ",");
const dmy = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("it-IT") : "—");

export default function PublicQuotePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [quote, setQuote] = useState<PublicQuote | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "notfound" | "done">("loading");
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [accepting, setAccepting] = useState(false); // EPQ.5 — name-confirm step
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [outcome, setOutcome] = useState<"accepted" | "rejected" | null>(null);
  const [actError, setActError] = useState<string | null>(null); // EPQ.2 — inline, not alert()
  const [deposit, setDeposit] = useState<DepositBlock | null>(null); // EPQ.5
  const [justPaid, setJustPaid] = useState(false); // EPQ.5 — Stripe success return

  const load = () => {
    fetch(`/api/q/${token}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: PublicQuote) => { setQuote(d); setDeposit(d.deposit ?? null); setStatus("ready"); })
      .catch(() => setStatus("notfound"));
  };
  useEffect(load, [token]);
  useEffect(() => {
    // EPQ.5 — back from Stripe Checkout (success_url carries ?paid=1)
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("paid") === "1") setJustPaid(true);
  }, []);

  const act = async (kind: "accept" | "reject") => {
    setBusy(true);
    setActError(null);
    try {
      // same CSRF handshake as the app (apiFetch fetches a token first) — the
      // unguessable link token is the auth; CSRF double-submit stays uniform.
      const body = kind === "reject" ? { note } : { name: name.trim() };
      const res = await apiFetch(`/api/q/${token}/${kind}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error ?? "error"); }
      if (kind === "accept") {
        const d = await res.json().catch(() => ({}));
        setDeposit((d as { deposit?: DepositBlock | null }).deposit ?? null);
      }
      setOutcome(kind === "accept" ? "accepted" : "rejected");
      setStatus("done");
    } catch (e) {
      // EPQ.2 — inline banner + state auto-refresh: if the quote was decided
      // or expired after this page loaded, re-fetching swaps the dead buttons
      // for the truthful banner (gap 16)
      const msg = (e as Error).message;
      setActError(
        msg === "expired" ? "Questo preventivo è scaduto." :
        msg === "already_decided" ? "Questo preventivo è già stato gestito." :
        msg === "name_required" ? "Inserisci nome e cognome per confermare l'accettazione." :
        "Si è verificato un errore. Riprova tra qualche istante.");
      setRejecting(false);
      load();
    } finally {
      setBusy(false);
    }
  };

  // EPQ.5 — Stripe Checkout hop (env-gated server-side; button hidden without keys)
  const payDeposit = async () => {
    setBusy(true);
    setActError(null);
    try {
      const res = await apiFetch(`/api/q/${token}/deposit-checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.url) throw new Error(d.error ?? "error");
      window.location.href = d.url as string;
    } catch {
      setActError("Il pagamento online non è disponibile in questo momento — puoi usare il bonifico indicato sotto.");
      setBusy(false);
    }
  };

  const wrap: React.CSSProperties = { minHeight: "100dvh", background: "#f4f6f9", display: "grid", placeItems: "start center", padding: "40px 16px", fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", color: "#1c2530" };
  const card: React.CSSProperties = { width: 560, maxWidth: "100%", background: "#fff", border: "1px solid #e6e9ee", borderRadius: 14, padding: 28, boxShadow: "0 6px 22px rgb(20 28 38 / 0.08)" };

  // EPQ.5 — the deposit payment block (post-acceptance; Stripe + bank fallback)
  const paymentSection = (d: DepositBlock | null) => {
    if (!d || d.depositCents <= 0) return null;
    return (
      <div style={{ marginTop: 18, padding: 14, background: "#f6f9f6", border: "1px solid #d9e7d9", borderRadius: 10, display: "grid", gap: 10 }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>Acconto da versare: {eur(d.depositCents)}</div>
        {(d.paid || justPaid) ? (
          <div style={{ fontSize: 13, color: "#1a7f37" }}>Pagamento dell&apos;acconto ricevuto — grazie!</div>
        ) : (
          <>
            {d.stripePayable && (
              <button onClick={() => void payDeposit()} disabled={busy} style={btn("#1a7f37")}>
                {busy ? "…" : `Paga l'acconto (${eur(d.depositCents)})`}
              </button>
            )}
            {d.bankDetails && (
              <div style={{ fontSize: 12.5, color: "#3a4452" }}>
                <div style={{ fontWeight: 600, marginBottom: 3 }}>{d.stripePayable ? "In alternativa, bonifico bancario:" : "Coordinate per il bonifico:"}</div>
                <div style={{ whiteSpace: "pre-wrap" }}>{d.bankDetails}</div>
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  const retentionFooter = (
    <div style={{ marginTop: 22, paddingTop: 12, borderTop: "1px solid #eef1f5", fontSize: 10.5, color: "#8a93a1" }}>{RETENTION_NOTICE}</div>
  );

  if (status === "loading") return <div style={wrap}><div style={card}>Caricamento…</div></div>;
  if (status === "notfound") return <div style={wrap}><div style={card}><h2>Preventivo non trovato</h2><p style={{ color: "#5b6573" }}>Il link non è valido o è scaduto.</p></div></div>;
  if (status === "done") {
    return (
      <div style={wrap}>
        <div style={card}>
          <h2>{outcome === "accepted" ? "Grazie! Preventivo accettato." : "Grazie, abbiamo ricevuto la tua richiesta."}</h2>
          <p style={{ color: "#5b6573" }}>{outcome === "accepted" ? "Ti contatteremo a breve per procedere." : "Rivedremo il preventivo e ti risponderemo."}</p>
          {outcome === "accepted" && paymentSection(deposit)}
          {retentionFooter}
        </div>
      </div>
    );
  }

  const q = quote!;
  const s = q.snapshot;
  const tax = s.tax ?? null; // EPQ.5 — legacy frozen snapshots have no tax block
  const grossFirst = tax?.grossFirst ?? false;
  // EPQ.1 — a superseded link never offers a decision (the customer uses the
  // newest email's link; we deliberately do not surface the new token here)
  const openForDecision = q.state === "SENT" && !q.expired && !q.superseded;

  return (
    <div style={wrap}>
      <div style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
          <h1 style={{ fontSize: 20, margin: 0 }}>Preventivo {q.number}</h1>
          <span style={{ fontSize: 12, color: "#5b6573", textAlign: "right" }}>
            {/* EPQ.5 — validity wording is a deliberate legal choice (art. 1329 c.c.) */}
            {tax ? validityLine(normalizeValidityWording(s.validityWording), dmy(q.validUntilAt)) : `Valido fino al ${dmy(q.validUntilAt)}`}
          </span>
        </div>
        <div style={{ fontSize: 13, color: "#5b6573", marginTop: 4, marginBottom: 18 }}>{q.partyName}</div>

        <div style={{ borderTop: "1px solid #e6e9ee" }}>
          {s.lines.map((l, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "12px 0", borderBottom: "1px solid #eef1f5" }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{l.description}{l.qty > 1 ? ` × ${l.qty}` : ""}</div>
                {l.options.length > 0 && <div style={{ fontSize: 12, color: "#5b6573", marginTop: 2 }}>{l.options.join(" · ")}</div>}
              </div>
              {/* EPQ.5 — a consumer sees VAT-inclusive line prices (gross-first) */}
              <div style={{ fontWeight: 700, fontFamily: "ui-monospace, monospace" }}>{eur(grossFirst ? l.lineGrossCents ?? l.lineTotalCents : l.lineTotalCents)}</div>
            </div>
          ))}
        </div>

        {/* EPQ.5 — totals per tax mode; legacy snapshots keep the historic net total */}
        {!tax ? (
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16 }}>
            <span style={{ fontSize: 15, fontWeight: 800 }}>Totale</span>
            <span style={{ fontSize: 15, fontWeight: 800, fontFamily: "ui-monospace, monospace" }}>{eur(s.totalCents)}</span>
          </div>
        ) : tax.grossFirst ? (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16 }}>
              <span style={{ fontSize: 15, fontWeight: 800 }}>Totale (IVA {tax.vatRatePct}% inclusa)</span>
              <span style={{ fontSize: 15, fontWeight: 800, fontFamily: "ui-monospace, monospace" }}>{eur(tax.totaleCents)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 12, color: "#8a93a1" }}>
              <span>Imponibile {eur(tax.imponibileCents)} · IVA {tax.vatRatePct}% {eur(tax.ivaCents)}</span>
            </div>
          </>
        ) : tax.note ? (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16 }}>
              <span style={{ fontSize: 15, fontWeight: 800 }}>Totale</span>
              <span style={{ fontSize: 15, fontWeight: 800, fontFamily: "ui-monospace, monospace" }}>{eur(tax.totaleCents)}</span>
            </div>
            <div style={{ marginTop: 4, fontSize: 12, color: "#8a93a1" }}>{tax.note}</div>
          </>
        ) : (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16, fontSize: 13, color: "#5b6573" }}>
              <span>Imponibile</span><span style={{ fontFamily: "ui-monospace, monospace" }}>{eur(tax.imponibileCents)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2, fontSize: 13, color: "#5b6573" }}>
              <span>IVA {tax.vatRatePct}%</span><span style={{ fontFamily: "ui-monospace, monospace" }}>{eur(tax.ivaCents)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
              <span style={{ fontSize: 15, fontWeight: 800 }}>Totale</span>
              <span style={{ fontSize: 15, fontWeight: 800, fontFamily: "ui-monospace, monospace" }}>{eur(tax.totaleCents)}</span>
            </div>
          </>
        )}
        {s.depositPct ? (
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 13, color: "#5b6573" }}>
            {/* EPQ.5 — ONE legal label per sum: acconto or caparra, never both */}
            <span>{tax ? depositPdfLabel(normalizeDepositKind(s.depositKind), s.depositPct) : `Acconto (${s.depositPct}%)`}</span>
            <span>{eur(s.depositCents)}</span>
          </div>
        ) : null}

        {/* EPQ.5 — legal clauses (caparra symmetric wording, B2C bespoke exclusion) */}
        {(s.clauses ?? []).length > 0 && (
          <div style={{ marginTop: 14, display: "grid", gap: 6 }}>
            {s.clauses!.map((c, i) => <div key={i} style={{ fontSize: 11.5, color: "#3a4452" }}>{c}</div>)}
          </div>
        )}
        {/* EPQ.5 — CGV reference (omitted until the Owner sets them) */}
        {s.cgv && (
          <div style={{ marginTop: 10, fontSize: 11.5, color: "#5b6573" }}>
            {s.cgv.url
              ? <>Si applicano le <a href={s.cgv.url} target="_blank" rel="noopener noreferrer" style={{ color: "#1f6fde" }}>Condizioni generali di vendita v{s.cgv.version}</a>.</>
              : <>Si applicano le Condizioni generali di vendita v{s.cgv.version}.</>}
          </div>
        )}

        {/* EPQ.2 — inline error (replaces alert()); the state below is re-fetched */}
        {actError && (
          <div style={{ marginTop: 18, padding: 12, background: "#fdecec", border: "1px solid #f5c2c4", borderRadius: 8, fontSize: 13, color: "#a12126" }}>{actError}</div>
        )}
        {justPaid && status === "ready" && !deposit?.paid && (
          <div style={{ marginTop: 18, padding: 12, background: "#eef8ee", border: "1px solid #d9e7d9", borderRadius: 8, fontSize: 13, color: "#1a7f37" }}>Pagamento completato — grazie! Riceverai conferma a breve.</div>
        )}

        {q.superseded ? (
          <div style={{ marginTop: 22, padding: 12, background: "#eef4fd", borderRadius: 8, fontSize: 13, color: "#1c4d94" }}>
            Questa offerta è stata sostituita da una versione più recente — trovi il link aggiornato nell&apos;ultima email ricevuta.
          </div>
        ) : q.decided || q.converted ? (
          <>
            <div style={{ marginTop: 22, padding: 12, background: "#f4f6f9", borderRadius: 8, fontSize: 13, color: "#5b6573" }}>
              {q.converted ? "Questo preventivo è stato accettato ed è in lavorazione." : q.state === "ACCEPTED" ? "Questo preventivo è stato accettato." : "Questo preventivo non è più disponibile."}
            </div>
            {/* EPQ.5 — an accepted quote keeps offering the deposit payment */}
            {(q.state === "ACCEPTED" || q.converted) && paymentSection(deposit)}
          </>
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
          ) : accepting ? (
            // EPQ.5 — typed-name confirmation (SES practice): the name lands in
            // the acceptance evidence bundle alongside timestamp/IP/PDF hash
            <div style={{ marginTop: 22, display: "grid", gap: 8 }}>
              <label style={{ fontSize: 13, color: "#3a4452", display: "grid", gap: 4 }}>
                Nome e cognome (per confermare l&apos;accettazione)
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Mario Rossi" autoFocus style={{ border: "1px solid #d8dde4", borderRadius: 8, padding: 10, fontSize: 13, fontFamily: "inherit" }} />
              </label>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => void act("accept")} disabled={busy || name.trim().length < 2} style={btn("#1f6fde")}>{busy ? "…" : "Confermo e accetto"}</button>
                <button onClick={() => setAccepting(false)} style={btn("#8a93a1", true)}>Annulla</button>
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 22, display: "flex", gap: 10 }}>
              <button onClick={() => setAccepting(true)} disabled={busy} style={btn("#1f6fde")}>Accetta preventivo</button>
              <button onClick={() => setRejecting(true)} style={btn("#8a93a1", true)}>Richiedi modifiche</button>
            </div>
          )
        ) : null}
        {retentionFooter}
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
