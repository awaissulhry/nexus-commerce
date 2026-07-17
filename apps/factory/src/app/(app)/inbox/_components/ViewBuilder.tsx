/**
 * EPI3.3 — the view builder (§5.7): name/emoji, ALL-of + ANY-of condition
 * rows, exclusive/also-show toggles, and a LIVE preview — the form IS the
 * search (Gmail's law): every keystroke re-counts real matches through the
 * same builder the list uses, so preview and reality cannot disagree.
 */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { Drawer, Listbox, useToast } from "@/design-system/components";
import { Button, Checkbox, Input } from "@/design-system/primitives";
import { AsyncCombobox } from "@/components/AsyncCombobox";
import { apiJson } from "@/lib/api-client";
import { loadContacts } from "./ContextRail";
import { ago, type UserLite } from "./types";

export type Draft = { field: string; op: string; value: string | boolean | null; label?: string };
export type BuilderInitial = {
  id?: string;
  name?: string;
  emoji?: string | null;
  exclusive?: boolean;
  showElsewhere?: boolean;
  criteria?: { all: Draft[]; any: Draft[] };
};

const FIELDS: { value: string; label: string }[] = [
  { value: "senderDomain", label: "Sender domain" },
  { value: "senderEmail", label: "Sender email" },
  { value: "partyId", label: "Contact" },
  { value: "partyKind", label: "Contact kind" },
  { value: "subject", label: "Subject contains" },
  { value: "body", label: "Body contains" },
  { value: "hasAttachment", label: "Has attachment" },
  { value: "attachmentExt", label: "Attachment type" },
  { value: "unmatched", label: "Unmatched sender" },
  { value: "assigneeId", label: "Assignee" },
];

export const defaultDraft = (field: string): Draft => {
  if (field === "hasAttachment" || field === "unmatched") return { field, op: "is", value: true };
  if (field === "partyKind") return { field, op: "is", value: "CUSTOMER" };
  if (field === "assigneeId") return { field, op: "is", value: null };
  if (field === "senderEmail") return { field, op: "contains", value: "" };
  return { field, op: field === "subject" || field === "body" ? "contains" : "is", value: "" };
};

export const draftsValid = (rows: Draft[]) =>
  rows.every((r) => typeof r.value === "boolean" || r.value === null || (typeof r.value === "string" && r.value.trim().length > 0));

/** EPI3.3/3.4 — the shared condition-row editor (views + rules use ONE editor) */
export function CriteriaRows({
  rows,
  setRows,
  users,
}: {
  rows: Draft[];
  setRows: (r: Draft[]) => void;
  users: UserLite[];
}) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {rows.map((row, i) => (
        <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <Listbox
            ariaLabel="Field"
            options={FIELDS}
            value={row.field}
            onChange={(f) => setRows(rows.map((r, j) => (j === i ? defaultDraft(f) : r)))}
          />
          {row.field === "senderEmail" && (
            <Listbox
              ariaLabel="Operator"
              options={[
                { value: "contains", label: "contains" },
                { value: "is", label: "is exactly" },
              ]}
              value={row.op}
              onChange={(op) => setRows(rows.map((r, j) => (j === i ? { ...r, op } : r)))}
            />
          )}
          {row.field === "partyId" ? (
            <AsyncCombobox
              loader={loadContacts}
              value={typeof row.value === "string" ? row.value : undefined}
              valueLabel={row.label}
              placeholder="Search contacts…"
              ariaLabel="Contact"
              onChange={(id, o) => setRows(rows.map((r, j) => (j === i ? { ...r, value: id, label: o.label } : r)))}
            />
          ) : row.field === "partyKind" ? (
            <Listbox
              ariaLabel="Kind"
              options={[
                { value: "CUSTOMER", label: "Customer" },
                { value: "BRAND", label: "Brand (B2B)" },
                { value: "SUPPLIER", label: "Supplier" },
              ]}
              value={String(row.value)}
              onChange={(v) => setRows(rows.map((r, j) => (j === i ? { ...r, value: v } : r)))}
            />
          ) : row.field === "hasAttachment" || row.field === "unmatched" ? (
            <Listbox
              ariaLabel="Yes or no"
              options={[
                { value: "yes", label: "yes" },
                { value: "no", label: "no" },
              ]}
              value={row.value ? "yes" : "no"}
              onChange={(v) => setRows(rows.map((r, j) => (j === i ? { ...r, value: v === "yes" } : r)))}
            />
          ) : row.field === "assigneeId" ? (
            <Listbox
              ariaLabel="Assignee"
              options={[{ value: "", label: "Unassigned" }, ...users.map((u) => ({ value: u.id, label: u.displayName }))]}
              value={typeof row.value === "string" ? row.value : ""}
              onChange={(v) => setRows(rows.map((r, j) => (j === i ? { ...r, value: v || null } : r)))}
            />
          ) : (
            <Input
              placeholder={row.field === "senderDomain" ? "brand.it" : row.field === "attachmentExt" ? "pdf" : "text…"}
              value={typeof row.value === "string" ? row.value : ""}
              onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
            />
          )}
          <button
            type="button"
            aria-label="Remove condition"
            onClick={() => setRows(rows.filter((_, j) => j !== i))}
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--h10-text-3)", display: "inline-flex", padding: 4 }}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      <div>
        <Button onClick={() => setRows([...rows, defaultDraft("senderDomain")])}>
          <Plus size={13} /> Add condition
        </Button>
      </div>
    </div>
  );
}

export function ViewBuilder({
  open,
  initial,
  onClose,
  onSaved,
}: {
  open: boolean;
  initial: BuilderInitial | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [exclusive, setExclusive] = useState(true);
  const [showElsewhere, setShowElsewhere] = useState(false);
  const [all, setAll] = useState<Draft[]>([]);
  const [any, setAny] = useState<Draft[]>([]);
  const [preview, setPreview] = useState<{ count: number; sample: { id: string; subject: string | null; lastMessageAt: string | null; party: { name: string } | null; messages: { fromAddress: string }[] }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [users, setUsers] = useState<UserLite[]>([]);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? "");
    setEmoji(initial?.emoji ?? "");
    setExclusive(initial?.exclusive ?? true);
    setShowElsewhere(initial?.showElsewhere ?? false);
    setAll(initial?.criteria?.all ?? []);
    setAny(initial?.criteria?.any ?? (initial?.criteria ? [] : [defaultDraft("senderDomain")]));
    setPreview(null);
    setConfirmDelete(false);
    apiJson<{ users: UserLite[] }>("/api/users-lite")
      .then((d) => setUsers(d.users))
      .catch(() => {});
  }, [open, initial]);

  const criteria = useMemo(() => ({ all, any }), [all, any]);
  const complete = (all.length > 0 || any.length > 0) && draftsValid(all) && draftsValid(any);

  useEffect(() => {
    if (!open || !complete) {
      setPreview(null);
      return;
    }
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => {
      apiJson<NonNullable<typeof preview>>("/api/inbox/views/preview", {
        method: "POST",
        body: JSON.stringify({ criteria }),
      })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 350);
    return () => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, complete, JSON.stringify(criteria)]);

  const save = async () => {
    if (!name.trim() || !complete || busy) return;
    setBusy(true);
    try {
      const body = JSON.stringify({ name: name.trim(), emoji: emoji.trim() || null, exclusive, showElsewhere, criteria });
      if (initial?.id) await apiJson(`/api/inbox/views/${initial.id}`, { method: "PATCH", body });
      else await apiJson("/api/inbox/views", { method: "POST", body });
      toast(initial?.id ? "View updated" : "View created — matching threads route to it now", "success");
      onSaved();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!initial?.id || busy) return;
    setBusy(true);
    try {
      await apiJson(`/api/inbox/views/${initial.id}`, { method: "DELETE" });
      toast("View deleted — its conversations are back in the Inbox", "success");
      onSaved();
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer open={open} onClose={onClose} title={initial?.id ? "Edit view" : "New view"} width={540}>
      <div style={{ display: "grid", gap: 14, fontSize: 12.5 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <Input placeholder="View name (e.g. AWA Racing)" value={name} onChange={(e) => setName(e.target.value)} />
          <span style={{ width: 84 }}>
            <Input placeholder="🏍" value={emoji} onChange={(e) => setEmoji(e.target.value.slice(0, 4))} aria-label="Emoji" />
          </span>
        </div>

        <div style={{ display: "grid", gap: 6 }}>
          <b style={{ fontSize: 12.5 }}>Match ALL of</b>
          <CriteriaRows rows={all} setRows={setAll} users={users} />
        </div>
        <div style={{ display: "grid", gap: 6 }}>
          <b style={{ fontSize: 12.5 }}>…and ANY of</b>
          <CriteriaRows rows={any} setRows={setAny} users={users} />
        </div>

        <label style={{ display: "flex", gap: 7, alignItems: "center" }}>
          <Checkbox checked={exclusive} onChange={(e) => setExclusive(e.target.checked)} aria-label="Exclusive" />
          Exclusive — claims its matches out of the Inbox tab (tab order = priority)
        </label>
        {exclusive && (
          <label style={{ display: "flex", gap: 7, alignItems: "center" }}>
            <Checkbox checked={showElsewhere} onChange={(e) => setShowElsewhere(e.target.checked)} aria-label="Also show in Inbox" />
            …but ALSO keep them visible in the Inbox tab
          </label>
        )}

        <div style={{ border: "1px solid var(--h10-border-subtle)", borderRadius: 10, padding: 10, display: "grid", gap: 6, background: "var(--h10-surface-raised)" }}>
          <b style={{ fontSize: 12.5 }}>
            {complete ? (preview ? `${preview.count} conversation${preview.count === 1 ? "" : "s"} match right now` : "Counting…") : "Add a condition to preview matches"}
          </b>
          {preview?.sample.map((s) => (
            <div key={s.id} style={{ display: "flex", gap: 6, alignItems: "baseline", minWidth: 0 }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{s.subject ?? "(no subject)"}</span>
              <span style={{ fontSize: 11.5, color: "var(--h10-text-3)", flexShrink: 0 }}>
                {s.party?.name ?? s.messages[0]?.fromAddress ?? ""} · {ago(s.lastMessageAt)}
              </span>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Button variant="primary" onClick={() => void save()} disabled={busy || !name.trim() || !complete}>
            {busy ? "Saving…" : initial?.id ? "Save view" : "Create view"}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
          {initial?.id && (
            <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
              {confirmDelete && <span style={{ fontSize: 11.5, color: "var(--h10-text-3)" }}>Conversations return to Inbox.</span>}
              <Button onClick={() => (confirmDelete ? void remove() : setConfirmDelete(true))} disabled={busy}>
                {confirmDelete ? "Confirm delete" : "Delete view…"}
              </Button>
            </span>
          )}
        </div>
      </div>
    </Drawer>
  );
}
