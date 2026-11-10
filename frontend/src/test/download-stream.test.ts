import { afterEach, expect, it, vi } from "vitest";
import { downloadZip } from "../api";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function anchors() {
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  const Original = URL;
  vi.stubGlobal(
    "URL",
    class extends Original {
      static createObjectURL = vi.fn(() => "blob:qa");
      static revokeObjectURL = vi.fn();
    },
  );
  return click;
}

it("times out while waiting for headers and aborts fetch", async () => {
  vi.useFakeTimers();
  const click = anchors();
  let signal: AbortSignal;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          signal = options.signal;
          signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    ),
  );
  const result = downloadZip("qa", "活动截图", true, {
    preparationTimeoutMs: 50,
  });
  const checked = expect(result).rejects.toThrow("超时");
  await vi.advanceTimersByTimeAsync(51);
  await checked;
  expect(signal!.aborted).toBe(true);
  expect(click).not.toHaveBeenCalled();
});

it.each(["cancel", "timeout"])(
  "never saves a partial archive on midstream %s, then allows retry",
  async (mode) => {
    vi.useFakeTimers();
    const click = anchors();
    const cancel = vi.fn();
    const controller = new AbortController();
    const phases: string[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(output) {
        output.enqueue(new Uint8Array([80, 75]));
      },
      cancel,
    });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(stream))
      .mockResolvedValueOnce(new Response("complete"));
    vi.stubGlobal("fetch", fetcher);
    const result = downloadZip("qa", "活动截图", true, {
      signal: controller.signal,
      idleTimeoutMs: 50,
      onPhase: (value) => phases.push(value),
    });
    const checked = expect(result).rejects.toMatchObject(
      mode === "cancel"
        ? { name: "AbortError" }
        : { message: expect.stringContaining("超时") },
    );
    await vi.advanceTimersByTimeAsync(1);
    if (mode === "cancel") controller.abort();
    else await vi.advanceTimersByTimeAsync(51);
    await checked;
    expect(cancel).toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(phases).toEqual(["preparing", "receiving"]);
    await downloadZip("qa", "活动截图");
    expect(click).toHaveBeenCalledOnce();
  },
);
