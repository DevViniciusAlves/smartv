import type { ControllerMessage } from "@smartv/shared";
import { getAppUrl } from "@smartv/shared";
import type { Automation } from "./automation.js";
import { openInBrowser } from "./automation.js";
import type { AgentConfig } from "./config.js";

// Mapeia mensagens validadas (whitelist) para ações reais. Nunca executa
// nada fora da whitelist.
export async function handleCommand(
  auto: Automation,
  config: AgentConfig,
  msg: ControllerMessage,
): Promise<{ volume?: number; muted?: boolean } | void> {
  const MOVE_LIMIT = 2000;
  const clamp = (n: number): number => Math.max(-MOVE_LIMIT, Math.min(MOVE_LIMIT, Math.trunc(n)));

  switch (msg.type) {
    case "key": {
      switch (msg.key) {
        case "up": await auto.pressKey("{UP}").catch(() => auto.pressKey("up")); break;
        case "down": await auto.pressKey("{DOWN}").catch(() => auto.pressKey("down")); break;
        case "left": await auto.pressKey("{LEFT}").catch(() => auto.pressKey("left")); break;
        case "right": await auto.pressKey("{RIGHT}").catch(() => auto.pressKey("right")); break;
        case "enter": await auto.pressKey("{ENTER}").catch(() => auto.pressKey("enter")); break;
        case "back":
          if (config.backBehavior === "esc") {
            await auto.pressKey("{ESC}").catch(() => auto.pressKey("esc"));
          } else {
            // Alt+Left = voltar no navegador.
            await auto.hotkey("%{LEFT}");
          }
          break;
        case "home":
          if (config.launcherUrl) {
            openInBrowser(
              config.browserPath,
              config.browserProfileDir,
              config.launcherUrl,
              config.tvWindowX,
              config.tvWindowY,
            );
            await auto.fullscreen().catch(() => undefined);
          }
          break;
      }
      break;
    }
    case "media": {
      switch (msg.action) {
        case "playpause": await auto.pressKey(" ").catch(() => undefined); break;
        case "seekForward": await auto.pressKey("{RIGHT}").catch(() => undefined); break;
        case "seekBackward": await auto.pressKey("{LEFT}").catch(() => undefined); break;
        case "fullscreen": await auto.pressKey("f").catch(() => undefined); break;
        case "next": await auto.hotkey("+{RIGHT}"); break;
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
      if (url) {
        openInBrowser(
          config.browserPath,
          config.browserProfileDir,
          url,
          config.tvWindowX,
          config.tvWindowY,
        );
        // Dá tempo da janela abrir e tenta tela cheia sem falhar o comando.
        setTimeout(() => auto.fullscreen().catch(() => undefined), 1500).unref?.();
      }
      break;
    }
    case "text":
      if (msg.value) await auto.typeViaClipboard(msg.value);
      break;
    case "textKey":
      if (msg.key === "backspace") await auto.backspace();
      else await auto.pressKey("{ENTER}").catch(() => undefined);
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
