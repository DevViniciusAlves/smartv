// Parses the opt-in local CDP flag: --smartv-cdp=<port>.
// Returns null when absent. Throws on invalid values (caller logs and
// continues without CDP). The port only ever binds 127.0.0.1 (see main.ts).
export function parseCdpPort(argv: string[]): number | null {
  const arg = argv.find((a) => a.startsWith("--smartv-cdp="));
  if (!arg) return null;
  const n = Number(arg.slice("--smartv-cdp=".length));
  if (!Number.isInteger(n) || n < 1024 || n > 65535) {
    throw new Error("--smartv-cdp must be an integer between 1024 and 65535");
  }
  return n;
}
