"use client";

import { useState, useEffect } from "react";

interface ChannelConnection {
  id: string;
  channelType: string;
  isActive: boolean;
  sellerName?: string;
  storeName?: string;
  storeFrontUrl?: string;
  tokenExpiresAt?: string;
  lastSyncAt?: string;
  lastSyncStatus?: string;
  lastSyncError?: string;
}

interface ChannelCard {
  type: "EBAY" | "AMAZON" | "SHOPIFY" | "WOOCOMMERCE" | "ETSY";
  name: string;
  icon: string;
  description: string;
  color: string;
}

const CHANNELS: ChannelCard[] = [
  {
    type: "EBAY",
    name: "eBay",
    icon: "🏪",
    description: "Connect your eBay seller account",
    color: "from-red-50 to-red-100",
  },
  {
    type: "AMAZON",
    name: "Amazon",
    icon: "📦",
    description: "Connect your Amazon seller account",
    color: "from-orange-50 to-orange-100",
  },
  {
    type: "SHOPIFY",
    name: "Shopify",
    icon: "🛍️",
    description: "Connect your Shopify store",
    color: "from-green-50 to-green-100",
  },
  {
    type: "WOOCOMMERCE",
    name: "WooCommerce",
    icon: "🏬",
    description: "Connect your WooCommerce store",
    color: "from-purple-50 to-purple-100",
  },
  {
    type: "ETSY",
    name: "Etsy",
    icon: "🎨",
    description: "Connect your Etsy shop",
    color: "from-yellow-50 to-yellow-100",
  },
];

export function ChannelsClient() {
  const [connections, setConnections] = useState<Map<string, ChannelConnection>>(
    new Map()
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connectingChannel, setConnectingChannel] = useState<string | null>(null);

  // Load existing connections
  useEffect(() => {
    loadConnections();
  }, []);

  const loadConnections = async () => {
    try {
      setLoading(true);
      setError(null);

      // In a real app, fetch from API
      // For now, initialize empty connections
      const newConnections = new Map<string, ChannelConnection>();
      setConnections(newConnections);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load connections";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleConnectEbay = async () => {
    try {
      setConnectingChannel("EBAY");
      setError(null);

      // Create a new ChannelConnection in the database
      const response = await fetch("/api/ebay/auth/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirectUri: `${window.location.origin}/settings/channels/ebay-callback`,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to initiate eBay connection");
      }

      const data = await response.json();

      if (!data.success || !data.authUrl) {
        throw new Error(data.error || "Failed to generate authorization URL");
      }

      // Store state in sessionStorage for validation on callback
      sessionStorage.setItem("ebayAuthState", data.state);

      // Redirect to eBay authorization
      window.location.href = data.authUrl;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Connection failed";
      setError(message);
      setConnectingChannel(null);
    }
  };

  const handleRevokeConnection = async (connectionId: string) => {
    if (!confirm("Are you sure you want to disconnect this channel?")) {
      return;
    }

    try {
      const response = await fetch("/api/ebay/auth/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId }),
      });

      if (!response.ok) {
        throw new Error("Failed to revoke connection");
      }

      // Remove from local state
      const newConnections = new Map(connections);
      newConnections.delete(connectionId);
      setConnections(newConnections);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Revocation failed";
      setError(message);
    }
  };

  const handleTestConnection = async (connectionId: string) => {
    try {
      const response = await fetch(`/api/ebay/auth/test?connectionId=${connectionId}`);

      if (!response.ok) {
        throw new Error("Connection test failed");
      }

      const data = await response.json();
      alert(`✓ Connection successful!\n\nSeller: ${data.seller.signInName}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Test failed";
      alert(`✗ Connection test failed: ${message}`);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-gray-500">Loading channels...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Error Alert */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {/* Channels Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {CHANNELS.map((channel) => {
          const connection = connections.get(channel.type);
          const isConnected = connection?.isActive;

          return (
            <div
              key={channel.type}
              className={`bg-gradient-to-br ${channel.color} border border-gray-200 rounded-lg p-6 transition-all hover:shadow-md`}
            >
              {/* Header */}
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-3">
                  <span className="text-3xl">{channel.icon}</span>
                  <div>
                    <h3 className="font-semibold text-gray-900">{channel.name}</h3>
                    <p className="text-xs text-gray-600">{channel.description}</p>
                  </div>
                </div>
                {isConnected && (
                  <span className="inline-flex items-center gap-1 px-2 py-1 bg-green-100 text-green-700 text-xs font-medium rounded-full">
                    <span className="w-2 h-2 bg-green-600 rounded-full"></span>
                    Connected
                  </span>
                )}
              </div>

              {/* Connection Details */}
              {isConnected && connection ? (
                <div className="space-y-3 mb-4">
                  {connection.sellerName && (
                    <div className="text-sm">
                      <span className="text-gray-600">Seller:</span>
                      <span className="ml-2 font-medium text-gray-900">
                        {connection.sellerName}
                      </span>
                    </div>
                  )}
                  {connection.storeName && (
                    <div className="text-sm">
                      <span className="text-gray-600">Store:</span>
                      <span className="ml-2 font-medium text-gray-900">
                        {connection.storeName}
                      </span>
                    </div>
                  )}
                  {connection.tokenExpiresAt && (
                    <div className="text-sm">
                      <span className="text-gray-600">Token expires:</span>
                      <span className="ml-2 font-medium text-gray-900">
                        {new Date(connection.tokenExpiresAt).toLocaleDateString()}
                      </span>
                    </div>
                  )}
                  {connection.lastSyncAt && (
                    <div className="text-sm">
                      <span className="text-gray-600">Last sync:</span>
                      <span className="ml-2 font-medium text-gray-900">
                        {new Date(connection.lastSyncAt).toLocaleDateString()}
                      </span>
                    </div>
                  )}
                </div>
              ) : null}

              {/* Actions */}
              <div className="flex gap-2">
                {isConnected ? (
                  <>
                    <button
                      onClick={() => handleTestConnection(connection!.id)}
                      className="flex-1 px-3 py-2 bg-blue-100 text-blue-700 text-sm font-medium rounded hover:bg-blue-200 transition-colors"
                    >
                      Test
                    </button>
                    <button
                      onClick={() => handleRevokeConnection(connection!.id)}
                      className="flex-1 px-3 py-2 bg-red-100 text-red-700 text-sm font-medium rounded hover:bg-red-200 transition-colors"
                    >
                      Disconnect
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => {
                      if (channel.type === "EBAY") {
                        handleConnectEbay();
                      } else {
                        setError(`${channel.name} integration coming soon`);
                      }
                    }}
                    disabled={connectingChannel === channel.type}
                    className="w-full px-4 py-2 bg-gray-900 text-white text-sm font-medium rounded hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {connectingChannel === channel.type ? "Connecting..." : "Connect"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Info Box */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h4 className="font-semibold text-blue-900 mb-2">About Marketplace Connections</h4>
        <ul className="text-sm text-blue-800 space-y-1">
          <li>• Connect your marketplace accounts to sync products and orders</li>
          <li>• Each connection requires authorization from the marketplace</li>
          <li>• Tokens are securely stored and automatically refreshed</li>
          <li>• You can disconnect at any time</li>
        </ul>
      </div>
    </div>
  );
}
