import { expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Duty from "../Duty";
import { api } from "../api";
vi.mock("../api", () => ({ api: vi.fn(), message: (e: Error) => e.message }));
it("ties the duty group and confirmation to the explicit date without advancing it", async () => {
  const members = Array.from({ length: 5 }, (_, i) => ({
    student_id: String(i + 2),
    name: `同学${i + 2}`,
  }));
  vi.mocked(api).mockResolvedValue({
    date: "2026-11-09",
    next_index: 1,
    next: members,
    order: members,
    events: [],
  });
  render(
    <Duty
      user={{ ...members[0], role: "admin", must_change: false, csrf: "qa" }}
      toast={vi.fn()}
    />,
  );
  await screen.findByRole("heading", { name: "2026年11月9日（周一）值日同学" });
  expect(screen.queryByText("本次值日同学")).not.toBeInTheDocument();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "确认2026年11月9日值日完成" }));
  expect(
    screen.getByRole("dialog", { name: "确认2026年11月9日值日已完成" }),
  ).toBeInTheDocument();
  expect(vi.mocked(api).mock.calls.every((call) => call[1] !== "POST")).toBe(
    true,
  );
});
