import { renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// tsc always emits preloads as .js; the sandboxed preload loader requires
// CommonJS, so each bundle is published as dist/<name>.cjs.
const dir = dirname(fileURLToPath(import.meta.url));
const appDir = join(dir, "..");
const preloadDir = join(appDir, "dist-preload");
for (const name of ["preload", "service-preload"]) {
  renameSync(join(preloadDir, `${name}.js`), join(appDir, "dist", `${name}.cjs`));
}
rmSync(preloadDir, { recursive: true, force: true });
console.log("preloads published to dist/preload.cjs and dist/service-preload.cjs");
