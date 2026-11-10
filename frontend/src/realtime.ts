import { BASE } from "./api";

let connected = false;
let lastFrame = 0;
export function realtimeConnected() {
  return connected && Date.now() - lastFrame < 25000;
}

export function connectRealtime() {
  if (typeof EventSource === "undefined") return () => {};
  let active = true;
  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  function close() {
    source?.close();
    source = null;
    connected = false;
    if (retry) clearTimeout(retry);
    retry = null;
  }
  function refresh() {
    lastFrame = Date.now();
    if (active && document.visibilityState === "visible")
      window.dispatchEvent(new Event("class:refresh"));
  }
  function open() {
    if (!active || source || document.visibilityState !== "visible") return;
    const current = new EventSource(BASE + "/updates");
    source = current;
    current.onopen = () => {
      if (active && source === current) {
        connected = true;
        lastFrame = Date.now();
      }
    };
    current.onerror = () => {
      if (source !== current) return;
      // Some fatal/network-blocked EventSource failures never auto-retry.
      close();
      retry = setTimeout(open, 3000);
    };
    current.addEventListener("refresh", () => {
      if (source === current) refresh();
    });
    current.addEventListener("heartbeat", () => {
      if (active && source === current) lastFrame = Date.now();
    });
    current.addEventListener("revoked", () => {
      if (source !== current) return;
      close();
      // GET APIs distinguish an expired login from a just-rotated cookie.
      refresh();
      retry = setTimeout(open, 3000);
    });
  }
  function visibility() {
    if (document.visibilityState === "visible") {
      open();
      refresh();
    } else close();
  }
  document.addEventListener("visibilitychange", visibility);
  const watchdog = setInterval(() => {
    if (source && connected && !realtimeConnected()) {
      close();
      open();
      refresh();
    }
  }, 10000);
  open();
  return () => {
    active = false;
    close();
    clearInterval(watchdog);
    document.removeEventListener("visibilitychange", visibility);
  };
}
