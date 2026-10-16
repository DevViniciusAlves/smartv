import { execFile, spawn } from "node:child_process";

// Camada de automação: tenta nut-js; se indisponível (falha de provider nativo
// no Windows), usa fallback PowerShell/SendKeys + nircmd-less APIs.
// Toda entrada já foi validada pela whitelist (zod) antes de chegar aqui.

export type MouseButton = "left" | "right";

export interface Automation {
  pressKey(key: string): Promise<void>;
  hotkey(...keys: string[]): Promise<void>;
  typeViaClipboard(text: string): Promise<void>;
  backspace(): Promise<void>;
  moveMouse(dx: number, dy: number): Promise<void>;
  click(button: MouseButton): Promise<void>;
  scroll(dy: number): Promise<void>;
  volumeUp(step?: number): Promise<void>;
  volumeDown(step?: number): Promise<void>;
  volumeMute(): Promise<void>;
  screenOff(): Promise<void>;
  fullscreen(): Promise<void>;
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

// Fallback puro PowerShell usando System.Windows.Forms.SendKeys.
class PowershellAutomation implements Automation {

  async pressKey(key: string): Promise<void> {
    await runPowershell(
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${psEscape(key)}')`,
    );
  }
  async hotkey(...keys: string[]): Promise<void> {
    // keys no formato SendKeys já montado pelo chamador.
    await this.pressKey(keys.join(""));
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
    await this.pressKey("{BACKSPACE}");
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
    const amt = Math.trunc(dy) * -12;
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
  async fullscreen(): Promise<void> {
    await this.pressKey("{F11}");
  }
}

// Implementação nut-js carregada sob demanda (evita crash no import se o
// provider nativo falhar; nesse caso cai para PowerShell).
async function tryNutAutomation(): Promise<Automation | null> {
  try {
    const nut = await import("@nut-tree-fork/nut-js");
    const { keyboard, mouse, Key, Button } = nut;
    if (keyboard?.config) keyboard.config.autoDelayMs = 10;
    const sendKeys: Record<string, (typeof Key)[keyof typeof Key][]> = {
      up: [Key.Up],
      down: [Key.Down],
      left: [Key.Left],
      right: [Key.Right],
      enter: [Key.Enter],
      space: [Key.Space],
      esc: [Key.Escape],
      f: [Key.F],
      f11: [Key.F11],
      backspace: [Key.Backspace],
    };
    const nutAuto: Automation = {
      pressKey: async (key: string) => {
        const seq = sendKeys[key];
        if (!seq) throw new Error(`unsupported nut key: ${key}`);
        await keyboard.pressKey(...seq);
        await keyboard.releaseKey(...seq);
      },
      hotkey: async (...keys: string[]) => {
        // hotkey genérico não usado no modo nut; mantido para interface.
        await nutAuto.pressKey(keys.join("+"));
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
        await mouse.scrollUp(Math.trunc(-dy / 40));
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
      fullscreen: async () => {
        await keyboard.pressKey(Key.F11);
        await keyboard.releaseKey(Key.F11);
      },
    };
    // Smoke test barato.
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

export function openInBrowser(
  browserPath: string,
  profileDir: string,
  url: string,
  x: number,
  y: number,
): void {
  const args = [
    `--user-data-dir=${profileDir}`,
    `--window-position=${x},${y}`,
    "--disable-session-crashed-bubble",
    url,
  ];
  const child = spawn(browserPath, args, { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
}
