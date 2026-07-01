import { apiRequestErrorResponse, ApiRequestError, readRequiredSearchParam } from "@/server/api/request";
import { toPostItemDto } from "@/server/api/dto";
import { getDatabase } from "@/server/db/client";
import { FeedPostRepository } from "@/server/domain/feed/feed-post-repository";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  let userId: string;
  try {
    userId = readRequiredSearchParam(url, "user_id");
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return apiRequestErrorResponse(error);
    }
    throw error;
  }
  const worldId = url.searchParams.get("domain_id")?.trim() || undefined;
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
