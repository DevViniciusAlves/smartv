// Consistent command layer for dpad/media keys.
//
// Scopes:
// - "home": handled by the local Home UI (arrows/enter when Home is visible).
// - "page": injected into the active service page via
//   webContents.sendInputEvent (wired in a later remote-control step).
// - "system": executed by the OS/agent layer (volume, power), never injected.
//
// Service pages keep their native behavior; these keys only produce the
// documented strokes. Whether a service honors them depends on the service
// (see docs/STREAMING.md).
export type DpadAction =
  | "up"
  | "down"
  | "left"
  | "right"
  | "enter"
  | "back"
  | "playpause"
  | "seekForward"
  | "seekBackward";

export type KeyScope = "home" | "page" | "system";

export interface KeyStroke {
  type: "keyDown" | "keyUp";
  keyCode: string;
}

const STROKES: Record<DpadAction, { code: string; scope: KeyScope }> = {
  up: { code: "Up", scope: "page" },
  down: { code: "Down", scope: "page" },
  left: { code: "Left", scope: "page" },
  right: { code: "Right", scope: "page" },
  enter: { code: "Enter", scope: "page" },
  back: { code: "Escape", scope: "page" },
  playpause: { code: "Space", scope: "page" },
  seekForward: { code: "Right", scope: "page" },
  seekBackward: { code: "Left", scope: "page" },
};

export function actionScope(action: DpadAction): KeyScope {
  return STROKES[action].scope;
}

// A press is keyDown followed by keyUp with the same keyCode.
export function actionToStrokes(action: DpadAction): [KeyStroke, KeyStroke] {
  const { code } = STROKES[action];
  return [
    { type: "keyDown", keyCode: code },
    { type: "keyUp", keyCode: code },
  ];
}
