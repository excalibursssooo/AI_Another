import axios, { AxiosError, AxiosHeaders } from "axios";

const AUTH_TOKEN_STORAGE_KEY = "companion_auth_token";

export function resolveApiBaseUrl(input: { nodeEnv?: string; apiBaseUrl?: string } = {}): string {
  const baseUrl = input.apiBaseUrl?.trim() ?? process.env.NEXT_PUBLIC_API_BASE_URL?.trim();
  return baseUrl || "/api";
}

export function buildApiUrl(path: string, baseUrl = API_BASE_URL): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${baseUrl.replace(/\/$/, "")}${normalizedPath}`;
}

const API_BASE_URL = resolveApiBaseUrl();

function getEnvAuthToken(): string {
  const token = process.env.NEXT_PUBLIC_DEMO_AUTH_TOKEN?.trim();
  if (!token && process.env.NODE_ENV === "production") {
    throw new Error("FATAL: NEXT_PUBLIC_DEMO_AUTH_TOKEN is not defined in production environment.");
  }
  return token || "";
}

function getAuthToken(): string {
  if (typeof window !== "undefined") {
    try {
      const persisted = window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)?.trim();
      if (persisted) {
        return persisted;
      }
    } catch {
      // Ignore localStorage read errors.
    }
  }
  return getEnvAuthToken();
}

function buildAuthHeaders(extraHeaders?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    ...(extraHeaders ?? {}),
  };
  const token = getAuthToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

const http = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    "Content-Type": "application/json",
  },
});

http.interceptors.request.use((config) => {
  const mergedHeaders = buildAuthHeaders({
    ...(config.headers as Record<string, string> | undefined),
  });
  config.headers = new AxiosHeaders(mergedHeaders);
  return config;
});

export class HttpError extends Error {
  status: number;
  statusText: string;
  responseText: string;

  constructor(message: string, status: number, statusText: string, responseText: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.statusText = statusText;
    this.responseText = responseText;
  }
}

export function getApiBaseUrl(): string {
  return API_BASE_URL;
}

function parseError(error: unknown): Error {
  if (axios.isAxiosError(error)) {
    const response = (error as AxiosError).response;
    if (!response) {
      return new Error(error.message || "Network request failed");
    }

    const detail = typeof response.data === "object" && response.data && "detail" in response.data
      ? (response.data as { detail?: unknown }).detail
      : undefined;
    if (typeof detail === "string") {
      return new HttpError(detail, response.status, response.statusText, detail);
    }

    let responseText = "";
    if (typeof response.data === "string") {
      responseText = response.data.slice(0, 800);
    } else if (response.data !== undefined) {
      try {
        responseText = JSON.stringify(response.data).slice(0, 800);
      } catch {
        responseText = String(response.data).slice(0, 800);
      }
    }

    return new HttpError(
      `HTTP ${response.status}: ${response.statusText}${responseText ? ` | ${responseText}` : ""}`,
      response.status,
      response.statusText,
      responseText,
    );
  }

  return error instanceof Error ? error : new Error("Unknown request error");
}

export async function httpGet<T>(path: string, options?: { signal?: AbortSignal }): Promise<T> {
  try {
    const response = await http.get<T>(path, {
      headers: buildAuthHeaders({ "Cache-Control": "no-store" }),
      signal: options?.signal,
    });
    return response.data;
  } catch (error) {
    throw parseError(error);
  }
}

export async function httpPost<TReq, TResp>(path: string, body: TReq): Promise<TResp> {
  try {
    const response = await http.post<TResp>(path, body);
    return response.data;
  } catch (error) {
    throw parseError(error);
  }
}

export async function httpPut<TReq, TResp>(path: string, body: TReq): Promise<TResp> {
  try {
    const response = await http.put<TResp>(path, body);
    return response.data;
  } catch (error) {
    throw parseError(error);
  }
}

export async function httpDelete<TReq, TResp>(path: string, body: TReq): Promise<TResp> {
  try {
    const response = await http.delete<TResp>(path, { data: body });
    return response.data;
  } catch (error) {
    throw parseError(error);
  }
}

export async function streamPost(
  path: string,
  body: unknown,
  onEvent: (event: Record<string, unknown>) => void,
): Promise<void> {
  const response = await fetch(buildApiUrl(path), {
    method: "POST",
    headers: buildAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let responseText = "";
    try {
      responseText = (await response.text()).slice(0, 800);
    } catch {
      responseText = "";
    }
    throw new HttpError(
      `HTTP ${response.status}: ${response.statusText}${responseText ? ` | ${responseText}` : ""}`,
      response.status,
      response.statusText,
      responseText,
    );
  }

  if (!response.body) {
    throw new Error("SSE response body is empty");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const endsWithDelimiter = buffer.endsWith("\n\n");
    const blocks = buffer.split("\n\n");
    buffer = endsWithDelimiter ? "" : (blocks.pop() ?? "");

    for (const block of blocks) {
      if (!block.trim()) {
        continue;
      }

      const line = block
        .split("\n")
        .map((item) => item.trim())
        .find((item) => item.startsWith("data:"));

      if (!line) {
        continue;
      }

      const payload = line.slice(5).trim();
      if (!payload) {
        continue;
      }

      try {
        const event = JSON.parse(payload) as Record<string, unknown>;
        onEvent(event);
      } catch {
        // Ignore malformed event chunks.
      }
    }
  }
}
