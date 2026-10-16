import type { ControllerMessage } from "@smartv/shared";
import { getAppUrl } from "@smartv/shared";
import type { Automation } from "./automation.js";
import type { AgentConfig } from "./config.js";
import type { BrowserNavigator } from "./browser.js";

// Maps validated (whitelisted) messages to real actions. Never executes
// anything outside the whitelist. Errors propagate to the caller (logged in
// index.ts), never swallowed.
export async function handleCommand(
  auto: Automation,
  config: AgentConfig,
  tv: BrowserNavigator,
  msg: ControllerMessage,
): Promise<void> {
  const MOVE_LIMIT = 2000;
  const clamp = (n: number): number => Math.max(-MOVE_LIMIT, Math.min(MOVE_LIMIT, Math.trunc(n)));

  switch (msg.type) {
    case "key": {
      switch (msg.key) {
        case "up": await auto.tap("up"); break;
        case "down": await auto.tap("down"); break;
        case "left": await auto.tap("left"); break;
        case "right": await auto.tap("right"); break;
        case "enter": await auto.tap("enter"); break;
        case "back":
          // Edge: Alt+Left = browser back (configurable to Esc).
          // Electron: no browser chrome, so Esc = the app's own "go Home".
          if (config.tvTarget === "electron") await auto.tap("esc");
          else if (config.backBehavior === "esc") await auto.tap("esc");
          else await auto.combo(["alt"], "left");
          break;
        case "home":
          // Electron: Esc triggers the app's global Home (local Home view).
          if (config.tvTarget === "electron") await auto.tap("esc");
          else if (config.launcherUrl) await tv.navigate(config.launcherUrl);
          break;
      }
      break;
    }
    case "media": {
      switch (msg.action) {
        case "playpause": await auto.tap("space"); break;
        case "seekForward": await auto.tap("right"); break;
        case "seekBackward": await auto.tap("left"); break;
        case "fullscreen": await auto.tap("f"); break;
        case "next": await auto.combo(["shift"], "right"); break;
      }
      break;
    }
    case "volume": {
      if (msg.action === "up") await auto.volumeUp(msg.step ?? 2);
      else if (msg.action === "down") await auto.volumeDown(msg.step ?? 2);
      else await auto.volumeMute();
      break;
    }
    case "app": {
      const url = getAppUrl(msg.id);
      if (url) await tv.navigate(url);
      break;
    }
    case "text":
      if (msg.value) await auto.typeViaClipboard(msg.value);
      break;
    case "textKey":
      if (msg.key === "backspace") await auto.backspace();
      else await auto.tap("enter");
      break;
    case "mouseMove":
      await auto.moveMouse(clamp(msg.dx), clamp(msg.dy));
      break;
    case "mouseClick":
      await auto.click(msg.button);
      break;
    case "scroll":
      await auto.scroll(clamp(msg.dy));
      break;
    case "power":
      if (msg.action === "screenOff") await auto.screenOff();
      break;
    case "ping":
      break;
  }
}
