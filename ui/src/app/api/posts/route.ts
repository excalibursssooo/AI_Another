export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") || "20");
  const offset = Number(url.searchParams.get("offset") || "0");
  return Response.json({
    items: [],
    total: 0,
    limit: Number.isFinite(limit) ? limit : 20,
    offset: Number.isFinite(offset) ? offset : 0,
  });
}
