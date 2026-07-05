/**
 * FP8 — the tracking note shared back into the customer's Gmail thread. Customer-
 * facing ⇒ Italian by default (the primary market; operators read English but
 * customers don't — see the app's language rule). Cost-free BY CONSTRUCTION: it
 * reads only the tracking fields, never a price, so it can't leak margin even if
 * a caller forgets to strip. The Owner sends it (never auto-sent) — this only
 * composes the text.
 */

export type TrackingEmailInput = {
  orderNumber: string;
  partyName?: string | null;
  carrier?: string | null;
  service?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
};

export type ComposedEmail = { subject: string; body: string };

export function trackingEmail(input: TrackingEmailInput, locale: "it" | "en" = "it"): ComposedEmail {
  const carrier = [input.carrier, input.service].filter(Boolean).join(" · ");
  const track = input.trackingNumber ? input.trackingNumber : "—";
  const url = input.trackingUrl ?? "";

  if (locale === "en") {
    const lines = [
      `Hello${input.partyName ? ` ${input.partyName}` : ""},`,
      "",
      `Your order ${input.orderNumber} has shipped.`,
      carrier ? `Carrier: ${carrier}` : "",
      `Tracking number: ${track}`,
      url ? `Track it here: ${url}` : "",
      "",
      "Thank you.",
    ];
    return { subject: `Order ${input.orderNumber} — shipped`, body: lines.filter((l) => l !== "").join("\n") };
  }

  const lines = [
    `Buongiorno${input.partyName ? ` ${input.partyName}` : ""},`,
    "",
    `il suo ordine ${input.orderNumber} è stato spedito.`,
    carrier ? `Corriere: ${carrier}` : "",
    `Numero di tracciamento: ${track}`,
    url ? `Segua la spedizione qui: ${url}` : "",
    "",
    "Grazie.",
  ];
  return { subject: `Ordine ${input.orderNumber} — spedito`, body: lines.filter((l) => l !== "").join("\n") };
}
