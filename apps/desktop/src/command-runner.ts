// Executes remote-controller commands INSIDE the Electron app.
//
// Before this step the installed app never connected to the relay: only the
// separate Node.js agent (apps/agent) did, via OS-level key injection plus an
// opt-in CDP flag (--smartv-cdp). Result: installing SmartTV Setup.exe alone
// left /controle stuck on "PC offline".
//
// Now the app connects itself (see remote-agent.ts) and runs commands
// natively:
//   - navigation/keys/media/text/mouse-position -> the focused WebContentsView
//     via sendInputEvent (no focus hacks, no CDP flag, no second process)
//   - volume/power/mouse-move/click/scroll -> tiny PowerShell snippets via
//     user32.dll (same semantics as the standalone agent)
//
// This module keeps every DECISION pure and tested (mapping + scripts).
// Electron WebContents access stays behind the RemoteSurface interface so
// main.ts injects the real views and tests inject fakes.

import type { ControllerMessage } from "@smartv/shared";

export interface KeyEventLike {
  type: "keyDown" | "keyUp" | "char";
  keyCode: string;
  modifiers?: string[];
}

export type SurfaceAction =
  | { kind: "go-home" }
  | { kind: "go-back" }
  | { kind: "open-app"; id: string }
  | { kind: "media-play" }
  | { kind: "media-pause" }
  | { kind: "press"; events: KeyEventLike[] }
  | { kind: "system"; scriptKind: SystemScriptKind; step?: number; dx?: number; dy?: number }
  | { kind: "ignore" };

export type SystemScriptKind =
  | "vol-up"
  | "vol-down"
  | "mute"
  | "screen-off"
  | "mouse-move"
  | "mouse-click-left"
  | "mouse-click-right"
  | "scroll";

function press(keyCode: string, modifiers?: string[]): KeyEventLike[] {
  return [
    { type: "keyDown", keyCode, modifiers },
    { type: "keyUp", keyCode, modifiers },
  ];
}

const KEY_TO_CODE: Record<string, string> = {
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  enter: "Enter",
  space: "Space",
  backspace: "Backspace",
  f: "F",
};

/** Pure decision: what should the app do with this validated message? */
export function describeAction(msg: ControllerMessage): SurfaceAction {
  switch (msg.type) {
    case "key":
      if (msg.key === "home") return { kind: "go-home" };
      if (msg.key === "back") return { kind: "go-back" };
      return { kind: "press", events: press(KEY_TO_CODE[msg.key] ?? "Enter") };
    case "media":
      if (msg.action === "playpause") return { kind: "press", events: press("Space") };
      if (msg.action === "play") return { kind: "media-play" };
      if (msg.action === "pause") return { kind: "media-pause" };
      if (msg.action === "seekForward") return { kind: "press", events: press("Right") };
      if (msg.action === "seekBackward") return { kind: "press", events: press("Left") };
      if (msg.action === "fullscreen") return { kind: "press", events: press("F") };
      // "next": Shift+Right (same semantic as the standalone agent combo).
      return {
        kind: "press",
        events: [
          { type: "keyDown", keyCode: "Shift" },
          { type: "keyDown", keyCode: "Right" },
          { type: "keyUp", keyCode: "Right" },
          { type: "keyUp", keyCode: "Shift" },
        ],
      };
    case "volume":
      if (msg.action === "up") return { kind: "system", scriptKind: "vol-up", step: msg.step ?? 2 };
      if (msg.action === "down")
        return { kind: "system", scriptKind: "vol-down", step: msg.step ?? 2 };
      return { kind: "system", scriptKind: "mute" };
    case "app":
      return { kind: "open-app", id: msg.id };
    case "text": {
      const chars = (msg.value ?? "").slice(0, 500).split("");
      if (chars.length === 0) return { kind: "ignore" };
      return { kind: "press", events: chars.map((c) => ({ type: "char", keyCode: c }) as KeyEventLike) };
    }
    case "textKey":
      return msg.key === "backspace"
        ? { kind: "press", events: press("Backspace") }
        : { kind: "press", events: press("Enter") };
    case "mouseMove":
      return { kind: "system", scriptKind: "mouse-move", dx: msg.dx, dy: msg.dy };
    case "mouseClick":
      return {
        kind: "system",
        scriptKind: msg.button === "left" ? "mouse-click-left" : "mouse-click-right",
      };
    case "scroll":
      return { kind: "system", scriptKind: "scroll", dy: msg.dy };
    case "power":
      return { kind: "system", scriptKind: "screen-off" };
    case "ping":
      return { kind: "ignore" };
  }
}

function clampStep(step: number | undefined): number {
  const n = Math.trunc(step ?? 2);
  return Math.min(10, Math.max(1, Number.isFinite(n) ? n : 2));
}

function clampMove(n: number | undefined): number {
  const v = Math.trunc(n ?? 0);
  return Math.min(2000, Math.max(-2000, Number.isFinite(v) ? v : 0));
}

/**
 * PowerShell snippet for a system-level action. Runs with
 * `powershell -NoProfile -NonInteractive -Command <script>` from the
 * Electron main process (Windows only). No tokens or typed text are ever
 * interpolated: text entry goes through `char` input events, never here.
 */
export function systemScriptFor(action: Extract<SurfaceAction, { kind: "system" }>): string {
  switch (action.scriptKind) {
    case "vol-up": {
      const n = clampStep(action.step);
      return (
        `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte b,byte c,int f,int e);' -Name V -Namespace W;` +
        `for($i=0;$i -lt ${n};$i++){[W.V]::keybd_event(0xAF,0,0,0);[W.V]::keybd_event(0xAF,0,2,0)}`
      );
    }
    case "vol-down": {
      const n = clampStep(action.step);
      return (
        `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte b,byte c,int f,int e);' -Name V -Namespace W;` +
        `for($i=0;$i -lt ${n};$i++){[W.V]::keybd_event(0xAE,0,0,0);[W.V]::keybd_event(0xAE,0,2,0)}`
      );
    }
    case "mute":
      return (
        `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte b,byte c,int f,int e);' -Name V -Namespace W;` +
        `[W.V]::keybd_event(0xAD,0,0,0);[W.V]::keybd_event(0xAD,0,2,0)`
      );
    case "screen-off":
      return (
        `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern int SendMessage(int h,int m,int w,int l);' -Name P -Namespace W;` +
        `[W.P]::SendMessage(-1,0x0112,0xF170,2)|Out-Null`
      );
    case "mouse-move": {
      const dx = clampMove(action.dx);
      const dy = clampMove(action.dy);
      return (
        `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p); [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); public struct POINT{public int X;public int Y;}' -Name U -Namespace W;` +
        `$p=New-Object W.U+POINT; [W.U]::GetCursorPos([ref]$p)|Out-Null; [W.U]::SetCursorPos($p.X+(${dx}),$p.Y+(${dy}))|Out-Null`
      );
    }
    case "mouse-click-left":
      return (
        `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int f,int x,int y,int d,int e);' -Name M -Namespace W;` +
        `[W.M]::mouse_event(0x0002,0,0,0,0); [W.M]::mouse_event(0x0004,0,0,0,0)`
      );
    case "mouse-click-right":
      return (
        `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int f,int x,int y,int d,int e);' -Name M -Namespace W;` +
        `[W.M]::mouse_event(0x0008,0,0,0,0); [W.M]::mouse_event(0x0010,0,0,0,0)`
      );
    case "scroll": {
      const amt = clampMove(action.dy) * 12;
      if (amt === 0) return "";
      return (
        `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int f,int x,int y,int d,int e);' -Name M2 -Namespace W;` +
        `[W.M2]::mouse_event(0x0800,0,0,(${amt}),0)`
      );
    }
  }
}
