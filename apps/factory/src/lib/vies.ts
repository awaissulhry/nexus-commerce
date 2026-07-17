/**
 * EPQ.5 — VIES checkVatApprox client (SOAP, ec.europa.eu). The returned
 * `requestIdentifier` + timestamp are the canonical audit proof that a
 * counterparty's VAT number was valid when the art. 41 zero-rating was
 * applied (substantive condition since the 2020 Quick Fixes) — which is why
 * we call checkVatApprox WITH our own VAT (env FACTORY_VAT_NUMBER): VIES only
 * mints a consultation number when the requester identifies itself.
 * Envelope build + response parse are PURE (unit-tested); the fetch is the
 * one impure edge and fails soft (offline → a friendly retry error).
 */

const VIES_ENDPOINT = "https://ec.europa.eu/taxation_customs/vies/services/checkVatService";

/** "IT01234567890" → { country: "IT", number: "01234567890" } (null = unparseable). */
export function splitVat(vat: string | null | undefined): { country: string; number: string } | null {
  const raw = (vat ?? "").replace(/\s/g, "").toUpperCase();
  const m = /^([A-Z]{2})([0-9A-Z+*]{2,12})$/.exec(raw);
  return m ? { country: m[1], number: m[2] } : null;
}

const xmlEscape = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c] as string));

export function buildCheckVatApproxEnvelope(p: {
  country: string;
  number: string;
  requesterCountry: string;
  requesterNumber: string;
}): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:ec.europa.eu:taxud:vies:services:checkVat:types">` +
    `<soapenv:Header/><soapenv:Body><urn:checkVatApprox>` +
    `<urn:countryCode>${xmlEscape(p.country)}</urn:countryCode>` +
    `<urn:vatNumber>${xmlEscape(p.number)}</urn:vatNumber>` +
    `<urn:requesterCountryCode>${xmlEscape(p.requesterCountry)}</urn:requesterCountryCode>` +
    `<urn:requesterVatNumber>${xmlEscape(p.requesterNumber)}</urn:requesterVatNumber>` +
    `</urn:checkVatApprox></soapenv:Body></soapenv:Envelope>`
  );
}

export type ViesResult = {
  valid: boolean;
  requestIdentifier: string | null;
  traderName: string | null;
  fault: string | null;
};

const tag = (xml: string, name: string): string | null => {
  const m = new RegExp(`<(?:[\\w-]+:)?${name}[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`).exec(xml);
  return m ? m[1].trim() : null;
};

const xmlUnescape = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

/** PURE — parse the checkVatApprox SOAP response (or fault). */
export function parseViesResponse(xml: string): ViesResult {
  const fault = tag(xml, "faultstring");
  if (fault) return { valid: false, requestIdentifier: null, traderName: null, fault };
  const valid = (tag(xml, "valid") ?? "").toLowerCase() === "true";
  const requestIdentifier = tag(xml, "requestIdentifier") || null;
  const rawName = tag(xml, "traderName");
  const traderName = rawName && rawName !== "---" ? xmlUnescape(rawName) : null;
  return { valid, requestIdentifier, traderName, fault: null };
}

/** The one impure call. Throws on network failure — callers translate to a friendly 503. */
export async function checkViesVat(p: {
  country: string;
  number: string;
  requesterCountry: string;
  requesterNumber: string;
}): Promise<ViesResult> {
  const res = await fetch(VIES_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: "" },
    body: buildCheckVatApproxEnvelope(p),
    signal: AbortSignal.timeout(12_000),
  });
  const body = await res.text();
  return parseViesResponse(body);
}
