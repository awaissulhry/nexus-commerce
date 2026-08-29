/**
 * Logger Utility
 * Provides structured logging for the API
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * CX.0 (S20) — credential redaction. Any context value whose KEY looks like
 * token/secret material is replaced before serialisation, at any depth, so a
 * careless `logger.info('…', { connection })` can never print a refresh token.
 */
const SENSITIVE_KEY = /token|secret|password|authorization|code_verifier|api[_-]?key|credential/i;
// Metadata ABOUT a credential is safe and useful (tokenExpiresAt, hasRefreshToken…).
const SAFE_SUFFIX = /(At|Expiry|Expires|Length|Len|Count|Prefix|Ok|Status|Type|Url|Endpoint|Present|Configured)$/;
const MAX_DEPTH = 6;

function isSensitiveKey(key: string, value: unknown): boolean {
  if (!SENSITIVE_KEY.test(key) || SAFE_SUFFIX.test(key)) return false;
  return typeof value === 'string' || (typeof value === 'object' && value !== null);
}

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(k, v)) {
      out[k] = '[redacted]';
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: Record<string, any>;
}

class Logger {
  private isDevelopment = process.env.NODE_ENV !== 'production';

  private formatLog(level: LogLevel, message: string, context?: Record<string, any>): LogEntry {
    return {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: context === undefined ? undefined : (redact(context) as Record<string, any>)
    };
  }

  private output(entry: LogEntry): void {
    const logString = JSON.stringify(entry);

    switch (entry.level) {
      case 'debug':
        if (this.isDevelopment) {
          console.debug(logString);
        }
        break;
      case 'info':
        console.info(logString);
        break;
      case 'warn':
        console.warn(logString);
        break;
      case 'error':
        console.error(logString);
        break;
    }
  }

  debug(message: string, context?: Record<string, any>): void {
    const entry = this.formatLog('debug', message, context);
    this.output(entry);
  }

  info(message: string, context?: Record<string, any>): void {
    const entry = this.formatLog('info', message, context);
    this.output(entry);
  }

  warn(message: string, context?: Record<string, any>): void {
    const entry = this.formatLog('warn', message, context);
    this.output(entry);
  }

  error(message: string, context?: Record<string, any>): void {
    const entry = this.formatLog('error', message, context);
    this.output(entry);
  }
}

export const logger = new Logger();
