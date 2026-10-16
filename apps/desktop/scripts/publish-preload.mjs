import { renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// tsc always emits preload as .js; the sandboxed preload loader requires
// CommonJS, so the bundle is published as dist/preload.cjs.
const dir = dirname(fileURLToPath(import.meta.url));
const appDir = join(dir, "..");
renameSync(join(appDir, "dist-preload", "preload.js"), join(appDir, "dist", "preload.cjs"));
rmSync(join(appDir, "dist-preload"), { recursive: true, force: true });
console.log("preload published to dist/preload.cjs");
