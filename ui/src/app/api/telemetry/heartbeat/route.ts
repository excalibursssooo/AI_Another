export const runtime = "nodejs";

export async function POST(): Promise<Response> {
  return Response.json({ status: "ok" });
}
