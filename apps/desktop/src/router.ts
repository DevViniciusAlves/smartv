// Pure navigation state for the single service view.
// Chromium fires did-fail-load with ERR_ABORTED (-3) whenever a main-frame
// navigation is superseded (fast service switch, double click, site
// redirects/SSO). Those are NOT failures. A failure is only real when it is
// a main-frame error, not an abort, for the latest requested URL, while the
// service surface is still visible. Everything else is stale/async noise and
// must never yank the user back to Home.
export type Surface = "home" | "service";

export interface RouterSnapshot {
  surface: Surface;
  appId: string | null;
  status: string;
}

// net::ERR_ABORTED — navigation superseded by a newer one.
export const ABORTED = -3;

export const LOAD_ERROR_TEXT = "Falha ao carregar. Verifique a internet e tente de novo.";

export class ViewRouter {
  private surface: Surface = "home";
  private appId: string | null = null;
  private pendingUrl: string | null = null;
  private status = "";

  snapshot(): RouterSnapshot {
    return { surface: this.surface, appId: this.appId, status: this.status };
  }

  openApp(id: string, url: string): RouterSnapshot {
    this.surface = "service";
    this.appId = id;
    this.pendingUrl = url;
    this.status = `Abrindo ${id}…`;
    return this.snapshot();
  }

  goHome(): RouterSnapshot {
    this.surface = "home";
    this.appId = null;
    this.pendingUrl = null;
    this.status = "";
    return this.snapshot();
  }

  onStarted(): RouterSnapshot {
    if (this.surface === "service") this.status = "Carregando…";
    return this.snapshot();
  }

  onStopped(): RouterSnapshot {
    if (this.surface === "service") this.status = this.appId ?? "";
    return this.snapshot();
  }

  onFailed(code: number, isMainFrame: boolean, url: string): RouterSnapshot {
    if (!isMainFrame) return this.snapshot();
    if (code === ABORTED) return this.snapshot();
    if (this.surface !== "service") return this.snapshot();
    if (url !== this.pendingUrl) return this.snapshot();
    this.surface = "home";
    this.appId = null;
    this.pendingUrl = null;
    this.status = LOAD_ERROR_TEXT;
    return this.snapshot();
  }
}
