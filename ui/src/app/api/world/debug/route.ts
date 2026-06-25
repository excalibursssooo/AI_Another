import { getDatabase } from "@/server/db/client";
import { WorldRepository } from "@/server/domain/chat/repositories";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const activeDomainId = url.searchParams.get("domain_id") || "default";
  const worlds = new WorldRepository(getDatabase()).list();
  return Response.json({
    enabled: true,
    default_domain_id: "default",
    active_domain_id: activeDomainId,
    active_domain_name: worlds.find((item) => item.id === activeDomainId)?.name || "默认世界",
    summaries: worlds.map((item) => ({ id: item.id, name: item.name })),
  });
}
