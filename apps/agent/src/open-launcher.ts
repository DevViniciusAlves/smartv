import "dotenv/config";
import { loadConfig } from "./config.js";
import { createAutomation } from "./automation.js";
import { TvBrowser } from "./browser.js";

// Helper used by start-tv.ps1: ensures the single TV window exists and
// navigates it to the launcher, reusing the agent's own logic.
async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.launcherUrl) throw new Error("LAUNCHER_URL not set");
  const { auto } = await createAutomation();
  const tv = new TvBrowser(config, auto, (m) => console.log(m));
  await tv.ensureRunning();
  const ok = await tv.navigate(config.launcherUrl);
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
