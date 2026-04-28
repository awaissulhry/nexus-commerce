"use client";

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  TrendingUp,
  Package,
  DollarSign,
  FileText,
  Image,
  Zap,
} from "lucide-react";

interface ChannelReadiness {
  channel: "amazon" | "ebay" | "shopify" | "etsy" | "woocommerce";
  name: string;
  readinessScore: number;
  status: "ready" | "warning" | "critical";
  validationResults: {
    title: boolean;
    description: boolean;
    price: boolean;
    inventory: boolean;
    images: boolean;
    attributes: boolean;
  };
  missingFields: string[];
  lastValidated: Date | null;
}

interface ListingHealthProps {
  productId: string;
  onRefresh?: () => void;
}

const CHANNEL_ICONS: Record<string, React.ReactNode> = {
  amazon: "🔶",
  ebay: "🔴",
  shopify: "🟢",
  etsy: "🟡",
  woocommerce: "🟣",
};

const _FIELD_ICONS: Record<string, React.ReactNode> = {
  title: <FileText className="w-4 h-4" />,
  description: <FileText className="w-4 h-4" />,
  price: <DollarSign className="w-4 h-4" />,
  inventory: <Package className="w-4 h-4" />,
  images: <Image className="w-4 h-4" />,
  attributes: <Zap className="w-4 h-4" />,
};

export default function ListingHealth({
  productId,
  onRefresh,
}: ListingHealthProps) {
  const [channels, setChannels] = useState<ChannelReadiness[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedChannel, setExpandedChannel] = useState<string | null>(null);

  useEffect(() => {
    fetchListingHealth();
  }, [productId]);

  const fetchListingHealth = async () => {
    try {
      setLoading(true);
      setError(null);

      const response = await fetch(
        `/api/catalog/${productId}/listing-health`
      );
      if (!response.ok) throw new Error("Failed to fetch listing health");

      const data = await response.json();
      setChannels(data.data.channels || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      console.error("Error fetching listing health:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async () => {
    await fetchListingHealth();
    onRefresh?.();
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "ready":
        return <CheckCircle2 className="w-5 h-5 text-green-500" />;
      case "warning":
        return <AlertTriangle className="w-5 h-5 text-yellow-500" />;
      case "critical":
        return <AlertCircle className="w-5 h-5 text-red-500" />;
      default:
        return null;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "ready":
        return "bg-green-50 border-green-200";
      case "warning":
        return "bg-yellow-50 border-yellow-200";
      case "critical":
        return "bg-red-50 border-red-200";
      default:
        return "bg-slate-50 border-slate-200";
    }
  };

  const getScoreColor = (score: number) => {
    if (score >= 80) return "text-green-600";
    if (score >= 60) return "text-yellow-600";
    return "text-red-600";
  };

  const _getScoreBgColor = (score: number) => {
    if (score >= 80) return "bg-green-100";
    if (score >= 60) return "bg-yellow-100";
    return "bg-red-100";
  };

  if (loading) {
    return (
      <div className="bg-white rounded-lg border border-slate-200 p-6">
        <div className="flex items-center justify-center h-32">
          <Zap className="w-6 h-6 animate-spin text-blue-500" />
          <span className="ml-2 text-slate-600">
            Analyzing listing readiness...
          </span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white rounded-lg border border-red-200 p-6">
        <div className="flex items-center gap-3 text-red-700">
          <AlertCircle className="w-5 h-5" />
          <span>{error}</span>
        </div>
      </div>
    );
  }

  const overallScore =
    channels.length > 0
      ? Math.round(
          channels.reduce((sum, c) => sum + c.readinessScore, 0) /
            channels.length
        )
      : 0;

  return (
    <div className="space-y-4">
      {/* Overall Health Summary */}
      <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg border border-blue-200 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">
              Listing Health Score
            </h3>
            <p className="text-sm text-slate-600 mt-1">
              Multi-channel readiness assessment
            </p>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <div
                className={`text-4xl font-bold ${getScoreColor(overallScore)}`}
              >
                {overallScore}%
              </div>
              <p className="text-xs text-slate-600 mt-1">
                {channels.length} channels
              </p>
            </div>
            <button
              onClick={handleRefresh}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
            >
              Refresh
            </button>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="mt-4 w-full bg-slate-200 rounded-full h-2">
          <div
            className={`h-2 rounded-full transition-all duration-300 ${
              overallScore >= 80
                ? "bg-green-500"
                : overallScore >= 60
                  ? "bg-yellow-500"
                  : "bg-red-500"
            }`}
            style={{ width: `${overallScore}%` }}
          />
        </div>
      </div>

      {/* Channel Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {channels.map((channel) => (
          <div
            key={channel.channel}
            className={`rounded-lg border p-4 cursor-pointer transition-all hover:shadow-md ${getStatusColor(channel.status)}`}
            onClick={() =>
              setExpandedChannel(
                expandedChannel === channel.channel ? null : channel.channel
              )
            }
          >
            {/* Channel Header */}
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="text-2xl">{CHANNEL_ICONS[channel.channel]}</span>
                <div>
                  <h4 className="font-semibold text-slate-900">
                    {channel.name}
                  </h4>
                  <p className="text-xs text-slate-600">
                    {channel.lastValidated
                      ? `Updated ${new Date(channel.lastValidated).toLocaleDateString()}`
                      : "Not validated"}
                  </p>
                </div>
              </div>
              {getStatusIcon(channel.status)}
            </div>

            {/* Readiness Score */}
            <div className="mb-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium text-slate-700">
                  Readiness
                </span>
                <span
                  className={`text-sm font-bold ${getScoreColor(channel.readinessScore)}`}
                >
                  {channel.readinessScore}%
                </span>
              </div>
              <div className="w-full bg-slate-300 rounded-full h-1.5">
                <div
                  className={`h-1.5 rounded-full transition-all ${
                    channel.readinessScore >= 80
                      ? "bg-green-500"
                      : channel.readinessScore >= 60
                        ? "bg-yellow-500"
                        : "bg-red-500"
                  }`}
                  style={{ width: `${channel.readinessScore}%` }}
                />
              </div>
            </div>

            {/* Field Validation Summary */}
            <div className="grid grid-cols-3 gap-2 mb-3">
              {Object.entries(channel.validationResults).map(
                ([field, isValid]) => (
                  <div
                    key={field}
                    className={`flex items-center justify-center p-2 rounded text-xs font-medium ${
                      isValid
                        ? "bg-green-100 text-green-700"
                        : "bg-red-100 text-red-700"
                    }`}
                    title={field}
                  >
                    {isValid ? (
                      <CheckCircle2 className="w-4 h-4" />
                    ) : (
                      <AlertCircle className="w-4 h-4" />
                    )}
                  </div>
                )
              )}
            </div>

            {/* Expandable Details */}
            {expandedChannel === channel.channel && (
              <div className="mt-4 pt-4 border-t border-slate-300 space-y-2">
                <h5 className="text-sm font-semibold text-slate-900">
                  Missing Fields:
                </h5>
                {channel.missingFields.length > 0 ? (
                  <ul className="space-y-1">
                    {channel.missingFields.map((field) => (
                      <li
                        key={field}
                        className="text-sm text-slate-700 flex items-center gap-2"
                      >
                        <span className="text-red-500">•</span>
                        {field}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-green-700">
                    ✓ All required fields complete
                  </p>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Empty State */}
      {channels.length === 0 && (
        <div className="bg-slate-50 rounded-lg border border-slate-200 p-8 text-center">
          <TrendingUp className="w-12 h-12 text-slate-400 mx-auto mb-3" />
          <p className="text-slate-600">
            No channel data available. Connect marketplaces to see readiness
            scores.
          </p>
        </div>
      )}
    </div>
  );
}
