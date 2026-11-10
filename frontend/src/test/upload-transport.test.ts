import { afterEach, describe, expect, it, vi } from "vitest";
import { stageFiles, setCsrf } from "../api";

class Request {
  static latest: Request;
  upload: {
    onprogress?: (event: {
      lengthComputable: boolean;
      loaded: number;
      total: number;
    }) => void;
  } = {};
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  status = 200;
  responseText = '{"id":"saved"}';
  withCredentials = false;
  body?: FormData;
  headers: Record<string, string> = {};
  abort = vi.fn(() => this.onabort?.());
  constructor() {
    Request.latest = this;
  }
  open = vi.fn();
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: FormData) {
    this.body = body;
  }
}
afterEach(() => vi.unstubAllGlobals());
describe("upload transport contract", () => {
  it("sends stable file and draft keys, waits for load, and removes abort listener", async () => {
    vi.stubGlobal("XMLHttpRequest", Request);
    setCsrf("qa-csrf");
    const controller = new AbortController(),
      progress = vi.fn();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const result = stageFiles(
      "qa",
      [new File(["proof"], "one.txt")],
      progress,
      {
        draftId: "qa-draft",
        uploadId: "qa-file",
        signal: controller.signal,
      },
    );
    const request = Request.latest;
    expect(request.body!.get("draft_id")).toBe("qa-draft");
    expect(request.body!.get("upload_id")).toBe("qa-file");
    expect(request.body!.getAll("files")).toHaveLength(1);
    expect(request.headers["X-CSRF-Token"]).toBe("qa-csrf");
    expect(request.withCredentials).toBe(true);
    let resolved = false;
    void result.then(() => {
      resolved = true;
    });
    request.upload.onprogress!({
      lengthComputable: true,
      loaded: 100,
      total: 100,
    });
    await Promise.resolve();
    expect(progress).toHaveBeenCalledWith(100);
    expect(resolved).toBe(false);
    request.onload!();
    expect(await result).toEqual({ id: "saved" });
    expect(remove).toHaveBeenCalled();
    controller.abort();
    expect(request.abort).not.toHaveBeenCalled();
  });
  it("navigation abort cancels the request and rejects without a saved result", async () => {
    vi.stubGlobal("XMLHttpRequest", Request);
    const controller = new AbortController();
    const result = stageFiles("qa", [new File(["proof"], "one.txt")], vi.fn(), {
      draftId: "qa-draft",
      uploadId: "qa-file",
      signal: controller.signal,
    });
    const rejected = expect(result).rejects.toThrow("上传已取消");
    controller.abort();
    await rejected;
    expect(Request.latest.abort).toHaveBeenCalledOnce();
  });
});
