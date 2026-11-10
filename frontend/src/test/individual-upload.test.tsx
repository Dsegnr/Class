import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import UploadPanel from "../UploadPanel";
import { api, stageFiles, type StageOptions } from "../api";
import type { Attachment, Submission, Task } from "../types";

vi.mock("../api", () => ({
  api: vi.fn(),
  stageFiles: vi.fn(),
  message: (e: Error) => e.message,
}));
const task: Task = {
  id: "qa",
  title: "逐件材料",
  description: "",
  state: "published",
  deadline: null,
  targets: ["123456789012"],
  max_files: 5,
  max_bytes: 10485760,
  extensions: [],
  allow_late: false,
  review_required: false,
  created: 1,
};
let stored: Attachment[];
function saved(file: File, options: StageOptions): Submission {
  if (!stored.some((item) => item.id === options.uploadId))
    stored.push({
      id: options.uploadId,
      name: file.name,
      size: file.size,
      extension: "txt",
      sha256: "qa",
    });
  return {
    id: options.draftId,
    task_id: task.id,
    student_id: "123456789012",
    status: "draft",
    created: 1,
    submitted: null,
    note: "",
    files: [...stored],
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  stored = [];
});
afterEach(() => vi.unstubAllGlobals());

describe("individual upload queue", () => {
  it("can upload in embedded browsers without randomUUID using secure random bytes", async () => {
    vi.stubGlobal("crypto", {
      getRandomValues: crypto.getRandomValues.bind(crypto),
    });
    const user = userEvent.setup();
    vi.mocked(stageFiles).mockImplementation(
      async (_task, files, _progress, options) =>
        saved(files[0], options!) as never,
    );
    const { container } = render(
      <UploadPanel task={task} onSubmitted={vi.fn()} />,
    );
    await user.upload(
      container.querySelector("input[type=file]")!,
      new File(["one"], "one.txt"),
    );
    await user.click(screen.getByRole("button", { name: "上传 1 件文件" }));
    await screen.findByRole("button", { name: "确认提交" });
    const options = vi.mocked(stageFiles).mock.calls[0][3]!;
    const v4 =
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
    expect(options.draftId).toMatch(v4);
    expect(options.uploadId).toMatch(v4);
    expect(options.draftId).not.toBe(options.uploadId);
  });
  it("keeps the first success and retries only the failed file with identical keys", async () => {
    const user = userEvent.setup(),
      submitted = vi.fn(),
      changed = vi.fn();
    let failSecond = true;
    vi.mocked(stageFiles).mockImplementation(
      async (_task, files, progress, options) => {
        progress(100);
        if (files[0].name === "two.txt" && failSecond) {
          failSecond = false;
          throw new Error("连接中断");
        }
        return saved(files[0], options!) as never;
      },
    );
    vi.mocked(api).mockResolvedValue({ status: "submitted" });
    const { container } = render(
      <UploadPanel
        task={task}
        onSubmitted={submitted}
        onDraftsChanged={changed}
      />,
    );
    await user.upload(container.querySelector("input[type=file]")!, [
      new File(["one"], "one.txt"),
      new File(["two"], "two.txt"),
    ]);
    await user.click(screen.getByRole("button", { name: "上传 2 件文件" }));
    await screen.findByText("连接中断");
    expect(screen.getByRole("status")).toHaveTextContent("已保存 1 / 2 件");
    expect(
      screen.queryByRole("button", { name: "确认提交" }),
    ).not.toBeInTheDocument();
    const second = vi.mocked(stageFiles).mock.calls[1];
    await user.click(screen.getByRole("button", { name: "重试two.txt" }));
    await screen.findByRole("button", { name: "确认提交" });
    const retried = vi.mocked(stageFiles).mock.calls[2];
    expect(retried[1][0]).toBe(second[1][0]);
    expect(retried[3]!.draftId).toBe(second[3]!.draftId);
    expect(retried[3]!.uploadId).toBe(second[3]!.uploadId);
    expect(
      vi
        .mocked(stageFiles)
        .mock.calls.filter((call) => call[1][0].name === "one.txt"),
    ).toHaveLength(1);
    expect(submitted).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "确认提交" }));
    await waitFor(() => expect(submitted).toHaveBeenCalledOnce());
    expect(api).toHaveBeenCalledWith(
      `/submissions/${second[3]!.draftId}/submit`,
      "POST",
    );
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("100 percent transmitted still waits for the server before offering confirmation", async () => {
    const user = userEvent.setup();
    let finish!: () => void;
    vi.mocked(stageFiles).mockImplementation(
      (_task, files, progress, options) => {
        progress(100);
        return new Promise((resolve) => {
          finish = () => resolve(saved(files[0], options!));
        }) as never;
      },
    );
    const { container } = render(
      <UploadPanel task={task} onSubmitted={vi.fn()} />,
    );
    await user.upload(
      container.querySelector("input[type=file]")!,
      new File(["one"], "one.txt"),
    );
    await user.click(screen.getByRole("button", { name: "上传 1 件文件" }));
    await screen.findByText("传输完成，正在保存…");
    expect(
      screen.getByRole("progressbar", { name: "one.txt传输进度" }),
    ).toHaveValue(100);
    expect(
      screen.queryByRole("button", { name: "确认提交" }),
    ).not.toBeInTheDocument();
    await act(async () => finish());
    await screen.findByRole("button", { name: "确认提交" });
  });

  it("aborts the in-flight request when leaving the page and never confirms automatically", async () => {
    const user = userEvent.setup(),
      submitted = vi.fn(),
      changed = vi.fn();
    let signal!: AbortSignal, finish!: () => void;
    vi.mocked(stageFiles).mockImplementation(
      (_task, files, _progress, options) => {
        signal = options!.signal!;
        return new Promise((resolve) => {
          finish = () => resolve(saved(files[0], options!));
        }) as never;
      },
    );
    const { container, unmount } = render(
      <UploadPanel
        task={task}
        onSubmitted={submitted}
        onDraftsChanged={changed}
      />,
    );
    await user.upload(
      container.querySelector("input[type=file]")!,
      new File(["one"], "one.txt"),
    );
    await user.click(screen.getByRole("button", { name: "上传 1 件文件" }));
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => finish());
    expect(submitted).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
  });

  it("does not silently accept a response for a different draft", async () => {
    const user = userEvent.setup();
    vi.mocked(stageFiles).mockImplementation(
      async (_task, files, _progress, options) =>
        ({ ...saved(files[0], options!), id: "different" }) as never,
    );
    const { container } = render(
      <UploadPanel task={task} onSubmitted={vi.fn()} />,
    );
    await user.upload(
      container.querySelector("input[type=file]")!,
      new File(["one"], "one.txt"),
    );
    await user.click(screen.getByRole("button", { name: "上传 1 件文件" }));
    await screen.findByText(/暂时无法确认这件文件已完整保存/);
    expect(
      screen.queryByRole("button", { name: "确认提交" }),
    ).not.toBeInTheDocument();
  });
});
