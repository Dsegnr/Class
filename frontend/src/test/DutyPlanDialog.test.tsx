import { beforeEach, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DutyPlanDialog from "../DutyPlanDialog";
import { api } from "../api";
import type { DutyState } from "../types";
vi.mock("../api", () => ({ api: vi.fn(), message: (e: Error) => e.message }));
const people = Array.from({ length: 7 }, (_, i) => ({
  student_id: String(i + 1),
  name: `同学${i + 1}`,
}));
const initial: DutyState = {
  next_index: 0,
  date: "2026-11-09",
  next: people.slice(0, 5),
  base_next: people.slice(0, 5),
  order: people,
  exempt: [],
  events: [],
  plan_events: [],
  replacements: [],
  reason: "",
  plan_version: "a".repeat(64),
};
const result = {
  id: "saved",
  kind: "duty_plan",
  payload: { members: [people[5], ...people.slice(1, 5)] },
};
beforeEach(() => vi.mocked(api).mockReset());

it("rejects duplicate people and retries the exact same request after a transport failure", async () => {
  vi.mocked(api)
    .mockRejectedValueOnce(new Error("连接中断，请重试"))
    .mockResolvedValueOnce(result);
  const saved = vi.fn();
  render(
    <DutyPlanDialog initial={initial} onClose={vi.fn()} onSaved={saved} />,
  );
  const user = userEvent.setup();
  const select = screen.getByRole("combobox", { name: "同学1对应的值日同学" });
  await user.selectOptions(select, "2");
  expect(screen.getByRole("alert")).toHaveTextContent("重复安排");
  await user.type(
    screen.getByRole("textbox", { name: "调整说明（班级可见）" }),
    "协商临时替班",
  );
  const button = screen.getByRole("button", { name: "保存并通知相关同学" });
  expect(button).toBeDisabled();
  await user.selectOptions(select, "6");
  await user.click(button);
  await screen.findByRole("alert");
  expect(saved).not.toHaveBeenCalled();
  await user.click(button);
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
  expect(vi.mocked(api).mock.calls[0]).toEqual(vi.mocked(api).mock.calls[1]);
  expect(vi.mocked(api).mock.calls[0][2]).toMatchObject({
    expected_version: initial.plan_version,
    replacements: [{ original_id: "1", substitute_id: "6" }],
    reason: "协商临时替班",
  });
});

it("keeps the reviewed snapshot until the user explicitly reads the newer plan", async () => {
  const updated = {
    ...initial,
    date: "2026-11-16",
    plan_version: "b".repeat(64),
  };
  vi.mocked(api).mockResolvedValueOnce(updated).mockResolvedValueOnce(result);
  const { rerender } = render(
    <DutyPlanDialog initial={initial} onClose={vi.fn()} onSaved={vi.fn()} />,
  );
  rerender(
    <DutyPlanDialog initial={updated} onClose={vi.fn()} onSaved={vi.fn()} />,
  );
  expect(screen.getByRole("dialog")).toHaveAccessibleName(
    "2026-11-09 值日人员调整",
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "读取最新安排" }));
  await screen.findByRole("dialog", { name: "2026-11-16 值日人员调整" });
  await user.selectOptions(
    screen.getByRole("combobox", { name: "同学1对应的值日同学" }),
    "6",
  );
  await user.type(screen.getByRole("textbox"), "协商临时替班");
  await user.click(screen.getByRole("button", { name: "保存并通知相关同学" }));
  await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api).mock.calls[1][2]).toMatchObject({
    expected_version: updated.plan_version,
  });
});

it("restores original assignments as an explicit, reasoned change without touching the rotation", async () => {
  const changed = {
    ...initial,
    next: [people[5], ...people.slice(1, 5)],
    replacements: [{ original_id: "1", substitute_id: "6" }],
  };
  vi.mocked(api).mockResolvedValue({
    ...result,
    payload: { members: initial.next },
  });
  render(
    <DutyPlanDialog initial={changed} onClose={vi.fn()} onSaved={vi.fn()} />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "全部恢复原排" }));
  expect(vi.mocked(api)).not.toHaveBeenCalled();
  await user.type(screen.getByRole("textbox"), "恢复原来安排");
  await user.click(screen.getByRole("button", { name: "保存并通知相关同学" }));
  await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledTimes(1));
  expect(vi.mocked(api).mock.calls[0][2]).toMatchObject({
    replacements: [],
    reason: "恢复原来安排",
  });
});
