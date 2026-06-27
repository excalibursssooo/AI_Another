import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cosineSimilarity,
  createFallbackEmbedding,
  embedText,
  hashEmbeddingText,
  normalizeEmbeddingText,
  classifyEmbeddingError,
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

describe("classifyEmbeddingError", () => {
  it("returns 'aborted' when error.name === 'AbortError'", () => {
    expect(classifyEmbeddingError(Object.assign(new Error(""), { name: "AbortError" }))).toBe("aborted");
  });

  it("returns 'aborted' when error.message includes 'aborted'", () => {
    expect(classifyEmbeddingError(new Error("fetch aborted"))).toBe("aborted");
  });

  it("returns 'aborted' for non-Error throws with name 'AbortError'", () => {
    expect(classifyEmbeddingError({ name: "AbortError" })).toBe("aborted");
  });

  it("returns 'non_2xx_status' for 'embedding request failed' messages", () => {
    expect(classifyEmbeddingError(new Error("embedding request failed: 500"))).toBe("non_2xx_status");
  });

  it("returns 'invalid_response_shape' for 'missing data' messages", () => {
    expect(classifyEmbeddingError(new Error("embedding response missing data"))).toBe("invalid_response_shape");
  });

  it("returns 'vector_dimension_zero' for length-0 messages", () => {
    expect(classifyEmbeddingError(new Error("embedding response vector length 0"))).toBe("vector_dimension_zero");
  });

  it("returns 'invalid_response_shape' for 'missing vector' messages", () => {
    expect(classifyEmbeddingError(new Error("embedding response missing vector"))).toBe("invalid_response_shape");
  });

  it("returns 'fetch_failed' for unknown errors", () => {
    expect(classifyEmbeddingError(new Error("ECONNREFUSED"))).toBe("fetch_failed");
    expect(classifyEmbeddingError("string error")).toBe("fetch_failed");
  });
});

describe("embedText fallbackReason", () => {
  it("tags fallback results with fallbackReason on fetch failure", async () => {
    const result = await embedText("hello", { fetchFn: (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch });
    expect(result.backend).toBe("fallback");
    expect(result.fallbackReason).toBe("fetch_failed");
  });

  it("tags fallback results with non_2xx_status when response not ok", async () => {
    const fakeFetch = (() => Promise.resolve(new Response("{}", { status: 500 }))) as typeof fetch;
    const result = await embedText("hello", { fetchFn: fakeFetch });
    expect(result.backend).toBe("fallback");
    expect(result.fallbackReason).toBe("non_2xx_status");
  });

  it("does not set fallbackReason on success", async () => {
    const fakeFetch = (() => Promise.resolve(new Response(
      JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ))) as typeof fetch;
    const result = await embedText("hello", { fetchFn: fakeFetch });
    expect(result.backend).toBe("llama.cpp");
    expect(result.fallbackReason).toBeUndefined();
  });
});
