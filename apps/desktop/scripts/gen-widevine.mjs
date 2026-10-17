// Copies Widevine CDM into dist/ so DRM content (Netflix, HBO, Disney+)
// works in the packaged app. Reads the CDM from Chrome's installation.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CHROME_PATHS = [
  "C:\\Program Files\\Google\\Chrome\\Application",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application",
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application`,
];

const EDGE_PATHS = [
  "C:\\Program Files\\Microsoft\\Edge\\Application",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application",
];

function findWidevine() {
  for (const base of [...CHROME_PATHS, ...EDGE_PATHS]) {
    if (!existsSync(base)) continue;
    try {
      const versions = readdirSync(base).filter((d) => /^\d+\./.test(d));
      versions.sort().reverse();
      for (const ver of versions) {
        const wvDir = join(base, ver, "WidevineCdm");
        const dll = join(wvDir, "_platform_specific", "win_x64", "widevinecdm.dll");
        if (existsSync(dll)) return wvDir;
      }
    } catch {
      /* skip */
    }
  }
  return null;
}

const dist = join(import.meta.dirname, "..", "dist");
const dest = join(dist, "WidevineCdm");

const src = findWidevine();
if (!src) {
  console.warn("[gen-widevine] Widevine CDM not found - DRM content will not play");
  process.exit(0);
}

console.log(`[gen-widevine] Found Widevine at ${src}`);
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
const manifest = JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8"));
console.log(`[gen-widevine] Copied Widevine CDM v${manifest.version} to dist/WidevineCdm`);
