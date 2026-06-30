import { toAgentResponseDto } from "@/server/api/dto";
import { getDatabase } from "@/server/db/client";
import { AgentRepository } from "@/server/domain/agent/agent-repository";
import { WorldRepository } from "@/server/domain/world/world-repository";
import { createAgentCreateFlow } from "@/server/flow/agent-create-flow";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const worldId = url.searchParams.get("domain_id") || undefined;
  const agentRepo = new AgentRepository(getDatabase());
  const worldRepo = new WorldRepository(getDatabase());
  const agents = agentRepo.listActive(worldId).map((agent) => {
    const world = worldId ? worldRepo.get(worldId) : worldRepo.get(agent.worldId);
    return toAgentResponseDto(agent, world);
  });
  return Response.json(agents);
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as {
    name?: string;
    persona?: string;
    background?: string;
    domain_id?: string;
    hobbies?: string[];
    speaking_style?: string;
  };
  if (!body.name?.trim() || !body.persona?.trim()) {
    return Response.json({ detail: "name and persona are required" }, { status: 400 });
  }
  const result = await createAgentCreateFlow({ db: getDatabase() }).run({
    mode: "manual",
    userId: process.env.DEV_USER_ID || "u001",
    worldId: body.domain_id || "default",
    input: {
      name: body.name,
      persona: body.persona,
      background: body.background || "由用户创建的 AI 角色。",
      hobbies: Array.isArray(body.hobbies) ? body.hobbies : [],
      speakingStyle: body.speaking_style || "自然、真诚",
    },
  });
  const world = new WorldRepository(getDatabase()).get(result.agent!.worldId);
  return Response.json(toAgentResponseDto(result.agent!, world));
}
