import { getDatabase } from "../src/server/db/client";
import { AgentRepository, WorldRepository } from "../src/server/domain/chat/repositories";

const db = getDatabase();
const world = new WorldRepository(db).get("default");
const agent = new AgentRepository(db).get("agent-default");

if (!world) {
  throw new Error("default world was not seeded");
}

if (!agent) {
  throw new Error("default agent was not seeded");
}

console.log(`seed ok: world=${world.id} agent=${agent.id}`);
