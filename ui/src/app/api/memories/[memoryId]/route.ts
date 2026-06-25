export const runtime = "nodejs";

export async function DELETE(): Promise<Response> {
  return Response.json({ detail: "memory deletion is not implemented in Phase 1-3" }, { status: 501 });
}
