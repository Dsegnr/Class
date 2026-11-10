import { afterEach, expect, it, vi } from "vitest";
import { downloadZip } from "../api";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([
  ["任务原名", "示例班级职业规划比赛报名截图.zip"],
  ["示例班级职业规划比赛报名截图", null],
  ["职业规划比赛报名截图", null],
])(
  "downloads a class-prefixed archive without duplicating the class: %s",
  async (title, serverName) => {
    vi.useFakeTimers();
    const originalURL = URL;
    const revoke = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends originalURL {
        static createObjectURL = vi.fn(() => "blob:class-archive");
        static revokeObjectURL = revoke;
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new Blob(["archive"]), {
          headers: serverName
            ? {
                "Content-Disposition":
                  "attachment; filename*=UTF-8''" +
                  encodeURIComponent(serverName),
              }
            : {},
        }),
      ),
    );
    let filename = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      filename = this.download;
    });
    await downloadZip("task-id", title);
    expect(filename).toBe("示例班级职业规划比赛报名截图.zip");
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith("blob:class-archive");
  },
);
