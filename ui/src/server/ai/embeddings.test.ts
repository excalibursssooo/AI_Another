import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cosineSimilarity,
  createFallbackEmbedding,
  embedText,
  hashEmbeddingText,
  normalizeEmbeddingText,
} from "./embeddings";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("embedText", () => {
  it("parses a llama.cpp OpenAI-compatible embedding response", async () => {
    vi.stubEnv("LLAMA_EMBEDDING_BASE_URL", "http://127.0.0.1:8080/v1");
    vi.stubEnv("LLAMA_EMBEDDING_MODEL", "bge-m3");
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
    })) as unknown as typeof fetch;

    const result = await embedText("用户喜欢雨天散步", { fetchFn });

    expect(fetchFn).toHaveBeenCalledWith(
      "http://127.0.0.1:8080/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ model: "bge-m3", input: "用户喜欢雨天散步" }),
      }),
    );
    expect(result).toEqual({
      vector: [0.1, 0.2, 0.3],
      dimension: 3,
      backend: "llama.cpp",
      quality: "semantic",
      model: "bge-m3",
      version: 1,
      needsRefresh: false,
    });
  });

  it("returns deterministic fallback when llama.cpp request fails", async () => {
    vi.stubEnv("EMBEDDING_FALLBACK_DIMENSION", "8");
    const fetchFn = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;

    const first = await embedText("用户喜欢雨天散步", { fetchFn });
    const second = await embedText("用户喜欢雨天散步", { fetchFn });

    expect(first.backend).toBe("fallback");
    expect(first.quality).toBe("lexical");
    expect(first.needsRefresh).toBe(true);
    expect(first.dimension).toBe(8);
    expect(first.vector).toEqual(second.vector);
  });
});

describe("embedding helpers", () => {
  it("normalizes and hashes text deterministically", () => {
    expect(normalizeEmbeddingText(" 用户  喜欢\n雨天散步 ")).toBe("用户 喜欢 雨天散步");
    expect(hashEmbeddingText("用户喜欢雨天散步")).toBe(hashEmbeddingText("用户喜欢雨天散步"));
  });

  it("computes cosine similarity", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [1])).toBeNull();
  });

  it("creates deterministic fallback embeddings", () => {
    const one = createFallbackEmbedding("用户喜欢咖啡", 8);
    const two = createFallbackEmbedding("用户喜欢咖啡", 8);
    expect(one).toEqual(two);
    expect(one).toHaveLength(8);
  });
});
