import { FlowEmitter, FlowNode } from "./types";

export class Flow<TCtx> {
  constructor(private readonly nodes: FlowNode<TCtx>[]) {}

  async run(ctx: TCtx, emit?: FlowEmitter): Promise<TCtx> {
    let current = ctx;

    for (const node of this.nodes) {
      await emit?.({ type: "node:start", node: node.name });
      try {
        current = await node.run(current, emit);
      } catch (error) {
        await emit?.({
          type: "error",
          node: node.name,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      await emit?.({ type: "node:end", node: node.name });
    }

    return current;
  }
}
