import { expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ExportDialog from "../ExportDialog";
import { api, downloadZip } from "../api";
import type { Task, User } from "../types";

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  api: vi.fn(),
  downloadZip: vi.fn(),
}));
const task: Task = {
  id: "task",
  title: "截图",
  targets: ["s"],
  state: "published",
  description: "",
  deadline: null,
  max_files: 2,
  max_bytes: 1000,
  allow_late: false,
  review_required: false,
  extensions: [],
  created: 1,
};
const admin: User = {
  student_id: "a",
  name: "管理员",
  role: "admin",
  csrf: "qa",
  must_change: false,
};
function records() {
  vi.mocked(api).mockResolvedValue([
    {
      id: "sub",
      task_id: "task",
      student_id: "s",
      status: "submitted",
      created: 1,
      submitted: 1,
      note: "",
      files: [
        { id: "f", name: "图.jpg", extension: "jpg", size: 10, sha256: "qa" },
      ],
    },
  ] as never);
}

it("cancels a pending download and permits a new attempt without a false success", async () => {
  records();
  let signal: AbortSignal | undefined;
  vi.mocked(downloadZip).mockImplementation(
    (_id, _title, _self, options) =>
      new Promise((_resolve, reject) => {
        signal = options?.signal;
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        );
      }),
  );
  const toast = vi.fn(),
    close = vi.fn(),
    user = userEvent.setup();
  render(
    <ExportDialog task={task} user={admin} onClose={close} toast={toast} />,
  );
  await screen.findByText("1 件");
  await user.click(screen.getByRole("button", { name: "下载压缩包" }));
  expect(signal).toBeDefined();
  await user.click(screen.getByRole("button", { name: "取消下载" }));
  expect(signal?.aborted).toBe(true);
  expect(
    await screen.findByRole("button", { name: "下载压缩包" }),
  ).toBeEnabled();
  expect(toast).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  vi.mocked(downloadZip).mockResolvedValue(undefined);
  await user.click(screen.getByRole("button", { name: "下载压缩包" }));
  expect(toast).toHaveBeenCalledWith("材料已打包下载");
});

it("aborts its request when the dialog is unmounted", async () => {
  records();
  let signal: AbortSignal | undefined;
  vi.mocked(downloadZip).mockImplementation(
    (_id, _title, _self, options) =>
      new Promise((_resolve, reject) => {
        signal = options?.signal;
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        );
      }),
  );
  const toast = vi.fn(),
    user = userEvent.setup();
  const view = render(
    <ExportDialog task={task} user={admin} onClose={vi.fn()} toast={toast} />,
  );
  await screen.findByText("1 件");
  await user.click(screen.getByRole("button", { name: "下载压缩包" }));
  expect(signal).toBeDefined();
  view.unmount();
  expect(signal?.aborted).toBe(true);
  expect(toast).not.toHaveBeenCalled();
});

it("permits direct retry after a download timeout", async () => {
  records();
  vi.mocked(downloadZip).mockRejectedValueOnce(new Error("下载等待超时，请重新下载"));
  const user = userEvent.setup(), toast = vi.fn();
  render(<ExportDialog task={task} user={admin} onClose={vi.fn()} toast={toast} />);
  await screen.findByText("1 件");
  await user.click(screen.getByRole("button", { name: "下载压缩包" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("超时");
  expect(screen.getByRole("button", { name: "下载压缩包" })).toBeEnabled();
  vi.mocked(downloadZip).mockResolvedValueOnce(undefined);
  await user.click(screen.getByRole("button", { name: "下载压缩包" }));
  expect(toast).toHaveBeenCalledWith("材料已打包下载");
});
