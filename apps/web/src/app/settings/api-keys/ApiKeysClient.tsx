"use client";

import { useState, useTransition } from "react";
import { useConfirm } from "@/components/ui/ConfirmProvider";
import { generateApiKey, revokeApiKey, deleteApiKey } from "./actions";
import type { ApiKeyRow } from "./page";

interface Props {
  apiKeys: ApiKeyRow[];
}

export default function ApiKeysClient({ apiKeys }: Props) {
  const askConfirm = useConfirm();
  const [isPending, startTransition] = useTransition();
  const [newKey, setNewKey] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const handleCreate = (formData: FormData) => {
    setMessage(null);
    setNewKey(null);
    startTransition(async () => {
      try {
        const result = await generateApiKey(formData);
        if (result.success && result.rawKey) {
          setNewKey(result.rawKey);
          setShowCreate(false);
          setMessage({ type: "success", text: "API key created! Copy it now — it won't be shown again." });
        }
      } catch {
        setMessage({ type: "error", text: "Failed to create API key" });
      }
    });
  };

  const handleRevoke = async (id: string) => {
    if (!(await askConfirm({ title: "Revoke this API key?", description: "It will stop working immediately.", confirmLabel: "Revoke", tone: "danger" }))) return;
    startTransition(async () => {
      try {
        await revokeApiKey(id);
        setMessage({ type: "success", text: "API key revoked" });
      } catch {
        setMessage({ type: "error", text: "Failed to revoke key" });
      }
    });
  };

  const handleDelete = async (id: string) => {
    if (!(await askConfirm({ title: "Permanently delete this API key?", description: "This cannot be undone.", confirmLabel: "Delete", tone: "danger" }))) return;
    startTransition(async () => {
      try {
        await deleteApiKey(id);
        setMessage({ type: "success", text: "API key deleted" });
      } catch {
        setMessage({ type: "error", text: "Failed to delete key" });
      }
    });
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  const activeKeys = apiKeys.filter((k) => !k.revokedAt);
  const revokedKeys = apiKeys.filter((k) => k.revokedAt);

  return (
    <div className="max-w-3xl space-y-6">
      {message && (
        <div
          className={`px-4 py-3 rounded-lg text-sm ${
            message.type === "success"
              ? "bg-green-50 text-green-800 border border-green-200"
              : "bg-red-50 text-red-800 border border-red-200"
          }`}
        >
          {message.type === "success" ? "✅" : "❌"} {message.text}
        </div>
      )}

      {/* New Key Display */}
      {newKey && (
        <div className="bg-yellow-50 border border-yellow-300 rounded-lg p-4">
          <p className="text-sm font-semibold text-yellow-800 mb-2">
            ⚠️ Copy your API key now. It will not be shown again!
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-white px-3 py-2 rounded border border-yellow-200 text-sm font-mono text-gray-900 select-all">
              {newKey}
            </code>
            <button
              onClick={() => copyToClipboard(newKey)}
              className="px-3 py-2 text-sm font-medium bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 transition-colors"
            >
              {copied ? "✓ Copied!" : "📋 Copy"}
            </button>
          </div>
        </div>
      )}

      {/* Create Button / Form */}
      {!showCreate ? (
        <button
          onClick={() => setShowCreate(true)}
          className="px-4 py-2.5 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          + Generate New API Key
        </button>
      ) : (
        <form action={handleCreate} className="bg-white rounded-lg shadow border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Create New API Key</h3>
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label htmlFor="label" className="block text-sm font-medium text-gray-700 mb-1">
                Label
              </label>
              <input
                id="label"
                name="label"
                type="text"
                required
                placeholder="e.g., Production Server, Zapier Integration"
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <button
              type="submit"
              disabled={isPending}
              className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {isPending ? "Creating…" : "Generate"}
            </button>
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Active Keys */}
      <div className="bg-white rounded-lg shadow border border-gray-200 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-200 bg-gray-50">
          <h3 className="text-sm font-semibold text-gray-900">
            Active Keys ({activeKeys.length})
          </h3>
        </div>

        {activeKeys.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-500">
            No active API keys. Generate one to get started.
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {activeKeys.map((key) => (
              <div key={key.id} className="px-5 py-4 flex items-center justify-between hover:bg-gray-50">
                <div>
                  <p className="text-sm font-medium text-gray-900">{key.label}</p>
                  <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                    <code className="bg-gray-100 px-2 py-0.5 rounded font-mono">{key.keyPrefix}</code>
                    <span>Created {formatDate(key.createdAt)}</span>
                    {key.lastUsed && <span>Last used {formatDate(key.lastUsed)}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleRevoke(key.id)}
                    disabled={isPending}
                    className="px-3 py-1.5 text-xs font-medium text-yellow-700 bg-yellow-50 rounded-lg hover:bg-yellow-100 disabled:opacity-50 transition-colors"
                  >
                    Revoke
                  </button>
                  <button
                    onClick={() => handleDelete(key.id)}
                    disabled={isPending}
                    className="px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 rounded-lg hover:bg-red-100 disabled:opacity-50 transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Revoked Keys */}
      {revokedKeys.length > 0 && (
        <div className="bg-white rounded-lg shadow border border-gray-200 overflow-hidden opacity-75">
          <div className="px-5 py-3 border-b border-gray-200 bg-gray-50">
            <h3 className="text-sm font-semibold text-gray-500">
              Revoked Keys ({revokedKeys.length})
            </h3>
          </div>
          <div className="divide-y divide-gray-100">
            {revokedKeys.map((key) => (
              <div key={key.id} className="px-5 py-3 flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500 line-through">{key.label}</p>
                  <div className="flex items-center gap-3 mt-1 text-xs text-gray-400">
                    <code className="bg-gray-100 px-2 py-0.5 rounded font-mono">{key.keyPrefix}</code>
                    <span>Revoked {key.revokedAt ? formatDate(key.revokedAt) : ""}</span>
                  </div>
                </div>
                <button
                  onClick={() => handleDelete(key.id)}
                  disabled={isPending}
                  className="px-3 py-1.5 text-xs font-medium text-red-600 hover:text-red-800 disabled:opacity-50 transition-colors"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Security Note */}
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
        <p className="text-xs text-gray-600">
          🔒 <strong>Security:</strong> API keys are hashed with SHA-256 before storage. The full key
          is only shown once at creation time. Revoked keys are immediately invalidated. Use separate
          keys for different integrations so you can revoke them independently.
        </p>
      </div>
    </div>
  );
}
