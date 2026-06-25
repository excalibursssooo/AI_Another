import { toPostItemDto } from "@/server/api/dto";
import { getDatabase } from "@/server/db/client";
import { FeedPostRepository } from "@/server/domain/chat/repositories";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const userId = url.searchParams.get("user_id") || "u001";
  const worldId = url.searchParams.get("domain_id") || undefined;
  const limit = Number(url.searchParams.get("limit") || "20");
  const offset = Number(url.searchParams.get("offset") || "0");
  const includeArchived = url.searchParams.get("include_archived") === "true";
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, limit)) : 20;
  const safeOffset = Number.isFinite(offset) ? Math.max(0, offset) : 0;
  const rows = new FeedPostRepository(getDatabase()).list({
    userId,
    worldId,
    limit: safeLimit,
    offset: safeOffset,
    includeArchived,
  });
  return Response.json({
    items: rows.items.map(toPostItemDto),
    total: rows.total,
    limit: safeLimit,
    offset: safeOffset,
  });
}
