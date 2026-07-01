import { toAgentResponseDto } from "@/server/api/dto";
import { apiRequestErrorResponse, ApiRequestError, parseOptionalJsonBody } from "@/server/api/request";
import { AgentAiCreateRequestSchema } from "@/server/api/schemas";
import { getDatabase } from "@/server/db/client";
import { WorldRepository } from "@/server/domain/world/world-repository";
import { createAgentCreateFlow } from "@/server/flow/agent-create-flow";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  let body;
  try {
    body = await parseOptionalJsonBody(req, AgentAiCreateRequestSchema);
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return apiRequestErrorResponse(error);
    }
    throw error;
  }

  const result = await createAgentCreateFlow({ db: getDatabase() }).run({
    mode: "ai",
    userId: body.user_id,
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
