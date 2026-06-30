import { toWorldDetailDto } from "@/server/api/dto";
import { getDatabase } from "@/server/db/client";
import { WorldRepository } from "@/server/domain/world/world-repository";
import { createWorldFlow } from "@/server/flow/world-flow";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return Response.json(new WorldRepository(getDatabase()).list().map(toWorldDetailDto));
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as {
    id?: string;
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
      id: body.id,
      name: body.name,
      lore: body.lore || "",
      tone: body.tone || "",
      constraints: Array.isArray(body.constraints) ? body.constraints : [],
      seedMemories: Array.isArray(body.seed_memories) ? body.seed_memories : [],
    },
  });
  return Response.json(toWorldDetailDto(result.world!));
}
