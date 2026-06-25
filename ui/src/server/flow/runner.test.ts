import { describe, expect, it } from "vitest";

import { Flow } from "./runner";
import { FlowEvent, FlowNode } from "./types";

describe("Flow", () => {
  it("runs nodes in order and emits lifecycle events", async () => {
    type Ctx = { value: string };
    const nodes: FlowNode<Ctx>[] = [
      { name: "first", run: async (ctx) => ({ value: `${ctx.value}a` }) },
      { name: "second", run: async (ctx) => ({ value: `${ctx.value}b` }) },
    ];
    const events: FlowEvent[] = [];

    const result = await new Flow(nodes).run({ value: "" }, (event) => {
      events.push(event);
    });

    expect(result.value).toBe("ab");
    const nodeEvents = events.filter(
      (event): event is Extract<FlowEvent, { node: string }> => "node" in event,
    );
    expect(nodeEvents.map((event) => `${event.type}:${event.node}`)).toEqual([
      "node:start:first",
      "node:end:first",
      "node:start:second",
      "node:end:second",
    ]);
  });

  it("emits an error event before rethrowing node failures", async () => {
    const flow = new Flow<{ value: string }>([
      {
        name: "fail",
        run: async () => {
          throw new Error("boom");
        },
      },
    ]);
    const events: FlowEvent[] = [];

    await expect(
      flow.run({ value: "" }, (event) => {
        events.push(event);
      }),
    ).rejects.toThrow("boom");
    expect(events).toContainEqual({ type: "error", node: "fail", message: "boom" });
  });
});
