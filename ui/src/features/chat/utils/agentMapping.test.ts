import { describe, expect, it } from "vitest";

import { AGENT_COLORS, mapAgentFromApi } from "./agentMapping";
import type { AgentResponseDto } from "@/lib/api/types_api";

function agentDto(overrides: Partial<AgentResponseDto> = {}): AgentResponseDto {
  return {
    id: "agent-1",
    name: "fallback-name",
    display_name: "display-name",
    greeting: "hello",
    persona: "123456789012345678901234567890",
    background: "background",
    domain_id: "world-1",
    world_context: "world context",
    hobbies: ["coding", "tea"],
    speaking_style: "calm",
    status: "active",
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("mapAgentFromApi", () => {
  it("maps agent response fields into the chat agent model", () => {
    expect(mapAgentFromApi(agentDto(), 0)).toEqual({
      id: "agent-1",
      name: "display-name",
      greeting: "hello",
      persona: "123456789012345678901234567890",
      background: "background",
      domainId: "world-1",
      worldContext: "world context",
      hobbies: ["coding", "tea"],
      speakingStyle: "calm",
      status: "active",
      tagline: "1234567890123456789012345678",
      avatarColor: AGENT_COLORS[0],
    });
  });

  it("falls back to the raw name and rotates avatar colors", () => {
    const mapped = mapAgentFromApi(agentDto({ display_name: "", status: "inactive" }), AGENT_COLORS.length + 1);

    expect(mapped.name).toBe("fallback-name");
    expect(mapped.status).toBe("inactive");
    expect(mapped.avatarColor).toBe(AGENT_COLORS[1]);
  });
});
