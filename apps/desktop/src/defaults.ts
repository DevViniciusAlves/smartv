// Build-time baked-in defaults for ZERO-CONFIG installs.
//
// Committed EMPTY on purpose (safe: no secrets in the repo). The release
// workflow overwrites this file from CI secrets before building
// (scripts/gen-defaults.mjs), so a released .exe already knows the server and
// its own agent token — the user only ever types the pairing code on the
// phone. A plain local build keeps the empties, which changes nothing.
//
// NOTE: values compiled here end up inside the public binary. The server URL
// is not secret; the AGENT_TOKEN becomes extractable from the .exe. That is
// the accepted trade-off for a hands-free install.
export const DEFAULT_BACKEND_URL = "";
export const DEFAULT_AGENT_TOKEN = "";
