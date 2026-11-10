import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import WithdrawSubmission from "../WithdrawSubmission";
import Tasks from "../Tasks";
import { api } from "../api";
import type { Submission, Task, User } from "../types";

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  api: vi.fn(),
}));
const student: User = {
  student_id: "123456789012",
  name: "测试同学",
  role: "student",
  must_change: false,
  csrf: "qa",
};
const record: Submission = {
  id: "receipt",
  task_id: "qa-task",
  student_id: student.student_id,
  status: "submitted",
  created: 1,
  submitted: 1,
  note: "",
  files: [
    { id: "file", name: "proof.txt", extension: "txt", size: 4, sha256: "qa" },
  ],
};
beforeEach(() => vi.resetAllMocks());

it("requires explicit confirmation and cancellation does not withdraw", async () => {
  const user = userEvent.setup(),
    done = vi.fn();
  render(<WithdrawSubmission submission={record} onWithdrawn={done} />);
  await user.click(screen.getByRole("button", { name: "撤回提交" }));
  expect(screen.getByText(/撤回后，你将进入未交名单/)).toBeInTheDocument();
  expect(api).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "保留提交" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(done).not.toHaveBeenCalled();
  expect(api).not.toHaveBeenCalled();
});

it("keeps errors in the confirmation dialog and retries the same receipt", async () => {
  const user = userEvent.setup(),
    done = vi.fn();
  vi.mocked(api)
    .mockRejectedValueOnce(new Error("连接中断，请重试"))
    .mockResolvedValueOnce({ ...record, status: "withdrawn" });
  render(<WithdrawSubmission submission={record} onWithdrawn={done} />);
  await user.click(screen.getByRole("button", { name: "撤回提交" }));
  await user.click(screen.getByRole("button", { name: "确认撤回" }));
  await screen.findByRole("alert");
  expect(done).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "确认撤回" }));
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(vi.mocked(api).mock.calls).toEqual([
    ["/submissions/receipt/withdraw", "POST"],
    ["/submissions/receipt/withdraw", "POST"],
  ]);
});

it("disables actions while waiting and does not report success before the response", async () => {
  const user = userEvent.setup(),
    done = vi.fn();
  let finish!: () => void;
  vi.mocked(api).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ ...record, status: "withdrawn" });
      }) as never,
  );
  render(<WithdrawSubmission submission={record} onWithdrawn={done} />);
  await user.click(screen.getByRole("button", { name: "撤回提交" }));
  await user.click(screen.getByRole("button", { name: "确认撤回" }));
  expect(screen.getByRole("button", { name: "正在撤回…" })).toBeDisabled();
  expect(done).not.toHaveBeenCalled();
  await act(async () => finish());
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
});

it("refreshes task detail into a withdrawn receipt while preserving history links", async () => {
  const user = userEvent.setup(),
    toast = vi.fn();
  const task: Task = {
    id: record.task_id,
    title: "撤回验收任务",
    description: "",
    state: "published",
    deadline: null,
    targets: [student.student_id],
    max_files: 5,
    max_bytes: 100000,
    extensions: [],
    allow_late: false,
    review_required: false,
    created: 1,
  };
  let current = { ...record };
  vi.mocked(api).mockImplementation(async (path, method) => {
    if (path === "/tasks")
      return [{ ...task, my_status: current.status }] as never;
    if (path === `/tasks/${task.id}/submissions`) return [current] as never;
    if (path === `/submissions/${record.id}/withdraw` && method === "POST") {
      current = { ...current, status: "withdrawn" };
      return current as never;
    }
    throw new Error("unexpected QA request");
  });
  render(<Tasks user={student} toast={toast} />);
  await user.click(await screen.findByRole("button", { name: /撤回验收任务/ }));
  await screen.findByText("已收到你的材料");
  await user.click(screen.getByRole("button", { name: "撤回提交" }));
  await user.click(screen.getByRole("button", { name: "确认撤回" }));
  await screen.findByText("这次提交已撤回");
  expect(screen.getByRole("link", { name: "proof.txt" })).toHaveAttribute(
    "href",
    "/api/files/file",
  );
  expect(
    screen.queryByRole("button", { name: "撤回提交" }),
  ).not.toBeInTheDocument();
  expect(toast).toHaveBeenCalledWith("提交已撤回，原文件和回执仍保留");
});
