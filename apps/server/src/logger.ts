// Structured one-line logs: `ISO-time LEVEL event key=value ...`.
// Never pass tokens or typed text to this logger; call sites only log
// event names, roles, origins and close codes.
export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export type LogSink = (line: string) => void;

export interface Logger {
  debug(event: string, fields?: Record<string, string | number | boolean>): void;
  info(event: string, fields?: Record<string, string | number | boolean>): void;
  warn(event: string, fields?: Record<string, string | number | boolean>): void;
  error(event: string, fields?: Record<string, string | number | boolean>): void;
}

export function levelFromEnv(raw: string | undefined): LogLevel {
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  return "info";
}

export function createLogger(level: LogLevel, sink: LogSink = (line) => console.log(line)): Logger {
  const emit = (lv: LogLevel, event: string, fields?: Record<string, string | number | boolean>): void => {
    if (ORDER[lv] < ORDER[level]) return;
    const kv = Object.entries(fields ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    sink(`${new Date().toISOString()} ${lv.toUpperCase()} ${event}${kv ? ` ${kv}` : ""}`);
  };
  return {
    debug: (e, f) => emit("debug", e, f),
    info: (e, f) => emit("info", e, f),
    warn: (e, f) => emit("warn", e, f),
    error: (e, f) => emit("error", e, f),
  };
}
