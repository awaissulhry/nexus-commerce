"use client";

import { useState, useTransition } from "react";
import { saveNotificationPreferences } from "./actions";
import type { NotificationPref } from "./page";

const EVENT_LABELS: Record<string, { label: string; description: string; icon: string }> = {
  NEW_ORDER: {
    label: "New Order",
    description: "When a new order is placed on any channel",
    icon: "🛒",
  },
  LOW_STOCK: {
    label: "Low Stock Alert",
    description: "When inventory drops below threshold",
    icon: "📦",
  },
  RETURN_REQUEST: {
    label: "Return Request",
    description: "When a customer initiates a return",
    icon: "↩️",
  },
  SYNC_FAILURE: {
    label: "Sync Failure",
    description: "When a marketplace sync job fails",
    icon: "⚠️",
  },
  AI_COMPLETE: {
    label: "AI Generation Complete",
    description: "When AI listing generation finishes",
    icon: "🤖",
  },
};

interface Props {
  preferences: NotificationPref[];
}

export default function NotificationsClient({ preferences }: Props) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [prefs, setPrefs] = useState<NotificationPref[]>(preferences);

  const togglePref = (eventType: string, channel: "email" | "sms" | "inApp") => {
    setPrefs((prev) =>
      prev.map((p) =>
        p.eventType === eventType ? { ...p, [channel]: !p[channel] } : p
      )
    );
  };

  const handleSubmit = (formData: FormData) => {
    setMessage(null);
    startTransition(async () => {
      try {
        const result = await saveNotificationPreferences(formData);
        if (result.success) {
          setMessage({ type: "success", text: "Notification preferences saved!" });
        }
      } catch {
        setMessage({ type: "error", text: "Failed to save preferences" });
      }
    });
  };

  return (
    <form action={handleSubmit} className="max-w-3xl">
      {message && (
        <div
          className={`mb-6 px-4 py-3 rounded-lg text-sm ${
            message.type === "success"
              ? "bg-green-50 text-green-800 border border-green-200"
              : "bg-red-50 text-red-800 border border-red-200"
          }`}
        >
          {message.type === "success" ? "✅" : "❌"} {message.text}
        </div>
      )}

      <div className="bg-white rounded-lg shadow border border-gray-200 overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 bg-gray-50">
          <div className="grid grid-cols-12 gap-4 items-center">
            <div className="col-span-6">
              <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">Event</span>
            </div>
            <div className="col-span-2 text-center">
              <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">📧 Email</span>
            </div>
            <div className="col-span-2 text-center">
              <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">📱 SMS</span>
            </div>
            <div className="col-span-2 text-center">
              <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">🔔 In-App</span>
            </div>
          </div>
        </div>

        {/* Rows */}
        <div className="divide-y divide-gray-100">
          {prefs.map((pref) => {
            const meta = EVENT_LABELS[pref.eventType] || {
              label: pref.eventType,
              description: "",
              icon: "📌",
            };

            return (
              <div key={pref.eventType} className="px-6 py-4 hover:bg-gray-50 transition-colors">
                <div className="grid grid-cols-12 gap-4 items-center">
                  <div className="col-span-6">
                    <div className="flex items-center gap-3">
                      <span className="text-xl">{meta.icon}</span>
                      <div>
                        <p className="text-sm font-medium text-gray-900">{meta.label}</p>
                        <p className="text-xs text-gray-500">{meta.description}</p>
                      </div>
                    </div>
                  </div>

                  {(["email", "sms", "inApp"] as const).map((channel) => (
                    <div key={channel} className="col-span-2 flex justify-center">
                      <input
                        type="hidden"
                        name={`${pref.eventType}_${channel}`}
                        value="off"
                      />
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          name={`${pref.eventType}_${channel}`}
                          checked={pref[channel]}
                          onChange={() => togglePref(pref.eventType, channel)}
                          className="sr-only peer"
                        />
                        <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600" />
                      </label>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Info */}
      <div className="mt-4 bg-blue-50 border border-blue-200 rounded-lg p-4">
        <p className="text-xs text-blue-700">
          💡 <strong>SMS notifications</strong> require a verified phone number. Configure your phone
          number in the Profile settings. Email notifications are sent to your account email.
        </p>
      </div>

      {/* Submit */}
      <div className="flex justify-end mt-6">
        <button
          type="submit"
          disabled={isPending}
          className="px-6 py-2.5 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isPending ? "Saving…" : "Save Preferences"}
        </button>
      </div>
    </form>
  );
}
