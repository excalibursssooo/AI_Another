import { getDatabase } from "../src/server/db/client";
import { createChatFlow } from "../src/server/flow/chat-flow";

const db = getDatabase();
const flow = createChatFlow({ db });

async function main(): Promise<void> {
  const result = await flow.run({
    userId: process.env.DEV_USER_ID || "u001",
    agentId: "agent-default",
    worldId: "default",
    input: "你好，请用一句话回复我。",
  });

  if (!result.reply || !result.doneEvent) {
    throw new Error("smoke chat failed: missing reply or done event");
  }

  console.log(`smoke chat ok: ${result.reply}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
