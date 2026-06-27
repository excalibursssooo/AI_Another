import { createHash } from "node:crypto";

export type EmbeddingBackend = "llama.cpp" | "fallback";
export type EmbeddingQuality = "semantic" | "lexical" | "none";

export interface EmbeddingResult {
  vector: number[];
  dimension: number;
  backend: EmbeddingBackend;
  quality: EmbeddingQuality;
  model: string;
  version: number;
  needsRefresh: boolean;
}

export interface EmbedTextOptions {
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}

export const EMBEDDING_VERSION = 1;
const DEFAULT_BASE_URL = "http://127.0.0.1:8080/v1";
const DEFAULT_MODEL = "bge-m3";
const DEFAULT_FALLBACK_DIMENSION = 128;

export async function embedText(text: string, options: EmbedTextOptions = {}): Promise<EmbeddingResult> {
  const normalized = normalizeEmbeddingText(text);
  const baseUrl = (process.env.LLAMA_EMBEDDING_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
  const model = process.env.LLAMA_EMBEDDING_MODEL?.trim() || DEFAULT_MODEL;
  const fetchFn = options.fetchFn ?? fetch;

  try {
    const response = await fetchFn(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: normalized }),
      signal: options.signal,
    });
    if (!response.ok) {
      throw new Error(`embedding request failed: ${response.status}`);
    }
    const body = (await response.json()) as unknown;
    const vector = parseEmbeddingVector(body);
    return {
      vector,
      dimension: vector.length,
      backend: "llama.cpp",
      quality: "semantic",
      model,
      version: EMBEDDING_VERSION,
      needsRefresh: false,
    };
  } catch {
    const dimension = readFallbackDimension();
    return {
      vector: createFallbackEmbedding(normalized, dimension),
      dimension,
      backend: "fallback",
      quality: "lexical",
      model: "fallback-hash-v1",
      version: EMBEDDING_VERSION,
      needsRefresh: true,
    };
  }
}

export function normalizeEmbeddingText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function hashEmbeddingText(text: string): string {
  return createHash("sha256").update(normalizeEmbeddingText(text)).digest("hex");
}

export function createFallbackEmbedding(text: string, dimension: number): number[] {
  const normalized = normalizeEmbeddingText(text);
  const safeDimension = Math.max(1, Math.min(4096, Math.trunc(dimension)));
  const vector = Array.from({ length: safeDimension }, () => 0);
  for (const token of normalized.split(/\s+/).filter(Boolean)) {
    const digest = createHash("sha256").update(token).digest();
    for (let index = 0; index < digest.length; index += 2) {
      const slot = digest[index] % safeDimension;
      vector[slot] += digest[index + 1] >= 128 ? 1 : -1;
    }
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

export function cosineSimilarity(left: number[], right: number[]): number | null {
  if (left.length === 0 || left.length !== right.length) {
    return null;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return null;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function parseEmbeddingVector(body: unknown): number[] {
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("embedding response missing data");
  }
  const embedding = (data[0] as { embedding?: unknown }).embedding;
  if (!Array.isArray(embedding) || embedding.length === 0 || !embedding.every((item) => typeof item === "number")) {
    throw new Error("embedding response missing vector");
  }
  return embedding;
}

function readFallbackDimension(): number {
  const parsed = Number.parseInt(process.env.EMBEDDING_FALLBACK_DIMENSION || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_FALLBACK_DIMENSION;
}
