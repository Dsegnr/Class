import { afterEach, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import EntryArtwork from "../EntryArtwork";
afterEach(() => vi.unstubAllGlobals());
it("keeps paint-driven rotation available after login/logout remounts", () => {
  const names = new Set<string>();
  const registerProperty = vi.fn((definition: { name: string }) => {
    if (names.has(definition.name))
      throw new DOMException("already registered", "InvalidModificationError");
    names.add(definition.name);
  });
  vi.stubGlobal("CSS", { registerProperty });
  const first = render(<EntryArtwork />);
  expect(
    first.container.querySelector(".entry-art--painted-motion"),
  ).toBeInTheDocument();
  first.unmount();
  const second = render(<EntryArtwork />);
  expect(
    second.container.querySelector(".entry-art--painted-motion"),
  ).toBeInTheDocument();
});
it("leaves the original CSS rotation fallback when typed properties are unavailable", () => {
  vi.stubGlobal("CSS", {});
  const { container } = render(<EntryArtwork />);
  expect(container.querySelector(".entry-art")).toBeInTheDocument();
  expect(
    container.querySelector(".entry-art--painted-motion"),
  ).not.toBeInTheDocument();
});
