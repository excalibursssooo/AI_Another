import { z } from "zod";

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly detail?: unknown,
  ) {
    super(code);
  }
}

export async function parseJsonBody<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiRequestError(400, "invalid_json");
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiRequestError(400, "invalid_request", parsed.error.flatten());
  }
  return parsed.data;
}

export async function parseOptionalJsonBody<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  const text = await req.text();
  if (!text.trim()) {
    raw = {};
  } else {
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      throw new ApiRequestError(400, "invalid_json");
    }
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiRequestError(400, "invalid_request", parsed.error.flatten());
  }
  return parsed.data;
}

export function apiRequestErrorResponse(error: ApiRequestError): Response {
  return Response.json(
    {
      error: error.code,
      detail: error.detail,
    },
    { status: error.status },
  );
}
