import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Draw from "../Draw";
import { api, ApiError } from "../api";
import type { DrawState, User } from "../types";

vi.mock("../api", async (original) => {
  const actual = await original<typeof import("../api")>();
  return { ...actual, api: vi.fn() };
});
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "student polling reveals committed results with reduced-motion=%s without starting a draw",
  async (reduce) => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: reduce })),
    );
    const people = Array.from({ length: 24 }, (_, i) => ({
      student_id: String(i).padStart(12, "0"),
      name: `测试同学${i}`,
    }));
    const baseline: DrawState = {
      eligible: people,
      excluded: [],
      selected: [],
      events: [],
      algorithm: "qa",
      pool_version: "a".repeat(64),
    };
    const result = {
      id: "committed-result",
      kind: "draw",
      created: 1,
      payload: { winners: [people[0]], pool: people, count: 1 },
    };
    let reads = 0;
    vi.mocked(api).mockImplementation(async (path, method) => {
      if (method === "POST") throw new Error("Student must never start a draw");
      if (path === "/members") return people as never;
      return (
        reads++ === 0
          ? baseline
          : {
              ...baseline,
              eligible: people.slice(1),
              selected: [people[0].student_id],
              events: [result],
            }
      ) as never;
    });
    const student: User = {
      ...people[1],
      role: "student",
      must_change: false,
      csrf: "qa",
    };
    render(<Draw user={student} toast={vi.fn()} />);
    await act(async () => {});
    expect(
      screen.getByRole("heading", { name: "活动抽签" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "开始抽签" }),
    ).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    if (reduce) {
      expect(
        screen.queryByRole("heading", { name: "正在揭晓" }),
      ).not.toBeInTheDocument();
    } else {
      expect(
        screen.getByRole("heading", { name: "正在揭晓" }),
      ).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
    }
    expect(
      screen.getByRole("heading", { name: people[0].name }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "候选名单 · 23人" }),
    ).toBeInTheDocument();
    expect(vi.mocked(api).mock.calls.some((call) => call[1] === "POST")).toBe(
      false,
    );
  },
);

it("requires a fresh candidate snapshot after another window changes the pool", async () => {
  const user = userEvent.setup(),
    toast = vi.fn();
  const admin: User = {
    student_id: "900000000213",
    name: "测试管理员",
    role: "admin",
    must_change: false,
    csrf: "test",
  };
  const state = (count: number): DrawState => ({
    pool_version: String(count).padStart(64, "0"),
    eligible: Array.from({ length: count }, (_, i) => ({
      student_id: String(i).padStart(12, "0"),
      name: `测试${i}`,
    })),
    excluded: [],
    selected: [],
    events: [],
    algorithm: "test",
  });
  let reads = 0;
  vi.mocked(api).mockImplementation(async (path, method) => {
    if (path === "/members") return [] as never;
    if (path === "/draw" && method === "POST")
      throw new ApiError("候选名单已变化，请刷新后重新确认抽签", 409);
    if (path === "/draw") return state(reads++ === 0 ? 24 : 21) as never;
    throw new Error("Unexpected request");
  });
  render(<Draw user={admin} toast={toast} />);
  await screen.findByRole("button", { name: "候选名单 · 24人" });
  expect(screen.getByRole("button", { name: "开始抽签" })).toBeDisabled();
  await user.type(screen.getByLabelText("活动需要人数"), "3");
  await user.click(screen.getByRole("button", { name: "开始抽签" }));
  await user.click(screen.getByRole("button", { name: "确认抽取 3 人" }));
  await waitFor(() =>
    expect(toast).toHaveBeenCalledWith("候选名单已变化，请刷新后重新确认抽签"),
  );
  expect(
    screen.getByRole("button", { name: "候选名单 · 21人" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "开始抽签" })).toBeEnabled();
  expect(
    screen.queryByRole("button", { name: "重试上一次抽签" }),
  ).not.toBeInTheDocument();
  const request = vi
    .mocked(api)
    .mock.calls.find((call) => call[0] === "/draw" && call[1] === "POST");
  expect(request?.[2]).toMatchObject({
    count: 3,
    expected_pool: String(24).padStart(64, "0"),
  });
});

it("shows a waiting state and all 13 participants without choosing a future draw size", async () => {
  const members = Array.from({ length: 37 }, (_, i) => ({
    student_id: String(i).padStart(12, "0"),
    name: `同学${i}`,
  }));
  const baseline: DrawState = {
    pool_version: "a".repeat(64),
    eligible: members.slice(13),
    excluded: members.slice(0, 10).map((p) => p.student_id),
    selected: members.slice(10, 13).map((p) => p.student_id),
    events: [],
    algorithm: "test",
  };
  vi.mocked(api).mockImplementation(
    async (path) => (path === "/members" ? members : baseline) as never,
  );
  const actor: User = {
    ...members[13],
    role: "admin",
    must_change: false,
    csrf: "qa",
  };
  render(<Draw user={actor} toast={vi.fn()} />);
  await screen.findByRole("heading", { name: "等待下一次抽签" });
  expect(screen.getByLabelText("活动需要人数")).toHaveValue(null);
  expect(screen.getByRole("button", { name: "开始抽签" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: /已参与（本轮免抽）13人/ }),
  ).toBeInTheDocument();
  expect(vi.mocked(api).mock.calls.some((call) => call[1] === "POST")).toBe(
    false,
  );
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: /已参与（本轮免抽）13人/ }),
  );
  expect(
    screen.getByRole("dialog", { name: "已参与名单（本轮免抽） · 13人" }),
  ).toBeInTheDocument();
  expect(screen.getByText("同学12")).toBeInTheDocument();
});
