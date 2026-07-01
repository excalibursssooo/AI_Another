import { describe, expect, it, vi } from "vitest";

import { deleteAgentAction } from "./useAgentDeletion";

describe("deleteAgentAction", () => {
  it("deletes the agent, removes local state, and reports success", async () => {
    const notices: string[] = [];
    const removed: string[] = [];
    const deleteAgent = vi.fn(async () => undefined);

    await deleteAgentAction({
      agentId: "agent-1",
      agentName: "小伴",
      deleteAgent,
      removeAgentState: (agentId) => removed.push(agentId),
      setNotice: (message) => notices.push(message),
    });

    expect(deleteAgent).toHaveBeenCalledWith("agent-1");
    expect(removed).toEqual(["agent-1"]);
    expect(notices).toEqual(["已删除角色: 小伴"]);
  });

  it("reports deletion failures without removing local state", async () => {
    const notices: string[] = [];
    const removeAgentState = vi.fn();

    await deleteAgentAction({
      agentId: "agent-1",
      agentName: "小伴",
      deleteAgent: vi.fn(async () => {
        throw new Error("permission denied");
      }),
      removeAgentState,
      setNotice: (message) => notices.push(message),
    });

    expect(removeAgentState).not.toHaveBeenCalled();
    expect(notices).toEqual(["删除失败: permission denied"]);
  });
});
