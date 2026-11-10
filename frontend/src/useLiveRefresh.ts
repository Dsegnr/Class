import { useEffect, useRef } from "react";
import { realtimeConnected } from "./realtime";

export function useLiveRefresh(
  load: () => Promise<void>,
  interval: number,
  key: unknown = true,
) {
  const latest = useRef(load);
  latest.current = load;
  useEffect(() => {
    if (!key) return;
    let active = true,
      busy = false,
      queued = false;
    async function refresh() {
      if (!active) return;
      if (busy) {
        queued = true;
        return;
      }
      busy = true;
      try {
        await latest.current();
      } finally {
        busy = false;
        if (active && queued) {
          queued = false;
          void refresh();
        }
      }
    }
    const visibleRefresh = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    void refresh();
    const timer = setInterval(() => {
      if (!realtimeConnected()) visibleRefresh();
    }, interval);
    window.addEventListener("class:refresh", visibleRefresh);
    document.addEventListener("visibilitychange", visibleRefresh);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("class:refresh", visibleRefresh);
      document.removeEventListener("visibilitychange", visibleRefresh);
    };
  }, [interval, key]);
}
