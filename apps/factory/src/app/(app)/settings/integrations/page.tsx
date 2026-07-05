/**
 * F1 — Settings › Integrations: the Gmail connect flow WORKING end-to-end
 * (OAuth Desktop client → consent → label scope → backfill → live sync
 * status), Drive setup, and the connect-a-courier wizard with the FD6
 * capability probe. The riskiest integration, proven before any page cycle
 * depends on it (master prompt, Phase F1).
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { PageHeader } from "@/design-system/patterns";
import { Banner, Card, useToast } from "@/design-system/components";
import { Button, Input, Pill } from "@/design-system/primitives";
import { Listbox } from "@/design-system/components";
import { apiJson } from "@/lib/api-client";
import { useFactoryEvents } from "@/lib/use-factory-events";

type Status = {
  google: {
    configSaved: boolean;
    clientId: string | null;
    status: string;
    email: string | null;
    labelName: string | null;
    lastSyncAt: string | null;
    lastError: string | null;
    driveRootFolderId: string | null;
    drive: { usedBytes: number; limitBytes: number | null } | null;
  };
  sync: {
    conversations: number;
    messages: number;
    recent: { id: string; subject: string | null; lastMessageAt: string | null; party: { name: string; kind: string } | null }[];
  };
  carriers: { id: string; adapterId: string; label: string; caps: Record<string, unknown> | null; status: string }[];
};

const GB = 1024 ** 3;
const ago = (iso: string | null): string => {
  if (!iso) return "never";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

function GoogleSetupChecklist({ open }: { open: boolean }) {
  return (
    <details open={open} style={{ fontSize: 12.5, color: "var(--h10-text-2)", marginBottom: 12 }}>
      <summary style={{ cursor: "pointer", fontWeight: 600, color: "var(--h10-text)" }}>
        One-time Google Cloud setup (5 steps, free)
      </summary>
      <ol style={{ paddingLeft: 18, marginTop: 8, display: "grid", gap: 6 }}>
        <li>
          At <b>console.cloud.google.com</b>: create a project (e.g. “Nexus Factory”), then enable the{" "}
          <b>Gmail API</b> and <b>Google Drive API</b> (APIs &amp; Services → Library).
        </li>
        <li>
          OAuth consent screen: User type <b>External</b> → fill the app name + your email →{" "}
          <b style={{ color: "var(--h10-danger)" }}>PUBLISH TO PRODUCTION</b>. Do NOT leave it in
          “Testing” — Testing mode expires the connection every 7 days. Unverified + published is the
          documented personal-use path (&lt;100 users); you will click through one “unverified app”
          screen exactly once.
        </li>
        <li>
          Credentials → Create credentials → OAuth client ID → Application type <b>Desktop app</b>.
        </li>
        <li>
          Copy the <b>Client ID</b> (ends in <code>.apps.googleusercontent.com</code>) and the{" "}
          <b>Client secret</b> into the form below and save.
        </li>
        <li>Click Connect Google — approve both scopes (Gmail + Drive file access).</li>
      </ol>
    </details>
  );
}

function IntegrationsInner() {
  const params = useSearchParams();
  const { toast } = useToast();
  const [status, setStatus] = useState<Status | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [labels, setLabels] = useState<{ id: string; name: string }[]>([]);
  const [chosenLabel, setChosenLabel] = useState<string>("");
  const [editClient, setEditClient] = useState(false);
  const [changingLabel, setChangingLabel] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [scPublic, setScPublic] = useState("");
  const [scSecret, setScSecret] = useState("");
  const [probe, setProbe] = useState<{ checks: { name: string; ok: boolean; detail: string }[] } | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await apiJson<Status>("/api/integrations/status"));
    } catch {
      /* keep last */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useFactoryEvents(["integration.changed", "conversation.synced"], load);

  useEffect(() => {
    const err = params.get("google_error");
    if (err) toast(err, "danger");
    if (params.get("connected") === "google") toast("Google connected", "success");
  }, [params, toast]);

  const g = status?.google;
  const connected = g?.status === "connected";
  const clientIdLooksValid = !!g?.clientId && /\.apps\.googleusercontent\.com$/.test(g.clientId);

  const saveConfig = async () => {
    setBusy("config");
    try {
      await apiJson("/api/integrations/google/config", {
        method: "POST",
        body: JSON.stringify({ clientId, clientSecret }),
      });
      setClientId("");
      setClientSecret("");
      setEditClient(false);
      toast("OAuth client saved", "success");
      await load();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(null);
    }
  };

  const connect = async () => {
    setBusy("connect");
    try {
      const { url } = await apiJson<{ url: string }>("/api/integrations/google/connect", { method: "POST" });
      window.location.href = url;
    } catch (e) {
      toast((e as Error).message, "danger");
      setBusy(null);
    }
  };

  const loadLabels = async () => {
    setBusy("labels");
    try {
      const { labels } = await apiJson<{ labels: { id: string; name: string }[] }>(
        "/api/integrations/google/labels",
      );
      setLabels(labels);
      if (!labels.length) toast("No user labels found — create a 'Factory' label in Gmail first", "info");
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(null);
    }
  };

  const applyLabel = async () => {
    const label = labels.find((l) => l.id === chosenLabel);
    if (!label) return;
    setBusy("backfill");
    try {
      const res = await apiJson<{ threads: number; messages: number }>("/api/integrations/google/label", {
        method: "POST",
        body: JSON.stringify({ labelId: label.id, labelName: label.name }),
      });
      toast(`Scoped to "${label.name}" — backfilled ${res.threads} threads / ${res.messages} messages`, "success");
      setChangingLabel(false);
      await load();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(null);
    }
  };

  const driveSetup = async () => {
    setBusy("drive");
    try {
      await apiJson("/api/integrations/google/drive-setup", { method: "POST" });
      toast("Drive folder ready", "success");
      await load();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(null);
    }
  };

  const connectCarrier = async () => {
    setBusy("carrier");
    setProbe(null);
    try {
      const res = await apiJson<{ probe: { checks: { name: string; ok: boolean; detail: string }[] } }>(
        "/api/integrations/carriers",
        {
          method: "POST",
          body: JSON.stringify({ adapterId: "sendcloud", publicKey: scPublic, secretKey: scSecret }),
        },
      );
      setProbe(res.probe);
      setScPublic("");
      setScSecret("");
      toast("Sendcloud connected", "success");
      await load();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="factory-coming">
      <PageHeader
        eyebrow="Settings"
        title="Integrations"
        subtitle="The platform's front door (Gmail), its filing cabinet (Drive), and its loading dock (carriers)."
      />
      <div style={{ display: "grid", gap: 14 }}>
        <Card padded header="Gmail — the front door">
          {!connected && (
            <>
              <GoogleSetupChecklist open={!g?.configSaved || editClient} />
              {g?.configSaved && !editClient && (
                <div style={{ display: "grid", gap: 10 }}>
                  <div style={{ fontSize: 12.5, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    {clientIdLooksValid ? (
                      <Pill tone="success">Client on file</Pill>
                    ) : (
                      <Pill tone="danger">Wrong value saved</Pill>
                    )}
                    <code style={{ fontSize: 11.5, wordBreak: "break-all" }}>{g.clientId}</code>
                    <button
                      type="button"
                      onClick={() => setEditClient(true)}
                      style={{ background: "none", border: "none", color: "var(--h10-text-link)", cursor: "pointer", fontSize: 12.5, padding: 0 }}
                    >
                      Replace
                    </button>
                  </div>
                  {!clientIdLooksValid && (
                    <Banner tone="danger" title="This is not a Google Client ID">
                      A real Client ID ends in <code>.apps.googleusercontent.com</code> (Google Cloud
                      console → Credentials → your Desktop app). Click <b>Replace</b> and paste the
                      correct pair — the saved value above was accepted by an earlier version of this
                      form without validation.
                    </Banner>
                  )}
                  <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <Button
                      variant="primary"
                      onClick={() => void connect()}
                      disabled={busy === "connect" || !clientIdLooksValid}
                      title={!clientIdLooksValid ? "Replace the client ID first" : undefined}
                    >
                      {busy === "connect" ? "Opening Google…" : "Connect Google"}
                    </Button>
                    <span style={{ fontSize: 12.5, color: "var(--h10-text-2)" }}>
                      Approve Gmail + Drive file access; you'll land back here.
                    </span>
                  </div>
                </div>
              )}
              {(!g?.configSaved || editClient) && (
                <div style={{ display: "grid", gap: 10, maxWidth: 480 }}>
                  <Input
                    placeholder="Client ID — ends in .apps.googleusercontent.com"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                  />
                  <Input
                    placeholder="Client secret (starts with GOCSPX- on new clients)"
                    type="password"
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                  />
                  <div style={{ display: "flex", gap: 8 }}>
                    <Button variant="primary" onClick={() => void saveConfig()} disabled={busy === "config" || !clientId || !clientSecret}>
                      {busy === "config" ? "Saving…" : "Save OAuth client"}
                    </Button>
                    {editClient && (
                      <Button onClick={() => setEditClient(false)}>Cancel</Button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
          {connected && g && (
            <div style={{ display: "grid", gap: 12 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12.5 }}>
                <Pill tone="success">Connected</Pill>
                <b>{g.email}</b>
                <span style={{ color: "var(--h10-text-3)" }}>
                  · mail synced {ago(g.lastSyncAt)} · {status!.sync.conversations} conversations / {status!.sync.messages} messages
                </span>
              </div>
              {g.lastError && <Banner tone="danger" title="Last sync error">{g.lastError}</Banner>}
              {(!g.labelName || changingLabel) && (
                <div style={{ display: "grid", gap: 8, maxWidth: 480 }}>
                  <Banner tone="info" title="Pick the factory label (FD3)">
                    Ingestion is scoped to ONE Gmail label you control (e.g. “Factory”, filled by Gmail
                    filters). Personal mail never enters the local database. Scoping to the whole INBOX
                    works but pulls everything this address receives — on a shared business address,
                    prefer a dedicated label. Already-synced conversations stay; new mail follows the
                    new scope.
                  </Banner>
                  <div style={{ display: "flex", gap: 8 }}>
                    <Button onClick={() => void loadLabels()} disabled={busy === "labels"}>
                      {busy === "labels" ? "Loading…" : "Load labels"}
                    </Button>
                    {labels.length > 0 && (
                      <>
                        <Listbox
                          ariaLabel="Factory label"
                          options={labels.map((l) => ({ value: l.id, label: l.name }))}
                          value={chosenLabel}
                          onChange={setChosenLabel}
                          placeholder="Choose label…"
                        />
                        <Button variant="primary" onClick={() => void applyLabel()} disabled={!chosenLabel || busy === "backfill"}>
                          {busy === "backfill" ? "Backfilling…" : "Use this label"}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              )}
              {g.labelName && !changingLabel && (
                <div style={{ fontSize: 12.5, display: "flex", gap: 8, alignItems: "center" }}>
                  <span>
                    Scope: label <b>{g.labelName}</b> · polled every 10s by the worker
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setChangingLabel(true);
                      void loadLabels();
                    }}
                    style={{ background: "none", border: "none", color: "var(--h10-text-link)", cursor: "pointer", fontSize: 12.5, padding: 0 }}
                  >
                    Change
                  </button>
                </div>
              )}
              {changingLabel && (
                <div>
                  <Button onClick={() => setChangingLabel(false)}>Cancel label change</Button>
                </div>
              )}
              {status!.sync.recent.length > 0 && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Latest synced threads</div>
                  <div style={{ display: "grid", gap: 4 }}>
                    {status!.sync.recent.map((c) => (
                      <div key={c.id} style={{ fontSize: 12.5, display: "flex", gap: 8, alignItems: "baseline" }}>
                        <span style={{ fontWeight: 600 }}>{c.subject ?? "(no subject)"}</span>
                        <span style={{ color: "var(--h10-text-3)" }}>
                          {c.party ? `${c.party.name} (${c.party.kind})` : "unmatched sender"} · {ago(c.lastMessageAt)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div style={{ display: "flex", gap: 8 }}>
                <Button
                  onClick={() => void apiJson("/api/integrations/google/disconnect", { method: "POST" }).then(load)}
                >
                  Disconnect
                </Button>
              </div>
            </div>
          )}
        </Card>

        <Card padded header="Google Drive — customer-shared files">
          {!connected && <div style={{ fontSize: 12.5, color: "var(--h10-text-3)" }}>Connect Google first — Drive rides the same grant (drive.file scope: only files this app creates).</div>}
          {connected && g && (
            <div style={{ display: "grid", gap: 8, fontSize: 12.5 }}>
              {g.driveRootFolderId ? (
                <div>
                  <Pill tone="success">Folder ready</Pill>{" "}
                  “Nexus Factory” root folder created — order folders are created per shipment/quote by later cycles.
                </div>
              ) : (
                <div>
                  <Button variant="primary" onClick={() => void driveSetup()} disabled={busy === "drive"}>
                    {busy === "drive" ? "Creating…" : "Create the Nexus Factory folder"}
                  </Button>
                </div>
              )}
              {g.drive && (
                <div style={{ color: "var(--h10-text-2)" }}>
                  Storage: {(g.drive.usedBytes / GB).toFixed(1)} GB used
                  {g.drive.limitBytes ? ` of ${(g.drive.limitBytes / GB).toFixed(0)} GB` : ""} — bulky
                  production video stays on local disk by design (F0 finding #2).
                </div>
              )}
            </div>
          )}
        </Card>

        <Card padded header="Carriers — connect-a-courier">
          {status?.carriers.length ? (
            <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
              {status.carriers.map((c) => (
                <div key={c.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5 }}>
                  <Pill tone="success">{c.adapterId}</Pill>
                  <b>{c.label}</b>
                  <span style={{ color: "var(--h10-text-3)" }}>
                    {(c.caps as { supportsPollingTracking?: boolean })?.supportsPollingTracking
                      ? "tracking-poll OK"
                      : "tracking-poll unavailable on this plan"}
                  </span>
                  <button
                    style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--h10-text-link)", cursor: "pointer", fontSize: 12 }}
                    onClick={() =>
                      void apiJson(`/api/integrations/carriers?id=${c.id}`, { method: "DELETE" }).then(load)
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <div style={{ display: "grid", gap: 10, maxWidth: 480 }}>
            <div style={{ fontSize: 12.5, color: "var(--h10-text-2)" }}>
              <b>Sendcloud</b> — keys are under Settings → Integrations → Sendcloud API in your Sendcloud
              panel. The test call also probes what your plan tier unlocks (labels / tracking polls).
            </div>
            <Input placeholder="Public key" value={scPublic} onChange={(e) => setScPublic(e.target.value)} />
            <Input placeholder="Secret key" type="password" value={scSecret} onChange={(e) => setScSecret(e.target.value)} />
            <div>
              <Button variant="primary" onClick={() => void connectCarrier()} disabled={busy === "carrier" || !scPublic || !scSecret}>
                {busy === "carrier" ? "Testing…" : "Connect & test Sendcloud"}
              </Button>
            </div>
            {probe && (
              <div style={{ display: "grid", gap: 4 }}>
                {probe.checks.map((c) => (
                  <div key={c.name} style={{ fontSize: 12.5 }}>
                    <Pill tone={c.ok ? "success" : "warning"}>{c.ok ? "OK" : "!"}</Pill>{" "}
                    <b>{c.name}</b> — {c.detail}
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

export default function IntegrationsPage() {
  return (
    <Suspense fallback={null}>
      <IntegrationsInner />
    </Suspense>
  );
}
