import { useCallback } from "react";

import { deleteAgent } from "@/lib/api/companion";
import { getErrorMessage } from "@/lib/utils/error";

interface DeleteAgentActionOptions {
  agentId: string;
  agentName: string;
  deleteAgent: (agentId: string) => Promise<unknown>;
  removeAgentState: (agentId: string) => void;
  setNotice: (message: string) => void;
}

interface UseAgentDeletionOptions {
  removeAgentState: (agentId: string) => void;
  onNotice: (message: string) => void;
}

export async function deleteAgentAction(options: DeleteAgentActionOptions): Promise<void> {
  try {
    await options.deleteAgent(options.agentId);
    options.removeAgentState(options.agentId);
    options.setNotice(`已删除角色: ${options.agentName}`);
  } catch (error) {
    options.setNotice(`删除失败: ${getErrorMessage(error)}`);
  }
}

export function useAgentDeletion(options: UseAgentDeletionOptions) {
  const deleteAgentHandle = useCallback(
    async (agentId: string, agentName: string) => {
      await deleteAgentAction({
        agentId,
        agentName,
        deleteAgent,
        removeAgentState: options.removeAgentState,
        setNotice: options.onNotice,
      });
    },
    [options.onNotice, options.removeAgentState],
  );

  return { deleteAgentHandle };
}
