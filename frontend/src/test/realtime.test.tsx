import { act, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { connectRealtime, realtimeConnected } from "../realtime";
import { useLiveRefresh } from "../useLiveRefresh";

class Source extends EventTarget {
  static instances: Source[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(readonly url: string) {
    super();
    Source.instances.push(this);
  }
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Source.instances = [];
});

it("owns one cookie-authenticated connection, closes while hidden, and recovers from errors and revoked sessions", () => {
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", Source);
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("visible");
  const refresh = vi.fn();
  window.addEventListener("class:refresh", refresh);
  const dispose = connectRealtime();
  const first = Source.instances[0];
  expect(first.url).toBe("/api/updates");
  first.onopen?.();
  expect(realtimeConnected()).toBe(true);
  first.dispatchEvent(new Event("refresh"));
  expect(refresh).toHaveBeenCalledOnce();
  first.onerror?.();
  expect(realtimeConnected()).toBe(false);
  visibility.mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  expect(first.close).toHaveBeenCalledOnce();
  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  const second = Source.instances[1];
  second.onopen?.();
  second.dispatchEvent(new Event("revoked"));
  expect(second.close).toHaveBeenCalledOnce();
  expect(realtimeConnected()).toBe(false);
  vi.advanceTimersByTime(3000);
  expect(Source.instances).toHaveLength(3);
  dispose();
  expect(Source.instances[2].close).toHaveBeenCalledOnce();
  expect(realtimeConnected()).toBe(false);
  window.removeEventListener("class:refresh", refresh);
});

it("retries fatal transport errors without requiring a page reload", () => {
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", Source);
  const dispose = connectRealtime();
  Source.instances[0].onopen?.();
  Source.instances[0].onerror?.();
  expect(Source.instances[0].close).toHaveBeenCalledOnce();
  expect(realtimeConnected()).toBe(false);
  vi.advanceTimersByTime(3000);
  expect(Source.instances).toHaveLength(2);
  Source.instances[1].onopen?.();
  expect(realtimeConnected()).toBe(true);
  dispose();
});

it("detects a silent connection without heartbeats and reconnects", () => {
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", Source);
  const dispose = connectRealtime();
  Source.instances[0].onopen?.();
  vi.advanceTimersByTime(20000);
  expect(Source.instances).toHaveLength(1);
  Source.instances[0].dispatchEvent(new Event("heartbeat"));
  vi.advanceTimersByTime(20000);
  expect(Source.instances).toHaveLength(1);
  vi.advanceTimersByTime(10000);
  expect(Source.instances).toHaveLength(2);
  expect(Source.instances[0].close).toHaveBeenCalledOnce();
  dispose();
});

it("coalesces update bursts, retries polling while disconnected, and stops after unmount", async () => {
  const load = vi.fn().mockResolvedValue(undefined);
  let finish!: () => void;
  load.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  function Page() {
    useLiveRefresh(load, 20);
    return null;
  }
  const view = render(<Page />);
  act(() => {
    for (let i = 0; i < 5; i++)
      window.dispatchEvent(new Event("class:refresh"));
  });
  expect(load).toHaveBeenCalledOnce();
  await act(async () => {
    finish();
  });
  expect(load).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(load.mock.calls.length).toBeGreaterThan(2));
  view.unmount();
  const calls = load.mock.calls.length;
  act(() => window.dispatchEvent(new Event("class:refresh")));
  expect(load).toHaveBeenCalledTimes(calls);
});
