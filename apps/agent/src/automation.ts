import { execFile } from "node:child_process";

// Automation layer with a semantic API: callers use key names, never raw
// SendKeys strings or nut-js Key objects. Input is already validated by the
// zod whitelist before reaching this layer. Errors are never swallowed here;
// they propagate to the caller (index.ts logs them).

export type MouseButton = "left" | "right";

export type KeyName =
  | "up"
  | "down"
  | "left"
  | "right"
  | "enter"
  | "esc"
  | "space"
  | "backspace"
  | "f"
  | "f11"
  // Extra key used only by the TvBrowser fallback (focus the address bar).
  | "l";

export type Modifier = "alt" | "shift" | "ctrl";

export interface Automation {
  tap(key: KeyName): Promise<void>;
  combo(mods: Modifier[], key: KeyName): Promise<void>;
  typeViaClipboard(text: string): Promise<void>;
  backspace(): Promise<void>;
  moveMouse(dx: number, dy: number): Promise<void>;
  click(button: MouseButton): Promise<void>;
  // dy > 0 means the finger moved down (two-finger drag down).
  // Semantic: finger up scrolls the page down, like on a phone
  // (same as rolling the mouse wheel down).
  scroll(dy: number): Promise<void>;
  volumeUp(step?: number): Promise<void>;
  volumeDown(step?: number): Promise<void>;
  volumeMute(): Promise<void>;
  screenOff(): Promise<void>;
}

function runPowershell(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true },
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

const psEscape = (s: string): string => s.replace(/'/g, "''");

// SendKeys token per key. Mapping lives inside this backend only.
const SEND_KEYS: Record<KeyName, string> = {
  up: "{UP}",
  down: "{DOWN}",
  left: "{LEFT}",
  right: "{RIGHT}",
  enter: "{ENTER}",
  esc: "{ESC}",
  space: " ",
  backspace: "{BACKSPACE}",
  f: "f",
  f11: "{F11}",
  l: "l",
};

const MOD_CHARS: Record<Modifier, string> = { alt: "%", shift: "+", ctrl: "^" };

// Pure PowerShell backend using System.Windows.Forms.SendKeys and user32.dll.
class PowershellAutomation implements Automation {
  async tap(key: KeyName): Promise<void> {
    await runPowershell(
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${psEscape(SEND_KEYS[key])}')`,
    );
  }
  async combo(mods: Modifier[], key: KeyName): Promise<void> {
    const seq = mods.map((m) => MOD_CHARS[m]).join("") + SEND_KEYS[key];
    await runPowershell(
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${psEscape(seq)}')`,
    );
  }
  async typeViaClipboard(text: string): Promise<void> {
    const b64 = Buffer.from(text, "utf16le").toString("base64");
    await runPowershell(
      `$t=[System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${b64}'));` +
        `Add-Type -AssemblyName System.Windows.Forms;` +
        `[System.Windows.Forms.Clipboard]::SetText($t);` +
        `[System.Windows.Forms.SendKeys]::SendWait('^v')`,
    );
  }
  async backspace(): Promise<void> {
    await this.tap("backspace");
  }
  async moveMouse(dx: number, dy: number): Promise<void> {
    const c = `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p); [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); public struct POINT{public int X;public int Y;}' -Name U -Namespace W;` +
      `$p=New-Object W.U+POINT; [W.U]::GetCursorPos([ref]$p)|Out-Null; [W.U]::SetCursorPos($p.X+(${Math.trunc(dx)}),$p.Y+(${Math.trunc(dy)}))|Out-Null`;
    await runPowershell(c);
  }
  async click(button: MouseButton): Promise<void> {
    const down = button === "left" ? "0x0002" : "0x0008";
    const up = button === "left" ? "0x0004" : "0x0010";
    await runPowershell(
      `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int f,int x,int y,int d,int e);' -Name M -Namespace W;` +
        `[W.M]::mouse_event(${down},0,0,0,0); [W.M]::mouse_event(${up},0,0,0,0)`,
    );
  }
  async scroll(dy: number): Promise<void> {
    // MOUSEEVENTF_WHEEL: positive dwData scrolls up, negative scrolls down.
    // Finger up (dy < 0) must scroll the page down, like a phone.
    const amt = Math.trunc(dy) * 12;
    if (amt === 0) return;
    await runPowershell(
      `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int f,int x,int y,int d,int e);' -Name M2 -Namespace W;` +
        `[W.M2]::mouse_event(0x0800,0,0,(${amt}),0)`,
    );
  }
  async volumeUp(step = 2): Promise<void> {
    const n = Math.min(10, Math.max(1, step));
    await runPowershell(
      `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte b,byte c,int f,int e);' -Name V -Namespace W;` +
        `for($i=0;$i -lt ${n};$i++){[W.V]::keybd_event(0xAF,0,0,0);[W.V]::keybd_event(0xAF,0,2,0)}`,
    );
  }
  async volumeDown(step = 2): Promise<void> {
    const n = Math.min(10, Math.max(1, step));
    await runPowershell(
      `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte b,byte c,int f,int e);' -Name V -Namespace W;` +
        `for($i=0;$i -lt ${n};$i++){[W.V]::keybd_event(0xAE,0,0,0);[W.V]::keybd_event(0xAE,0,2,0)}`,
    );
  }
  async volumeMute(): Promise<void> {
    await runPowershell(
      `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte b,byte c,int f,int e);' -Name V -Namespace W;` +
        `[W.V]::keybd_event(0xAD,0,0,0);[W.V]::keybd_event(0xAD,0,2,0)`,
    );
  }
  async screenOff(): Promise<void> {
    await runPowershell(
      `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern int SendMessage(int h,int m,int w,int l);' -Name P -Namespace W;` +
        `[W.P]::SendMessage(-1,0x0112,0xF170,2)|Out-Null`,
    );
  }
}

// nut-js backend, loaded on demand (a broken native provider falls back to
// PowerShell instead of crashing the import).
async function tryNutAutomation(): Promise<Automation | null> {
  try {
    const nut = await import("@nut-tree-fork/nut-js");
    const { keyboard, mouse, Key, Button } = nut;
    if (keyboard?.config) keyboard.config.autoDelayMs = 10;
    const keyMap: Record<KeyName, (typeof Key)[keyof typeof Key]> = {
      up: Key.Up,
      down: Key.Down,
      left: Key.Left,
      right: Key.Right,
      enter: Key.Enter,
      esc: Key.Escape,
      space: Key.Space,
      backspace: Key.Backspace,
      f: Key.F,
      f11: Key.F11,
      l: Key.L,
    };
    const modMap: Record<Modifier, (typeof Key)[keyof typeof Key]> = {
      alt: Key.LeftAlt,
      shift: Key.LeftShift,
      ctrl: Key.LeftControl,
    };
    const nutAuto: Automation = {
      tap: async (key: KeyName) => {
        const k = keyMap[key];
        await keyboard.pressKey(k);
        await keyboard.releaseKey(k);
      },
      combo: async (mods: Modifier[], key: KeyName) => {
        const seq = [...mods.map((m) => modMap[m]), keyMap[key]];
        await keyboard.pressKey(...seq);
        await keyboard.releaseKey(...seq);
      },
      typeViaClipboard: async (text: string) => {
        const { default: clipboardy } = await import("clipboardy");
        const prev = await clipboardy.read().catch(() => "");
        await clipboardy.write(text);
        await keyboard.pressKey(Key.LeftControl, Key.V);
        await keyboard.releaseKey(Key.LeftControl, Key.V);
        if (prev) await clipboardy.write(prev).catch(() => undefined);
      },
      backspace: async () => {
        await keyboard.pressKey(Key.Backspace);
        await keyboard.releaseKey(Key.Backspace);
      },
      moveMouse: async (dx: number, dy: number) => {
        const pos = await mouse.getPosition();
        await mouse.setPosition({ x: pos.x + Math.trunc(dx), y: pos.y + Math.trunc(dy) });
      },
      click: async (button: MouseButton) => {
        await mouse.click(button === "left" ? Button.LEFT : Button.RIGHT);
      },
      scroll: async (dy: number) => {
        // Finger up (dy < 0) scrolls the page down, like a phone.
        const ticks = Math.trunc(Math.abs(dy) / 40);
        if (ticks === 0) return;
        if (dy < 0) await mouse.scrollDown(ticks);
        else await mouse.scrollUp(ticks);
      },
      volumeUp: async (step = 2) => {
        for (let i = 0; i < step; i++) {
          await keyboard.pressKey(Key.AudioVolUp);
          await keyboard.releaseKey(Key.AudioVolUp);
        }
      },
      volumeDown: async (step = 2) => {
        for (let i = 0; i < step; i++) {
          await keyboard.pressKey(Key.AudioVolDown);
          await keyboard.releaseKey(Key.AudioVolDown);
        }
      },
      volumeMute: async () => {
        await keyboard.pressKey(Key.AudioMute);
        await keyboard.releaseKey(Key.AudioMute);
      },
      screenOff: async () => {
        await runPowershell(
          `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern int SendMessage(int h,int m,int w,int l);' -Name P -Namespace W;` +
            `[W.P]::SendMessage(-1,0x0112,0xF170,2)|Out-Null`,
        );
      },
    };
    // Cheap smoke test.
    await mouse.getPosition();
    return nutAuto;
  } catch {
    return null;
  }
}

export async function createAutomation(): Promise<{ auto: Automation; backend: "nut-js" | "powershell" }> {
  const nut = await tryNutAutomation();
  if (nut) return { auto: nut, backend: "nut-js" };
  return { auto: new PowershellAutomation(), backend: "powershell" };
}
