export const BASE = import.meta.env.BASE_URL.replace(/\/$/, "") + "/api";
let csrf = "";
export function setCsrf(value: string) {
  csrf = value;
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
async function readError(response: Response): Promise<never> {
  const data = await response.json().catch(() => null);
  const message =
    typeof data?.detail === "string"
      ? data.detail
      : response.status === 422
        ? "请检查填写内容和文件格式"
        : `请求失败（${response.status}），请重试`;
  if (response.status === 401)
    window.dispatchEvent(new Event("class:unauthorized"));
  throw new ApiError(message, response.status);
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(BASE + path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(method !== "GET" ? { "X-CSRF-Token": csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) return readError(response);
  return response.json();
}
export type StageOptions = {
  draftId: string;
  uploadId: string;
  signal?: AbortSignal;
};
export function stageFiles<T>(
  task: string,
  files: File[],
  onProgress: (percent: number) => void,
  options?: StageOptions,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (options?.signal?.aborted) {
      reject(new Error("上传已取消"));
      return;
    }
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const cleanup = () => options?.signal?.removeEventListener("abort", abort);
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    xhr.open("POST", BASE + `/tasks/${task}/uploads`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("X-CSRF-Token", csrf);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable)
        onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onerror = () => fail(new Error("网络中断，文件尚未正式提交，请重试"));
    xhr.onabort = () => fail(new Error("上传已取消"));
    xhr.onload = () => {
      cleanup();
      let data;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        reject(new Error("服务器响应异常，请检查连接后重试"));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else {
        if (xhr.status === 401)
          window.dispatchEvent(new Event("class:unauthorized"));
        reject(
          new ApiError(
            typeof data?.detail === "string" ? data.detail : "上传失败，请重试",
            xhr.status,
          ),
        );
      }
    };
    const form = new FormData();
    if (options) {
      form.append("draft_id", options.draftId);
      form.append("upload_id", options.uploadId);
      options.signal?.addEventListener("abort", abort, { once: true });
    }
    files.forEach((file) => form.append("files", file));
    xhr.send(form);
  });
}
export function archiveFilename(title: string) {
  const cleanTitle = title.trim();
  return (
    (cleanTitle.startsWith("示例班级") ? cleanTitle : "示例班级" + cleanTitle)
      .replace(/[\x00-\x1f<>:"/\\|?*]/g, "_")
      .replace(/^[ .]+|[ .]+$/g, "")
      .slice(0, 100) + ".zip"
  );
}
export type DownloadOptions = {
  signal?: AbortSignal;
  onPhase?: (phase: "preparing" | "receiving") => void;
  idleTimeoutMs?: number;
  preparationTimeoutMs?: number;
};
export async function downloadZip(
  task: string,
  title: string,
  includeSelf = true,
  options: DownloadOptions = {},
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancel = () => controller.abort();
  const cancelBody = () => {
    void reader?.cancel().catch(() => {});
  };
  const arm = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) controller.abort();
  try {
    if (controller.signal.aborted)
      throw new DOMException("下载已取消", "AbortError");
    options.onPhase?.("preparing");
    arm(options.preparationTimeoutMs ?? 180000);
    const response = await fetch(
      BASE + `/tasks/${task}/export?include_self=${includeSelf}`,
      { credentials: "same-origin", signal: controller.signal },
    );
    if (!response.ok) return readError(response);
    let filename = archiveFilename(title);
    const encodedName = /filename\*=utf-8''([^;]+)/i.exec(
      response.headers.get("Content-Disposition") || "",
    );
    if (encodedName) {
      try {
        filename = decodeURIComponent(encodedName[1]);
      } catch {
        // Keep a usable class/task name if a proxy corrupts the header encoding.
      }
    }
    options.onPhase?.("receiving");
    const idle = options.idleTimeoutMs ?? 60000;
    arm(idle);
    let blob: Blob;
    if (response.body) {
      reader = response.body.getReader();
      controller.signal.addEventListener("abort", cancelBody, { once: true });
      if (controller.signal.aborted) cancelBody();
      // Let the browser's Blob implementation consume a bounded stream instead
      // of retaining the whole class archive in a JavaScript chunk array.
      const stream = new ReadableStream<Uint8Array>({
        async pull(output) {
          try {
            const part = await reader!.read();
            if (part.done) output.close();
            else {
              if (part.value.byteLength) arm(idle);
              output.enqueue(part.value);
            }
          } catch (error) {
            output.error(error);
          }
        },
        cancel: () => reader!.cancel(),
      });
      blob = await new Response(stream).blob();
    } else {
      blob = await response.blob();
    }
    if (controller.signal.aborted)
      throw new DOMException("下载已取消", "AbortError");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    if (timedOut)
      throw new Error(
        "下载等待超时，请检查网络后重新下载；已提交的材料不受影响",
      );
    if (controller.signal.aborted)
      throw new DOMException("下载已取消，可以重新下载", "AbortError");
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", cancelBody);
    reader?.releaseLock();
  }
}
export function message(error: unknown) {
  if (
    error instanceof TypeError &&
    /Failed to fetch|NetworkError|Load failed|fetch failed/i.test(error.message)
  ) {
    return "网络连接暂时中断，请检查网络后重试。";
  }
  if (error instanceof SyntaxError) {
    return "暂时无法读取服务器响应，请稍后重试。";
  }
  return error instanceof Error ? error.message : "操作失败，请重试";
}
