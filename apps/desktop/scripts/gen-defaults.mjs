// Generates src/defaults.ts from build-time env so a released install connects
// with zero configuration (see src/defaults.ts for the rationale).
//
// CI (release job) sets SMARTV_BACKEND_URL + SMARTV_AGENT_TOKEN; a plain local
// build with no env rewrites the committed empty defaults, changing nothing.
// The token is never printed (CI masks it and so does this script).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, "..", "src", "defaults.ts");

const url = (process.env.SMARTV_BACKEND_URL ?? process.env.BACKEND_URL ?? "").trim();
const token = (process.env.SMARTV_AGENT_TOKEN ?? process.env.AGENT_TOKEN ?? "").trim();

const content = `// Build-time baked-in defaults for ZERO-CONFIG installs.
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
export const DEFAULT_BACKEND_URL = ${JSON.stringify(url)};
export const DEFAULT_AGENT_TOKEN = ${JSON.stringify(token)};
`;

fs.writeFileSync(target, content, "utf8");
console.log(
  `[gen-defaults] src/defaults.ts (url ${url ? "set" : "empty"}, token ${token ? "set" : "empty"})`,
);
