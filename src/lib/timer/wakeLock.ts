/**
 * Screen Wake Lock controller with iOS hidden looping video fallback
 * and automatic re-acquisition on visibilitychange.
 */

// Minimal valid 1x1 silent looping MP4 data URI fallback for older iOS Safari
const SILENT_MP4_DATA_URI =
  "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAAu1tZGF0AAACrgYF//+q3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE0OCByMjY0MyA1YzY1NzA0IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlyaWdodCAyMDAzLTIwMTUgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcmdhbmF0aW9uOiBjYWJhYz0xIHJlZj0zIGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDM6MHgxMTMgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBiX2FkYXB0PTEgYl9iaWFzPTAgZGlyZWN0PTEgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0yIGtleWludD0yNTAga2V5aW50X21pbj0yNSBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfYWg9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMACAAAB2aWQAAAAAAAA=";

export class WakeLockController {
  private sentinel: { release: () => Promise<void> } | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private active = false;
  private boundVisHandler: (() => void) | null = null;

  async acquire(): Promise<void> {
    if (typeof window === "undefined") return;
    this.active = true;
    await this.requestLock();

    if (!this.boundVisHandler) {
      this.boundVisHandler = () => {
        if (document.visibilityState === "visible" && this.active) {
          void this.requestLock();
        }
      };
      document.addEventListener("visibilitychange", this.boundVisHandler);
    }
  }

  private async requestLock(): Promise<void> {
    try {
      const nav = navigator as unknown as {
        wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> };
      };
      if (nav.wakeLock) {
        this.sentinel = await nav.wakeLock.request("screen");
        return;
      }
    } catch {
      // Fall through to video fallback
    }

    // Hidden looping video fallback for browsers without Wake Lock API
    try {
      if (!this.videoEl) {
        const v = document.createElement("video");
        v.setAttribute("playsinline", "true");
        v.muted = true;
        v.loop = true;
        v.src = SILENT_MP4_DATA_URI;
        v.style.position = "fixed";
        v.style.width = "1px";
        v.style.height = "1px";
        v.style.opacity = "0";
        v.style.pointerEvents = "none";
        document.body.appendChild(v);
        this.videoEl = v;
      }
      await this.videoEl.play().catch(() => undefined);
    } catch {
      // Best effort
    }
  }

  async release(): Promise<void> {
    this.active = false;
    if (this.boundVisHandler) {
      document.removeEventListener("visibilitychange", this.boundVisHandler);
      this.boundVisHandler = null;
    }
    if (this.sentinel) {
      await this.sentinel.release().catch(() => undefined);
      this.sentinel = null;
    }
    if (this.videoEl) {
      this.videoEl.pause();
      this.videoEl.remove();
      this.videoEl = null;
    }
  }
}
