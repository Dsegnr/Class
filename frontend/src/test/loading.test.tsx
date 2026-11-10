import { beforeEach, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Tasks from "../Tasks";
import { api } from "../api";
import type { StatusRow, Task, User } from "../types";

vi.mock("../api", () => ({
  api: vi.fn(),
  BASE: "/api",
  downloadZip: vi.fn(),
  stageFiles: vi.fn(),
  message: (e: Error) => e.message,
}));
beforeEach(() => vi.clearAllMocks());

const admin: User = {
  student_id: "900000000213",
  name: "管理员",
  role: "admin",
  must_change: false,
  csrf: "test",
};
const task: Task = {
  id: "loading",
  title: "延迟读取任务",
  description: "",
  state: "published",
  deadline: null,
  targets: ["111111111111"],
  max_files: 5,
  max_bytes: 104857600,
  allow_late: false,
  review_required: false,
  extensions: [],
  created: 1,
};
const rows: StatusRow[] = [
  {
    student_id: "111111111111",
    name: "测试同学",
    status: "missing",
    submission_id: null,
  },
];

it("does not display zero statistics or empty history before the detail response arrives", async () => {
  let finish!: (value: StatusRow[]) => void;
  const delayed = new Promise<StatusRow[]>((resolve) => {
    finish = resolve;
  });
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/tasks") return [task] as never;
    if (path.endsWith("/roster")) return delayed as never;
    return [] as never;
  });
  const user = userEvent.setup();
  render(<Tasks user={admin} toast={vi.fn()} />);
  await user.click(
    await screen.findByRole("button", { name: /^延迟读取任务/ }),
  );
  expect(screen.getByText("正在读取提交情况")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /^0\s*未交$/ }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("暂时没有正式提交记录。")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "选择文件" }),
  ).not.toBeInTheDocument();
  await act(async () => finish(rows));
  expect(
    await screen.findByRole("button", { name: /^1\s*未交$/ }),
  ).toBeInTheDocument();
  expect(screen.getByText("暂时没有正式提交记录。")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "选择文件" })).toBeInTheDocument();
});

it("shows a failed initial detail request honestly and recovers on retry", async () => {
  let fail = true;
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/tasks") return [task] as never;
    if (path.endsWith("/roster")) {
      if (fail) throw new Error("网络暂时中断");
      return rows as never;
    }
    return [] as never;
  });
  const user = userEvent.setup();
  render(<Tasks user={admin} toast={vi.fn()} />);
  await user.click(
    await screen.findByRole("button", { name: /^延迟读取任务/ }),
  );
  expect(await screen.findByText("暂时无法读取提交情况")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /^0\s*未交$/ }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("暂时没有正式提交记录。")).not.toBeInTheDocument();
  fail = false;
  await user.click(screen.getByRole("button", { name: "重试" }));
  expect(
    await screen.findByRole("button", { name: /^1\s*未交$/ }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("does not turn a failed task list request into an empty class", async () => {
  vi.mocked(api).mockRejectedValue(new Error("网络暂时中断"));
  render(<Tasks user={admin} toast={vi.fn()} />);
  await screen.findByRole("alert");
  expect(screen.getByText("暂未读取")).toBeInTheDocument();
  expect(screen.queryByText("0 个任务")).not.toBeInTheDocument();
  expect(screen.queryByText("这里还没有任务")).not.toBeInTheDocument();
});
