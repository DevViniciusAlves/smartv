// Brave as the streaming renderer: detection, launch arguments, input mapping
// and the TV-navigation bootstrap.
//
// Why Brave: the bundled Electron view needs a manually downloaded Widevine CDM
// (apps/desktop/scripts/gen-widevine.mjs) and, once packed, still fails on the
// services that hard-require the platform CDM (HBO Max / Max, Netflix). Brave
// ships Widevine and updates it by itself, so DRM "just works" with zero extra
// steps — and it keeps the ad/tracking shields the app already wants.
//
// Everything in this file is pure (no Electron, no fs, no child_process) so it
// can be unit-tested in plain Node. Side effects live in brave-manager.ts.

export const BRAVE_CDP_PORT = 9333;

/** Where the Brave executable usually lives, per platform. */
export function braveCandidates(platform: string, env: Record<string, string | undefined>): string[] {
  const local = env.LOCALAPPDATA ?? env.APPDATA;
  const home = env.HOME ?? env.USERPROFILE;
  if (platform === "win32") {
    return [
      "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      ...(local ? [`${local}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`] : []),
    ];
  }
  if (platform === "darwin") {
    return [
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      ...(home ? [`${home}/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`] : []),
    ];
  }
  return [
    "/usr/bin/brave-browser",
    "/usr/bin/brave",
    "/opt/brave.com/brave/brave",
    "/snap/bin/brave",
    ...(home ? [`${home}/.local/bin/brave-browser`] : []),
  ];
}

export function findBraveExecutable(
  platform: string,
  env: Record<string, string | undefined>,
  exists: (p: string) => boolean,
): string | null {
  for (const candidate of braveCandidates(platform, env)) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

export interface BraveLaunchOptions {
  url: string;
  /** Isolated profile dir so Brave never touches the user's daily browser. */
  userDataDir: string;
  debugPort: number;
  startFullscreen?: boolean;
}

/**
 * Arguments for a TV-mode Brave window: app mode (no tabs/omnibox), isolated
 * profile, CDP on 127.0.0.1 only, and the media/navigation switches that make
 * a desktop browser behave like a TV (autoplay, no pinch, no overscroll).
 */
export function buildBraveArgs(o: BraveLaunchOptions): string[] {
  return [
    `--app=${o.url}`,
    `--user-data-dir=${o.userDataDir}`,
    `--remote-debugging-port=${o.debugPort}`,
    "--remote-debugging-address=127.0.0.1",
    o.startFullscreen === false ? "" : "--start-fullscreen",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-session-crashed-bubble",
    "--disable-infobars",
    // Make protected-content playback explicit in the dedicated Brave
    // profile. Without this, some Brave installations report the generic
    // "DRM system not compatible" page even though Widevine is installed.
    "--enable-widevine-cdm",
    "--autoplay-policy=no-user-gesture-required",
    "--overscroll-history-navigation=0",
    "--disable-pinch",
    "--window-position=0,0",
  ].filter(Boolean);
}

// ---------------------------------------------------------------------------
// Phone key events -> CDP Input.dispatchKeyEvent parameters.
// ---------------------------------------------------------------------------

export interface CdpKeyEventLike {
  type: "keyDown" | "keyUp" | "char";
  keyCode: string;
  modifiers?: string[];
}

export interface CdpKeyParams {
  type: "rawKeyDown" | "keyDown" | "keyUp" | "char";
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  nativeVirtualKeyCode: number;
  modifiers?: number;
  text?: string;
  unmodifiedText?: string;
}

// CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.
function modifierMask(modifiers: string[] | undefined): number | undefined {
  if (!modifiers || modifiers.length === 0) return undefined;
  let mask = 0;
  for (const m of modifiers) {
    const k = m.toLowerCase();
    if (k === "alt") mask |= 1;
    else if (k === "ctrl" || k === "control") mask |= 2;
    else if (k === "meta" || k === "command") mask |= 4;
    else if (k === "shift") mask |= 8;
  }
  return mask === 0 ? undefined : mask;
}

interface KeyEntry {
  key: string;
  code: string;
  vk: number;
  /** Printable keys go through keyDown (they produce text); others rawKeyDown. */
  printable?: boolean;
}

const KEY_TABLE: Record<string, KeyEntry> = {
  Up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  Down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  Left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  Right: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  Enter: { key: "Enter", code: "Enter", vk: 13 },
  Space: { key: " ", code: "Space", vk: 32, printable: true },
  Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  Delete: { key: "Delete", code: "Delete", vk: 46 },
  Tab: { key: "Tab", code: "Tab", vk: 9 },
  Escape: { key: "Escape", code: "Escape", vk: 27 },
  Shift: { key: "Shift", code: "ShiftLeft", vk: 16 },
  Control: { key: "Control", code: "ControlLeft", vk: 17 },
  Alt: { key: "Alt", code: "AltLeft", vk: 18 },
  Home: { key: "Home", code: "Home", vk: 36 },
  End: { key: "End", code: "End", vk: 35 },
  PageUp: { key: "PageUp", code: "PageUp", vk: 33 },
  PageDown: { key: "PageDown", code: "PageDown", vk: 34 },
  Insert: { key: "Insert", code: "Insert", vk: 45 },
};

function entryFor(keyCode: string): KeyEntry | null {
  const known = KEY_TABLE[keyCode];
  if (known) return known;
  // Single printable character: letters, digits and punctuation.
  if (keyCode.length === 1) {
    const upper = keyCode.toUpperCase();
    const isLetter = upper >= "A" && upper <= "Z";
    if (isLetter) {
      return { key: keyCode, code: `Key${upper}`, vk: upper.charCodeAt(0), printable: true };
    }
    if (keyCode >= "0" && keyCode <= "9") {
      return { key: keyCode, code: `Digit${keyCode}`, vk: keyCode.charCodeAt(0), printable: true };
    }
    return { key: keyCode, code: "", vk: keyCode.charCodeAt(0), printable: true };
  }
  return null;
}

/**
 * Maps one phone key event to CDP `Input.dispatchKeyEvent` parameters. Mirrors
 * what Electron's sendInputEvent delivers to the service view today, so the
 * same phone commands behave identically in Brave.
 */
export function cdpKeyParams(ev: CdpKeyEventLike): CdpKeyParams | null {
  const modifiers = modifierMask(ev.modifiers);
  if (ev.type === "char") {
    // Text entry: a char event carries the text itself (never a shortcut).
    return {
      type: "char",
      key: ev.keyCode,
      code: "",
      windowsVirtualKeyCode: 0,
      nativeVirtualKeyCode: 0,
      ...(modifiers !== undefined ? { modifiers } : {}),
      text: ev.keyCode,
      unmodifiedText: ev.keyCode,
    };
  }
  const entry = entryFor(ev.keyCode);
  if (!entry) return null;
  const base = {
    key: entry.key,
    code: entry.code,
    windowsVirtualKeyCode: entry.vk,
    nativeVirtualKeyCode: entry.vk,
    ...(modifiers !== undefined ? { modifiers } : {}),
  };
  if (ev.type === "keyUp") return { type: "keyUp", ...base };
  if (entry.printable) {
    return { type: "keyDown", ...base, text: entry.key, unmodifiedText: entry.key };
  }
  return { type: "rawKeyDown", ...base };
}

// ---------------------------------------------------------------------------
// TV navigation bootstrap (runs in Brave's page context).
// ---------------------------------------------------------------------------

/**
 * Wraps the compiled service-preload (dist/service-preload.cjs) so the same
 * D-pad focus ring works inside Brave. The preload is a sandbox CommonJS
 * module with no imports; shimming `module`/`exports` lets it run as-is in the
 * page's main world, where its keydown capture listener attaches normally.
 */
export function wrapServicePreload(source: string): string {
  return (
    "(function(){\n" +
    // Keep Brave's target=_blank/window.open navigations inside the single
    // SmartTV surface; otherwise CDP input remains attached to the old tab.
    "if(typeof window!=='undefined'&&typeof document!=='undefined'){var smartvOpen=window.open;window.open=function(url){if(url){location.href=String(url);}return window;};\n" +
    "document.addEventListener('click',function(e){var a=e.target instanceof Element?e.target.closest('a[target=_blank],a[target=_new]'):null;if(!a)return;var href=a.href;if(!href)return;e.preventDefault();e.stopImmediatePropagation();location.href=href;},true);void smartvOpen;}\n" +
    "var module={exports:{}};var exports=module.exports;\n" +
    source +
    "\n})();"
  );
}

/** URL of the streaming surface we are allowed to drive in Brave. */
export function isStreamingUrl(url: string, allowedHosts: (host: string) => boolean): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && allowedHosts(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}
