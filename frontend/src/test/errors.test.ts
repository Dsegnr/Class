import { expect, it } from "vitest";
import { ApiError, message } from "../api";

it.each([
  "Failed to fetch",
  "NetworkError when attempting to fetch resource.",
  "Load failed",
])("explains a browser network error in Chinese: %s", (text) => {
  expect(message(new TypeError(text))).toBe(
    "网络连接暂时中断，请检查网络后重试。",
  );
});
it("keeps actionable server messages and explains an unreadable response", () => {
  expect(message(new ApiError("任务已截止", 409))).toBe("任务已截止");
  expect(message(new SyntaxError("Unexpected token"))).toBe(
    "暂时无法读取服务器响应，请稍后重试。",
  );
});
