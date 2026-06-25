import { toWorldDetailDto } from "@/server/api/dto";
import { getDatabase } from "@/server/db/client";
import { WorldRepository } from "@/server/domain/chat/repositories";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return Response.json(new WorldRepository(getDatabase()).list().map(toWorldDetailDto));
}

export async function POST(): Promise<Response> {
  return Response.json({ detail: "world creation is not implemented in Phase 1-3" }, { status: 501 });
}
