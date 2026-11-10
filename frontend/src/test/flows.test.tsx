import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App";
import { Login } from "../auth";
import { TaskEditor, UploadPanel } from "../Tasks";
import AccountManager from "../AccountManager";
import type { Submission, Task } from "../types";
import { api, stageFiles } from "../api";

vi.mock("../api", () => ({
  api: vi.fn(),
  stageFiles: vi.fn(),
  setCsrf: vi.fn(),
  message: (e: Error) => e.message,
  BASE: "/api",
  downloadZip: vi.fn(),
}));
const task: Task = {
  id: "qa-task",
  title: "测试材料",
  description: "",
  state: "published",
  deadline: null,
  targets: ["123456789012"],
  max_files: 5,
  max_bytes: 104857600,
  allow_late: false,
  review_required: false,
  extensions: [],
  created: 1,
};
const staged: Submission = {
  id: "receipt-1",
  task_id: task.id,
  student_id: "123456789012",
  status: "draft",
  note: "",
  created: 1,
  submitted: null,
  files: [
    { id: "f1", name: "proof.txt", size: 5, extension: "txt", sha256: "test" },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("critical user flows", () => {
  it("recovers an uploaded draft without uploading the same files again", async () => {
    const user = userEvent.setup(),
      onSubmitted = vi.fn();
    vi.mocked(api).mockResolvedValue({ ...staged, status: "submitted" });
    render(
      <UploadPanel task={task} drafts={[staged]} onSubmitted={onSubmitted} />,
    );
    await user.click(screen.getByText("有 1 次上传尚未确认提交"));
    await user.click(screen.getByRole("button", { name: "继续确认" }));
    expect(screen.getByText("proof.txt")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认提交" }));
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledOnce());
    expect(stageFiles).not.toHaveBeenCalled();
    expect(api).toHaveBeenCalledWith("/submissions/receipt-1/submit", "POST");
  });

  it("requires reset confirmation and clears the temporary password on close", async () => {
    const user = userEvent.setup();
    vi.mocked(api).mockImplementation(async (path) =>
      path === "/members"
        ? ([{ student_id: "123456789012", name: "测试同学" }] as never)
        : ({ temporary_password: "qa-temporary-only" } as never),
    );
    render(<AccountManager toast={vi.fn()} />);
    await user.click(screen.getByText(/学生账号管理/));
    await user.click(await screen.findByRole("button", { name: /^重置$/ }));
    expect(
      vi.mocked(api).mock.calls.some((call) => call[0].includes("/reset")),
    ).toBe(false);
    await user.click(screen.getByRole("button", { name: "确认重置密码" }));
    await screen.findByDisplayValue("qa-temporary-only");
    await user.click(screen.getByText(/学生账号管理/));
    await waitFor(() =>
      expect(
        screen.queryByDisplayValue("qa-temporary-only"),
      ).not.toBeInTheDocument(),
    );
  });
  it("uses a dedicated key-only admin login", async () => {
    const user = userEvent.setup(),
      onLogin = vi.fn();
    vi.mocked(api).mockResolvedValue({
      student_id: "admin",
      name: "管理员",
      role: "admin",
      must_change: false,
      csrf: "csrf",
    });
    render(<Login onLogin={onLogin} />);
    await user.click(screen.getByRole("button", { name: "管理员密钥登录" }));
    expect(screen.queryByLabelText("学号")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("管理密钥"), "qa-only-key");
    await user.click(screen.getByRole("button", { name: "进入班级空间" }));
    expect(api).toHaveBeenCalledWith("/auth/admin", "POST", {
      key: "qa-only-key",
    });
    expect(onLogin).toHaveBeenCalledOnce();
  });

  it("save and publish preserves the clicked submit intent", async () => {
    const user = userEvent.setup(),
      onSaved = vi.fn();
    vi.mocked(api).mockImplementation(async (path, method) => {
      if (path === "/members")
        return [{ student_id: "123456789012", name: "测试同学" }] as never;
      if (path === "/tasks" && method === "POST")
        return { ...task, state: "draft" } as never;
      return task as never;
    });
    render(<TaskEditor onSaved={onSaved} />);
    await user.type(screen.getByLabelText("任务名称"), "测试任务");
    await user.click(screen.getByRole("button", { name: "保存并发布" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/tasks/qa-task/state", "POST", {
        state: "published",
      }),
    );
    expect(onSaved).toHaveBeenCalledWith("qa-task");
  });

  it("upload alone is not counted as submitted; final retry keeps same receipt", async () => {
    const user = userEvent.setup(),
      onSubmitted = vi.fn();
    vi.mocked(stageFiles).mockImplementation(
      async (_task, _files, _progress, options) =>
        ({
          ...staged,
          id: options!.draftId,
          files: [{ ...staged.files[0], id: options!.uploadId }],
        }) as never,
    );
    vi.mocked(api)
      .mockRejectedValueOnce(new Error("网络中断"))
      .mockResolvedValueOnce({ ...staged, status: "submitted" });
    const { container } = render(
      <UploadPanel task={task} onSubmitted={onSubmitted} />,
    );
    const input = container.querySelector(
      "input[type=file]",
    ) as HTMLInputElement;
    await user.upload(
      input,
      new File(["proof"], "proof.txt", { type: "text/plain" }),
    );
    await user.click(screen.getByRole("button", { name: "上传 1 件文件" }));
    await screen.findByRole("button", { name: "确认提交" });
    const receipt = vi.mocked(stageFiles).mock.calls[0][3]!.draftId;
    expect(onSubmitted).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "确认提交" }));
    await screen.findByRole("alert");
    expect(onSubmitted).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "确认提交" }));
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledOnce());
    expect(stageFiles).toHaveBeenCalledTimes(1);
    expect(
      vi
        .mocked(api)
        .mock.calls.filter(
          (call) => call[0] === `/submissions/${receipt}/submit`,
        ),
    ).toHaveLength(2);
  });

  it("rejects oversized files before sending any upload", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <UploadPanel task={{ ...task, max_bytes: 3 }} onSubmitted={vi.fn()} />,
    );
    await user.upload(
      container.querySelector("input[type=file]") as HTMLInputElement,
      new File(["1234"], "large.txt"),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("单件文件不能超过");
    expect(stageFiles).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "上传 1 件文件" }),
    ).not.toBeInTheDocument();
  });
});

it("initial-password account enters tasks without a forced change screen", async () => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/auth/me")
      return {
        student_id: "123456789012",
        name: "测试同学",
        role: "student",
        must_change: true,
        csrf: "qa",
      } as never;
    return [] as never;
  });
  render(<App />);
  await screen.findByRole("heading", { name: "班级任务" });
  expect(
    screen
      .getAllByRole("button", { name: "活动抽签" })
      .every((button) => !button.hasAttribute("disabled")),
  ).toBe(true);
  expect(screen.queryByText("先设置一个自己的密码")).not.toBeInTheDocument();
});
