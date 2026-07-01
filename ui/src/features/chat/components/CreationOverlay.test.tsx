import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CreationOverlay } from "./CreationOverlay";
import type { CreationOverlayState } from "./CreationOverlay";

function overlayState(overrides: Partial<CreationOverlayState> = {}): CreationOverlayState {
  return {
    active: true,
    mode: "ai",
    phase: "parsing",
    progress: 8,
    logs: ["boot"],
    message: "creating",
    error: "",
    signature: "",
    memoryNodesLit: 0,
    exploding: false,
    ...overrides,
  };
}

describe("CreationOverlay", () => {
  it("renders the phase label from overlay state", () => {
    const html = renderToStaticMarkup(<CreationOverlay overlay={overlayState()} />);

    expect(html).toContain("解析阶段");
    expect(html).toContain("creating");
  });

  it("renders nothing when inactive", () => {
    expect(renderToStaticMarkup(<CreationOverlay overlay={overlayState({ active: false })} />)).toBe("");
  });
});
