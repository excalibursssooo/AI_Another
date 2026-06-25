import { toWorldDetailDto } from "@/server/api/dto";
import { getDatabase } from "@/server/db/client";
import { WorldRepository } from "@/server/domain/chat/repositories";
import { createWorldFlow } from "@/server/flow/world-flow";

export const runtime = "nodejs";

export async function GET(_req: Request, context: { params: Promise<{ worldId: string }> }): Promise<Response> {
  const { worldId } = await context.params;
  const world = new WorldRepository(getDatabase()).get(worldId);
  if (!world) {
    return Response.json({ detail: "world not found" }, { status: 404 });
  }
  return Response.json(toWorldDetailDto(world));
}

export async function PUT(req: Request, context: { params: Promise<{ worldId: string }> }): Promise<Response> {
  const { worldId } = await context.params;
  const body = (await req.json()) as {
    name?: string;
    lore?: string;
    tone?: string;
    constraints?: string[];
    seed_memories?: string[];
  };
  if (!body.name?.trim()) {
    return Response.json({ detail: "name is required" }, { status: 400 });
  }
  const result = await createWorldFlow({ db: getDatabase() }).run({
    mode: "manual",
    input: {
      id: worldId,
      name: body.name,
      lore: body.lore || "",
      tone: body.tone || "",
      constraints: Array.isArray(body.constraints) ? body.constraints : [],
      seedMemories: Array.isArray(body.seed_memories) ? body.seed_memories : [],
    },
  });
  return Response.json(toWorldDetailDto(result.world!));
}
