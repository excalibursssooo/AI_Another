import { AppDatabase } from "@/server/db/client";
import { MemoryConsolidator } from "@/server/domain/chat/memory-consolidator";
import {
  GenerateMemoryExtraction,
  generateMemoryExtraction as defaultGenerateMemoryExtraction,
} from "@/server/ai/chat";
import { MemoryCandidate } from "@/server/ai/schemas";

import type { EmbedText } from "@/server/domain/chat/memory-consolidator";
import { Flow } from "./runner";
import { FlowNode } from "./types";

export interface MemoryExtractContext {
  userId: string;
  agentId: string;
  worldId: string;
  userMessage: string;
  assistantMessage: string;
  agentName?: string;
  candidates?: MemoryCandidate[];
  persistedMemoryCount?: number;
  sourceMessageId?: string | null;
  sourceTaskId?: string | null;
}

export function createMemoryExtractFlow(options: {
  db: AppDatabase;
  generateMemoryExtraction?: GenerateMemoryExtraction;
  embedText?: EmbedText;
}): Flow<MemoryExtractContext> {
  const generateExtraction = options.generateMemoryExtraction ?? defaultGenerateMemoryExtraction;

  const nodes: FlowNode<MemoryExtractContext>[] = [
    {
      name: "LoadMessagePair",
      run: async (ctx) => ({
        ...ctx,
        userMessage: ctx.userMessage.trim(),
        assistantMessage: ctx.assistantMessage.trim(),
      }),
    },
    {
      name: "ExtractMemoryCandidates",
      run: async (ctx) => {
        if (!ctx.userMessage || !ctx.assistantMessage) {
          return { ...ctx, candidates: [] };
        }
        const extraction = await generateExtraction({
          userMessage: ctx.userMessage,
          assistantMessage: ctx.assistantMessage,
          agentName: ctx.agentName,
        });
        return { ...ctx, candidates: extraction?.memories ?? [] };
      },
    },
    {
      name: "ConsolidateMemories",
      run: async (ctx) => {
        const candidates = (ctx.candidates ?? []).filter((candidate) => candidate.content.trim()).slice(0, 8);
        const consolidator = new MemoryConsolidator({ db: options.db, embedText: options.embedText });
        let persistedMemoryCount = 0;
        for (const candidate of candidates) {
          const result = await consolidator.consolidate({
            userId: ctx.userId,
            agentId: ctx.agentId,
            worldId: ctx.worldId,
            candidate,
            sourceMessageId: ctx.sourceMessageId ?? null,
            sourceTaskId: ctx.sourceTaskId ?? null,
          });
          if (result.action === "created" || result.action === "merged" || result.action === "conflicted") {
            persistedMemoryCount += 1;
          }
        }
        return { ...ctx, persistedMemoryCount };
      },
    },
  ];

  return new Flow(nodes);
}
