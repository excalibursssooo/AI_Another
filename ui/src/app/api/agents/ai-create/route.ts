import { toAgentResponseDto } from "@/server/api/dto";
import { getDatabase } from "@/server/db/client";
import { WorldRepository } from "@/server/domain/world/world-repository";
import { createAgentCreateFlow } from "@/server/flow/agent-create-flow";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { prompt?: string | null; domain_id?: string };
  const result = await createAgentCreateFlow({ db: getDatabase() }).run({
    mode: "ai",
    userId: process.env.DEV_USER_ID || "u001",
    worldId: body.domain_id || "default",
    prompt: body.prompt ?? null,
  });
  const world = new WorldRepository(getDatabase()).get(result.agent!.worldId);
  return Response.json({
    agent: toAgentResponseDto(result.agent!, world),
    backend: result.backend || "mock",
    model: result.model || "local-agent-generator",
    used_prompt: body.prompt || "",
    raw_text: result.rawText || "",
  });
}
