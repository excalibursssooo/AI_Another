export const runtime = "nodejs";

export async function POST(): Promise<Response> {
  return Response.json({
    skipped: true,
    reason: "feed generation is not implemented in Phase 1-3",
    post: null,
  });
}
