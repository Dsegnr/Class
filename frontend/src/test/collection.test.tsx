import { expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Tasks from "../Tasks";
import { api } from "../api";
import type { Task, User } from "../types";

vi.mock("../api", () => ({
  api: vi.fn(),
  BASE: "/api",
  downloadZip: vi.fn(),
  stageFiles: vi.fn(),
  message: (e: Error) => e.message,
}));

it("keeps approved students in the submitted count and name list", async () => {
  const admin: User = {
    student_id: "900000000213",
    name: "管理员",
    role: "admin",
    must_change: false,
    csrf: "qa",
  };
  const task: Task = {
    id: "collection",
    title: "材料收集",
    description: "",
    state: "published",
    deadline: null,
    targets: ["111111111111", "222222222222", "333333333333"],
    max_files: 5,
    max_bytes: 104857600,
    allow_late: false,
    review_required: true,
    extensions: [],
    created: 1,
  };
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/tasks") return [task] as never;
    if (path === "/tasks/collection/submissions") return [] as never;
    if (path === "/tasks/collection/roster")
      return [
        {
          student_id: "111111111111",
          name: "已提交同学",
          status: "submitted",
          submission_id: "one",
        },
        {
          student_id: "222222222222",
          name: "审核通过同学",
          status: "approved",
          submission_id: "two",
        },
        {
          student_id: "333333333333",
          name: "未提交同学",
          status: "missing",
          submission_id: null,
        },
      ] as never;
    throw new Error("Unexpected request: " + path);
  });
  const user = userEvent.setup();
  render(<Tasks user={admin} toast={vi.fn()} />);
  await user.click(await screen.findByRole("button", { name: /^材料收集/ }));
  await user.click(await screen.findByRole("button", { name: /^2\s*已交$/ }));
  const list = screen.getByRole("dialog", { name: "已交名单 · 2人" });
  expect(within(list).getByText("已提交同学")).toBeInTheDocument();
  expect(within(list).getByText("审核通过同学")).toBeInTheDocument();
  expect(within(list).queryByText("未提交同学")).not.toBeInTheDocument();
  await user.click(within(list).getByRole("button", { name: "关闭弹窗" }));
  await user.click(screen.getByRole("button", { name: /^1\s*已通过$/ }));
  expect(
    screen.getByRole("dialog", { name: "已通过名单 · 1人" }),
  ).toBeInTheDocument();
});
