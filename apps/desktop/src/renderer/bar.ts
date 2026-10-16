// Type-only reference to window.smartv (no runtime import: the bridge is
// injected by the preload script, so an `import` would break the bundle).
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./smartv.d.ts" />

export {};

function bridge(): Window["smartv"] | null {
  return typeof window.smartv === "object" && window.smartv !== null ? window.smartv : null;
}

(document.getElementById("home") as HTMLElement).addEventListener("click", () => {
  void bridge()?.goHome();
});

bridge()?.onStatus((text: string) => {
  const st = document.getElementById("status");
  if (st) st.textContent = text;
});
