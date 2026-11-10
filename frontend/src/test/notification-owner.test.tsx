import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import App from "../App";
import { api } from "../api";
import type { Notice, User } from "../types";

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  api: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("never shows a delayed private notification from the previous account after sign-in switches", async () => {
  vi.stubGlobal("EventSource", undefined);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const first: User = {
    student_id: "111111111111",
    name: "测试甲",
    role: "student",
    must_change: false,
    csrf: "one",
  };
  const second: User = {
    ...first,
    student_id: "222222222222",
    name: "测试乙",
    csrf: "two",
  };
  let finish!: (rows: Notice[]) => void;
  let notificationReads = 0;
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/auth/me") return first as never;
    if (path === "/tasks") return [] as never;
    if (path === "/auth/login") return second as never;
    if (path === "/notifications") {
      notificationReads++;
      if (notificationReads === 1)
        return (await new Promise<Notice[]>((resolve) => {
          finish = resolve;
        })) as never;
      return [] as never;
    }
    throw new Error("Unexpected path " + path);
  });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("button", { name: /测试甲/ });
  act(() => window.dispatchEvent(new Event("class:unauthorized")));
  await user.type(screen.getByLabelText("学号"), second.student_id);
  await user.type(screen.getByLabelText("密码"), "local-test-fixture-password");
  await user.click(screen.getByRole("button", { name: "进入班级空间" }));
  await screen.findByRole("button", { name: /测试乙/ });
  await act(async () =>
    finish([
      {
        id: "old",
        title: "旧账号私有通知",
        body: "不应显示",
        created: 1,
        read: false,
      } as Notice,
    ]),
  );
  await user.click(screen.getByRole("button", { name: "通知" }));
  expect(screen.getByText("暂时没有通知。")).toBeInTheDocument();
  expect(screen.queryByText("旧账号私有通知")).not.toBeInTheDocument();
});
