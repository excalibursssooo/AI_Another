export const runtime = "nodejs";

export async function POST(): Promise<Response> {
  return Response.json({ detail: "memory activation is not implemented in Phase 1-3" }, { status: 501 });
}
