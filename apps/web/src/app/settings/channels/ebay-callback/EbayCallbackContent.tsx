"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getBackendUrl } from "@/lib/backend-url";

export default function EbayCallbackContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [message, setMessage] = useState("Processing eBay authorization...");

  useEffect(() => {
    const processCallback = async () => {
      try {
        const code = searchParams.get("code");
        const state = searchParams.get("state");
        const error = searchParams.get("error");
        const errorDescription = searchParams.get("error_description");

        // Check for OAuth errors
        if (error) {
          setStatus("error");
          setMessage(`eBay authorization failed: ${errorDescription || error}`);
          return;
        }

        if (!code || !state) {
          setStatus("error");
          setMessage("Missing authorization code or state parameter");
          return;
        }

        // Verify state token
        const storedState = sessionStorage.getItem("ebayAuthState");
        if (storedState !== state) {
          setStatus("error");
          setMessage("State token mismatch - possible CSRF attack");
          return;
        }

        // Create ChannelConnection in database first
        const createResponse = await fetch(`${getBackendUrl()}/api/ebay/auth/create-connection`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channelType: "EBAY",
          }),
        });

        if (!createResponse.ok) {
          throw new Error("Failed to create channel connection");
        }

        const { connectionId } = await createResponse.json();

        // Exchange code for tokens
        const callbackResponse = await fetch(`${getBackendUrl()}/api/ebay/auth/callback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code,
            state,
            connectionId,
            redirectUri: window.location.origin + "/settings/channels/ebay-callback",
          }),
        });

        if (!callbackResponse.ok) {
          const error = await callbackResponse.json();
          throw new Error(error.error || "Failed to exchange authorization code");
        }

        const result = await callbackResponse.json();

        // Clear stored state
        sessionStorage.removeItem("ebayAuthState");

        setStatus("success");
        setMessage(
          `✓ eBay connection successful!\n\nSeller: ${result.connection.sellerName || "Unknown"}`
        );

        // Redirect after 2 seconds
        setTimeout(() => {
          router.push("/settings/channels");
        }, 2000);
      } catch (err) {
        setStatus("error");
        setMessage(
          `Error: ${err instanceof Error ? err.message : "Unknown error occurred"}`
        );
      }
    };

    processCallback();
  }, [searchParams, router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="bg-white rounded-lg shadow-lg p-8 max-w-md w-full">
        {status === "loading" && (
          <div className="text-center">
            <div className="inline-flex items-center justify-center w-12 h-12 bg-blue-100 rounded-full mb-4">
              <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
            </div>
            <h2 className="text-lg font-semibold text-gray-900 mb-2">
              Connecting to eBay
            </h2>
            <p className="text-sm text-gray-600">{message}</p>
          </div>
        )}

        {status === "success" && (
          <div className="text-center">
            <div className="inline-flex items-center justify-center w-12 h-12 bg-green-100 rounded-full mb-4">
              <svg
                className="w-6 h-6 text-green-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-gray-900 mb-2">Success!</h2>
            <p className="text-sm text-gray-600 whitespace-pre-line">{message}</p>
            <p className="text-xs text-gray-500 mt-4">Redirecting...</p>
          </div>
        )}

        {status === "error" && (
          <div className="text-center">
            <div className="inline-flex items-center justify-center w-12 h-12 bg-red-100 rounded-full mb-4">
              <svg
                className="w-6 h-6 text-red-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-gray-900 mb-2">Connection Failed</h2>
            <p className="text-sm text-gray-600 mb-4">{message}</p>
            <button
              onClick={() => router.push("/settings/channels")}
              className="w-full px-4 py-2 bg-gray-900 text-white text-sm font-medium rounded hover:bg-gray-800 transition-colors"
            >
              Back to Channels
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
