import { expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ExportDialog, { exportContents } from "../ExportDialog";
import { api, downloadZip } from "../api";
import type { Submission, Task, User } from "../types";

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  api: vi.fn(),
  downloadZip: vi.fn(),
}));
const admin: User = {
  student_id: "admin",
  name: "管理员",
  role: "admin",
  must_change: false,
  csrf: "qa",
};
const task: Task = {
  id: "task",
  title: "职业规划比赛报名截图",
  targets: ["a", "b", "c"],
  state: "published",
  description: "",
  deadline: null,
  max_files: 20,
  max_bytes: 104857600,
  allow_late: false,
  review_required: true,
  extensions: [],
  created: 1,
};
function submission(
  id: string,
  student_id: string,
  submitted: number | null,
  status: Submission["status"],
  sizes: number[],
): Submission {
  return {
    id,
    student_id,
    task_id: task.id,
    submitted,
    status,
    created: 1,
    note: "",
    files: sizes.map((size, i) => ({
      id: id + i,
      name: "截图.png",
      size,
      extension: "png",
      sha256: "qa",
    })),
  };
}
const records = [
  submission("a-old", "a", 1, "submitted", [11]),
  submission("a-unconfirmed", "a", null, "draft", [99]),
  submission("b-approved", "b", 2, "approved", [20, 30]),
  submission("c-old", "c", 1, "submitted", [7]),
  submission("c-returned", "c", 3, "returned", [8]),
  submission("outside", "other", 4, "submitted", [12]),
  submission("self", "admin", 5, "submitted", [40]),
];

it("counts approved and confirmed material without reviving returned versions or including drafts and outsiders", () => {
  expect(exportContents(records, task, "admin", true)).toEqual({
    students: 2,
    self: true,
    files: 4,
    size: 101,
  });
  expect(exportContents(records, task, "admin", false)).toEqual({
    students: 2,
    self: false,
    files: 3,
    size: 61,
  });
  const tied = [
    submission("a", "a", 1, "submitted", [1]),
    submission("z", "a", 1, "returned", [2]),
  ];
  expect(exportContents(tied, task, "admin", false).files).toBe(0);
});

it("excludes withdrawn latest versions without reviving old material, including the admin", () => {
  const withdrawn = [
    ...records,
    submission("a-withdrawn", "a", 6, "withdrawn", [11]),
    submission("b-withdrawn", "b", 7, "withdrawn", [20]),
    submission("self-withdrawn", "admin", 8, "withdrawn", [40]),
  ];
  expect(exportContents(withdrawn, task, "admin", true)).toEqual({
    students: 0,
    self: false,
    files: 0,
    size: 0,
  });
  expect(
    exportContents(
      [...withdrawn, submission("a-new", "a", 9, "submitted", [5])],
      task,
      "admin",
      true,
    ),
  ).toEqual({ students: 1, self: false, files: 1, size: 5 });
});

it("waits for fresh records, previews the class filename, and passes the selected self option to download", async () => {
  let resolve!: (value: Submission[]) => void;
  vi.mocked(api).mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }) as never,
  );
  vi.mocked(downloadZip).mockResolvedValue(undefined);
  const onClose = vi.fn(),
    toast = vi.fn(),
    user = userEvent.setup();
  render(
    <ExportDialog task={task} user={admin} onClose={onClose} toast={toast} />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("正在读取");
  expect(screen.getByRole("button", { name: "下载压缩包" })).toBeDisabled();
  expect(screen.queryByLabelText("当前导出范围")).not.toBeInTheDocument();
  await act(async () => resolve(records));
  expect(
    screen.getByText("示例班级职业规划比赛报名截图.zip"),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("当前导出范围")).toHaveTextContent(
    "2 人本人材料已包含文件数量4 件",
  );
  await user.click(
    screen.getByRole("checkbox", { name: "包含我在管理员端提交的材料" }),
  );
  expect(screen.getByLabelText("当前导出范围")).toHaveTextContent(
    "未包含文件数量3 件",
  );
  await user.click(screen.getByRole("button", { name: "下载压缩包" }));
  expect(downloadZip).toHaveBeenCalledWith(
    "task",
    "职业规划比赛报名截图",
    false,
    expect.objectContaining({ signal: expect.any(AbortSignal), onPhase: expect.any(Function) }),
  );
  expect(toast).toHaveBeenCalledWith("材料已打包下载");
  expect(onClose).toHaveBeenCalledOnce();
});

it("shows a read failure with refresh and never offers an empty archive as successful", async () => {
  vi.mocked(api)
    .mockRejectedValueOnce(new Error("读取失败"))
    .mockResolvedValueOnce([] as never);
  const user = userEvent.setup();
  render(
    <ExportDialog task={task} user={admin} onClose={vi.fn()} toast={vi.fn()} />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("读取失败");
  expect(screen.getByRole("button", { name: "下载压缩包" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "刷新范围" }));
  expect(
    await screen.findByText("当前范围还没有可下载的材料，可稍后刷新。"),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "下载压缩包" })).toBeDisabled();
  expect(
    within(screen.getByRole("dialog")).queryByRole("alert"),
  ).not.toBeInTheDocument();
});
