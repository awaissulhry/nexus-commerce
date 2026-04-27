"use client";

import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle, AlertTriangle, Activity } from "lucide-react";

interface HealthStatus {
  status: "healthy" | "degraded" | "critical";
  lastSyncTime: Date | null;
  lastSyncStatus: string | null;
  recentFailureRate: number;
  activeAlerts: number;
  message: string;
}

interface SyncMetrics {
  totalSyncs: number;
  successfulSyncs: number;
  failedSyncs: number;
  averageSuccessRate: number;
  averageDuration: number;
  totalProductsProcessed: number;
  totalProductsFailed: number;
}

export default function SyncHealthDashboard() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [metrics, setMetrics] = useState<SyncMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        setError(null);

        // Fetch health status
        const healthRes = await fetch("/api/monitoring/health");
        if (!healthRes.ok) throw new Error("Failed to fetch health status");
        const healthData = await healthRes.json();
        setHealth(healthData.data);

        // Fetch metrics
        const metricsRes = await fetch("/api/monitoring/metrics");
        if (!metricsRes.ok) throw new Error("Failed to fetch metrics");
        const metricsData = await metricsRes.json();
        setMetrics(metricsData.data.metrics);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 30000); // Refresh every 30 seconds

    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="bg-white rounded-lg border border-slate-200 p-6">
        <div className="flex items-center justify-center h-32">
          <Activity className="w-6 h-6 animate-spin text-blue-500" />
          <span className="ml-2 text-slate-600">Loading health status...</span>
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

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "healthy":
        return <CheckCircle className="w-6 h-6 text-green-500" />;
      case "degraded":
        return <AlertTriangle className="w-6 h-6 text-yellow-500" />;
      case "critical":
        return <AlertCircle className="w-6 h-6 text-red-500" />;
      default:
        return null;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "healthy":
        return "bg-green-50 border-green-200";
      case "degraded":
        return "bg-yellow-50 border-yellow-200";
      case "critical":
        return "bg-red-50 border-red-200";
      default:
        return "bg-slate-50 border-slate-200";
    }
  };

  const getStatusTextColor = (status: string) => {
    switch (status) {
      case "healthy":
        return "text-green-700";
      case "degraded":
        return "text-yellow-700";
      case "critical":
        return "text-red-700";
      default:
        return "text-slate-700";
    }
  };

  return (
    <div className="space-y-6">
      {/* Health Status Card */}
      {health && (
        <div
          className={`rounded-lg border p-6 ${getStatusColor(health.status)}`}
        >
          <div className="flex items-start justify-between">
            <div className="flex items-start gap-4">
              {getStatusIcon(health.status)}
              <div>
                <h3 className={`text-lg font-semibold ${getStatusTextColor(health.status)}`}>
                  {health.status.charAt(0).toUpperCase() + health.status.slice(1)}
                </h3>
                <p className={`text-sm mt-1 ${getStatusTextColor(health.status)}`}>
                  {health.message}
                </p>
              </div>
            </div>
            <div className="text-right text-sm">
              {health.lastSyncTime && (
                <p className="text-slate-600">
                  Last sync:{" "}
                  {new Date(health.lastSyncTime).toLocaleString()}
                </p>
              )}
              {health.lastSyncStatus && (
                <p className="text-slate-600">Status: {health.lastSyncStatus}</p>
              )}
            </div>
          </div>

          {/* Alert Summary */}
          <div className="mt-4 grid grid-cols-3 gap-4">
            <div className="bg-white bg-opacity-50 rounded p-3">
              <p className="text-xs text-slate-600 uppercase tracking-wide">
                Failure Rate
              </p>
              <p className={`text-2xl font-bold mt-1 ${getStatusTextColor(health.status)}`}>
                {health.recentFailureRate.toFixed(1)}%
              </p>
            </div>
            <div className="bg-white bg-opacity-50 rounded p-3">
              <p className="text-xs text-slate-600 uppercase tracking-wide">
                Active Alerts
              </p>
              <p className={`text-2xl font-bold mt-1 ${getStatusTextColor(health.status)}`}>
                {health.activeAlerts}
              </p>
            </div>
            <div className="bg-white bg-opacity-50 rounded p-3">
              <p className="text-xs text-slate-600 uppercase tracking-wide">
                Success Rate
              </p>
              <p className={`text-2xl font-bold mt-1 ${getStatusTextColor(health.status)}`}>
                {(100 - health.recentFailureRate).toFixed(1)}%
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Metrics Cards */}
      {metrics && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white rounded-lg border border-slate-200 p-4">
            <p className="text-sm text-slate-600 uppercase tracking-wide">
              Total Syncs
            </p>
            <p className="text-3xl font-bold text-slate-900 mt-2">
              {metrics.totalSyncs}
            </p>
          </div>

          <div className="bg-white rounded-lg border border-slate-200 p-4">
            <p className="text-sm text-slate-600 uppercase tracking-wide">
              Successful
            </p>
            <p className="text-3xl font-bold text-green-600 mt-2">
              {metrics.successfulSyncs}
            </p>
            <p className="text-xs text-slate-500 mt-1">
              {metrics.totalSyncs > 0
                ? ((metrics.successfulSyncs / metrics.totalSyncs) * 100).toFixed(
                    1
                  )
                : 0}
              %
            </p>
          </div>

          <div className="bg-white rounded-lg border border-slate-200 p-4">
            <p className="text-sm text-slate-600 uppercase tracking-wide">
              Failed
            </p>
            <p className="text-3xl font-bold text-red-600 mt-2">
              {metrics.failedSyncs}
            </p>
            <p className="text-xs text-slate-500 mt-1">
              {metrics.totalSyncs > 0
                ? ((metrics.failedSyncs / metrics.totalSyncs) * 100).toFixed(1)
                : 0}
              %
            </p>
          </div>

          <div className="bg-white rounded-lg border border-slate-200 p-4">
            <p className="text-sm text-slate-600 uppercase tracking-wide">
              Avg Success Rate
            </p>
            <p className="text-3xl font-bold text-blue-600 mt-2">
              {metrics.averageSuccessRate.toFixed(1)}%
            </p>
          </div>

          <div className="bg-white rounded-lg border border-slate-200 p-4">
            <p className="text-sm text-slate-600 uppercase tracking-wide">
              Products Processed
            </p>
            <p className="text-3xl font-bold text-slate-900 mt-2">
              {metrics.totalProductsProcessed}
            </p>
          </div>

          <div className="bg-white rounded-lg border border-slate-200 p-4">
            <p className="text-sm text-slate-600 uppercase tracking-wide">
              Products Failed
            </p>
            <p className="text-3xl font-bold text-red-600 mt-2">
              {metrics.totalProductsFailed}
            </p>
            <p className="text-xs text-slate-500 mt-1">
              {metrics.totalProductsProcessed > 0
                ? (
                    (metrics.totalProductsFailed /
                      metrics.totalProductsProcessed) *
                    100
                  ).toFixed(1)
                : 0}
              %
            </p>
          </div>

          <div className="bg-white rounded-lg border border-slate-200 p-4">
            <p className="text-sm text-slate-600 uppercase tracking-wide">
              Avg Duration
            </p>
            <p className="text-3xl font-bold text-slate-900 mt-2">
              {(metrics.averageDuration / 1000).toFixed(1)}s
            </p>
          </div>

          <div className="bg-white rounded-lg border border-slate-200 p-4">
            <p className="text-sm text-slate-600 uppercase tracking-wide">
              Success Rate
            </p>
            <p className="text-3xl font-bold text-green-600 mt-2">
              {metrics.totalProductsProcessed > 0
                ? (
                    ((metrics.totalProductsProcessed -
                      metrics.totalProductsFailed) /
                      metrics.totalProductsProcessed) *
                    100
                  ).toFixed(1)
                : 0}
              %
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
