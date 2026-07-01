import type { AgentResponseDto } from "@/lib/api/types_api";
import type { AiAgent } from "@/features/chat/types";

export const AGENT_COLORS = ["var(--agent-amber)", "var(--agent-coral)", "var(--agent-teal)", "var(--agent-rose)"];

export function mapAgentFromApi(item: AgentResponseDto, index: number): AiAgent {
  return {
    id: item.id,
    name: item.display_name || item.name,
    greeting: item.greeting,
    persona: item.persona,
    background: item.background,
    domainId: item.domain_id,
    worldContext: item.world_context,
    hobbies: item.hobbies,
    speakingStyle: item.speaking_style,
    status: item.status,
    tagline: item.persona.slice(0, 28),
    avatarColor: AGENT_COLORS[index % AGENT_COLORS.length],
  };
}
