"use client";

import { useEffect, useState } from "react";
import {
  Activity,
  CheckCircle2,
  AlertCircle,
  Clock,
  Zap,
  TrendingUp,
  ChevronDown,
} from "lucide-react";

interface Job {
  id: string;
  name: string;
  status: "waiting" | "active" | "completed" | "failed" | "delayed";
  progress?: number;
  attempts?: number;
  maxAttempts?: number;
  failedReason?: string;
  timestamp: Date;
  duration?: number;
  queue: string;
}

interface QueueStats {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  isPaused: boolean;
  timestamp: string;
}

interface JobMonitorProps {
  autoRefresh?: boolean;
  refreshInterval?: number;
  maxJobs?: number;
}

const STATUS_COLORS: Record<string, string> = {
  waiting: "bg-blue-100 text-blue-700 border-blue-300",
  active: "bg-yellow-100 text-yellow-700 border-yellow-300",
  completed: "bg-green-100 text-green-700 border-green-300",
  failed: "bg-red-100 text-red-700 border-red-300",
  delayed: "bg-purple-100 text-purple-700 border-purple-300",
};

const STATUS_ICONS: Record<string, React.ReactNode> = {
  waiting: <Clock className="w-4 h-4" />,
  active: <Activity className="w-4 h-4 animate-spin" />,
  completed: <CheckCircle2 className="w-4 h-4" />,
  failed: <AlertCircle className="w-4 h-4" />,
  delayed: <Zap className="w-4 h-4" />,
};

export default function JobMonitor({
  autoRefresh = true,
  refreshInterval = 5000,
  maxJobs = 20,
}: JobMonitorProps) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [stats, setStats] = useState<QueueStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  const [filter, setFilter] = useState<Job["status"] | "all">("all");

  useEffect(() => {
    fetchJobData();

    if (autoRefresh) {
      const interval = setInterval(fetchJobData, refreshInterval);
      return () => clearInterval(interval);
    }
  }, [autoRefresh, refreshInterval]);

  const fetchJobData = async () => {
    try {
      setError(null);

      // Fetch queue stats
      const statsRes = await fetch("/api/monitoring/queue-stats");
      if (statsRes.ok) {
        const statsData = await statsRes.json();
        setStats(statsData.data);
      }

      // Fetch recent jobs
      const jobsRes = await fetch(
        `/api/monitoring/jobs?limit=${maxJobs}&status=${filter === "all" ? "" : filter}`
      );
      if (jobsRes.ok) {
        const jobsData = await jobsRes.json();
        setJobs(jobsData.data.jobs || []);
      }

      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch job data");
      console.error("Error fetching job data:", err);
      setLoading(false);
    }
  };

  const handleRetryJob = async (jobId: string) => {
    try {
      const response = await fetch(`/api/monitoring/jobs/${jobId}/retry`, {
        method: "POST",
      });

      if (response.ok) {
        await fetchJobData();
      }
    } catch (err) {
      console.error("Error retrying job:", err);
    }
  };

  const handleCancelJob = async (jobId: string) => {
    try {
      const response = await fetch(`/api/monitoring/jobs/${jobId}/cancel`, {
        method: "POST",
      });

      if (response.ok) {
        await fetchJobData();
      }
    } catch (err) {
      console.error("Error canceling job:", err);
    }
  };

  const filteredJobs =
    filter === "all" ? jobs : jobs.filter((job) => job.status === filter);

  const getStatusLabel = (status: Job["status"]) => {
    return status.charAt(0).toUpperCase() + status.slice(1);
  };

  const formatDuration = (ms?: number) => {
    if (!ms) return "—";
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  if (loading && jobs.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-slate-200 p-6">
        <div className="flex items-center justify-center h-32">
          <Activity className="w-6 h-6 animate-spin text-blue-500" />
          <span className="ml-2 text-slate-600">Loading job monitor...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header with Stats */}
      <div className="bg-gradient-to-r from-slate-50 to-blue-50 rounded-lg border border-slate-200 p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">
              Job Activity Monitor
            </h3>
            <p className="text-sm text-slate-600 mt-1">
              Real-time BullMQ queue monitoring
            </p>
          </div>
          <button
            onClick={fetchJobData}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
          >
            <Activity className="w-4 h-4" />
            Refresh
          </button>
        </div>

        {/* Queue Stats Grid */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div className="bg-white rounded p-3 border border-slate-200">
              <p className="text-xs text-slate-600 uppercase tracking-wide font-medium">
                Waiting
              </p>
              <p className="text-2xl font-bold text-blue-600 mt-1">
                {stats.waiting}
              </p>
            </div>
            <div className="bg-white rounded p-3 border border-slate-200">
              <p className="text-xs text-slate-600 uppercase tracking-wide font-medium">
                Active
              </p>
              <p className="text-2xl font-bold text-yellow-600 mt-1">
                {stats.active}
              </p>
            </div>
            <div className="bg-white rounded p-3 border border-slate-200">
              <p className="text-xs text-slate-600 uppercase tracking-wide font-medium">
                Completed
              </p>
              <p className="text-2xl font-bold text-green-600 mt-1">
                {stats.completed}
              </p>
            </div>
            <div className="bg-white rounded p-3 border border-slate-200">
              <p className="text-xs text-slate-600 uppercase tracking-wide font-medium">
                Failed
              </p>
              <p className="text-2xl font-bold text-red-600 mt-1">
                {stats.failed}
              </p>
            </div>
            <div className="bg-white rounded p-3 border border-slate-200">
              <p className="text-xs text-slate-600 uppercase tracking-wide font-medium">
                Delayed
              </p>
              <p className="text-2xl font-bold text-purple-600 mt-1">
                {stats.delayed}
              </p>
            </div>
          </div>
        )}

        {stats?.isPaused && (
          <div className="mt-3 p-3 bg-yellow-50 border border-yellow-200 rounded text-sm text-yellow-700 flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            Queue is paused
          </div>
        )}
      </div>

      {/* Filter Tabs */}
      <div className="flex gap-2 border-b border-slate-200">
        {(["all", "waiting", "active", "completed", "failed", "delayed"] as const).map(
          (status) => (
            <button
              key={status}
              onClick={() => setFilter(status)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                filter === status
                  ? "border-blue-600 text-blue-600"
                  : "border-transparent text-slate-600 hover:text-slate-900"
              }`}
            >
              {status === "all" ? "All Jobs" : getStatusLabel(status)}
            </button>
          )
        )}
      </div>

      {/* Error Alert */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center gap-3 text-red-700">
          <AlertCircle className="w-5 h-5 flex-shrink-0" />
          <span className="text-sm">{error}</span>
        </div>
      )}

      {/* Jobs List */}
      <div className="space-y-2">
        {filteredJobs.length > 0 ? (
          filteredJobs.map((job) => (
            <div
              key={job.id}
              className={`rounded-lg border p-4 transition-all ${STATUS_COLORS[job.status]}`}
            >
              {/* Job Header */}
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-3 flex-1">
                  <div className="mt-1">{STATUS_ICONS[job.status]}</div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h4 className="font-semibold text-sm">{job.name}</h4>
                      <span className="text-xs px-2 py-1 bg-white bg-opacity-50 rounded">
                        {job.queue}
                      </span>
                    </div>
                    <p className="text-xs opacity-75 mt-1">
                      {new Date(job.timestamp).toLocaleString()}
                    </p>
                  </div>
                </div>

                {/* Action Buttons */}
                <div className="flex items-center gap-2">
                  {job.status === "failed" && (
                    <button
                      onClick={() => handleRetryJob(job.id)}
                      className="px-3 py-1 text-xs bg-white bg-opacity-50 hover:bg-opacity-75 rounded transition-colors"
                      title="Retry job"
                    >
                      Retry
                    </button>
                  )}
                  {job.status === "active" && (
                    <button
                      onClick={() => handleCancelJob(job.id)}
                      className="px-3 py-1 text-xs bg-white bg-opacity-50 hover:bg-opacity-75 rounded transition-colors"
                      title="Cancel job"
                    >
                      Cancel
                    </button>
                  )}
                  <button
                    onClick={() =>
                      setExpandedJob(expandedJob === job.id ? null : job.id)
                    }
                    className="p-1 hover:bg-white hover:bg-opacity-30 rounded transition-colors"
                  >
                    <ChevronDown
                      className={`w-4 h-4 transition-transform ${
                        expandedJob === job.id ? "rotate-180" : ""
                      }`}
                    />
                  </button>
                </div>
              </div>

              {/* Progress Bar (for active jobs) */}
              {job.status === "active" && job.progress !== undefined && (
                <div className="mt-3 w-full bg-white bg-opacity-30 rounded-full h-2">
                  <div
                    className="h-2 rounded-full bg-white transition-all duration-300"
                    style={{ width: `${job.progress}%` }}
                  />
                </div>
              )}

              {/* Expanded Details */}
              {expandedJob === job.id && (
                <div className="mt-4 pt-4 border-t border-current border-opacity-20 space-y-2 text-sm">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <p className="text-xs opacity-75 uppercase tracking-wide">
                        Job ID
                      </p>
                      <p className="font-mono text-xs mt-1 break-all">{job.id}</p>
                    </div>
                    <div>
                      <p className="text-xs opacity-75 uppercase tracking-wide">
                        Duration
                      </p>
                      <p className="mt-1">{formatDuration(job.duration)}</p>
                    </div>
                    {job.attempts !== undefined && (
                      <div>
                        <p className="text-xs opacity-75 uppercase tracking-wide">
                          Attempts
                        </p>
                        <p className="mt-1">
                          {job.attempts} / {job.maxAttempts || 3}
                        </p>
                      </div>
                    )}
                    {job.progress !== undefined && (
                      <div>
                        <p className="text-xs opacity-75 uppercase tracking-wide">
                          Progress
                        </p>
                        <p className="mt-1">{job.progress}%</p>
                      </div>
                    )}
                  </div>

                  {job.failedReason && (
                    <div className="mt-3 p-3 bg-white bg-opacity-30 rounded text-xs">
                      <p className="font-semibold mb-1">Error:</p>
                      <p className="font-mono break-all">{job.failedReason}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        ) : (
          <div className="bg-slate-50 rounded-lg border border-slate-200 p-8 text-center">
            <TrendingUp className="w-12 h-12 text-slate-400 mx-auto mb-3" />
            <p className="text-slate-600">
              {filter === "all"
                ? "No jobs in queue"
                : `No ${filter} jobs`}
            </p>
          </div>
        )}
      </div>

      {/* Auto-refresh indicator */}
      {autoRefresh && (
        <div className="text-xs text-slate-500 text-center">
          Auto-refreshing every {refreshInterval / 1000}s
        </div>
      )}
    </div>
  );
}
