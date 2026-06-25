export const runtime = "nodejs";

export async function POST(): Promise<Response> {
  return Response.json({ detail: "AI world creation is not implemented in Phase 1-3" }, { status: 501 });
}
