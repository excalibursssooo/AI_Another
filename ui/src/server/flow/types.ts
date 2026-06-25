export type FlowEvent =
  | { type: "node:start"; node: string }
  | { type: "node:end"; node: string }
  | { type: "delta"; content: string }
  | { type: "error"; node: string; message: string };

export type FlowEmitter = (event: FlowEvent) => void | Promise<void>;

export interface FlowNode<TCtx> {
  name: string;
  run(ctx: TCtx, emit?: FlowEmitter): Promise<TCtx>;
}
