import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { RightPanel } from "./RightPanel";
import type { AgentLiveStateDto, PostItemDto } from "@/lib/api/types_api";
import type { AiAgent } from "@/features/chat/types";

const agent: AiAgent = {
  id: "agent-1",
  name: "小伴",
  greeting: "你好",
  persona: "温和",
  background: "测试角色",
  domainId: "default",
  worldContext: "",
  hobbies: [],
  speakingStyle: "自然",
  status: "active",
  tagline: "温和",
  avatarColor: "#fff",
};

const liveState: AgentLiveStateDto = {
  agent_id: "agent-1",
  agent_name: "小伴",
  mood_label: "happy",
  mood_intensity: 0.7,
  mood_index: 70,
  heartbeat_bpm: 72,
  heartbeat_interval_ms: 833,
  stress_level: 0.2,
  trend: "up",
  risk_level: "low",
  updated_at: new Date().toISOString(),
};

const post: PostItemDto = {
  id: "post-1",
  user_id: "u001",
  agent_id: "agent-1",
  agent_name: "小伴",
  content: "今天想去散步。",
  topic_seed: "散步",
  post_type: "status",
  status: "published",
  source_task_id: null,
  created_at: new Date().toISOString(),
};

function renderPanel(overrides: Partial<Parameters<typeof RightPanel>[0]> = {}) {
  return renderToStaticMarkup(
    <RightPanel
      activeTab="state"
      selectedAgent={agent}
      selectedLiveState={liveState}
      displayMoodIndex={70}
      displayHeartbeatBpm={72}
      displayStressLevel={0.2}
      heartbeatDuration="0.83s"
      feedPosts={[]}
      feedLoading={false}
      isGeneratingPost={false}
      showAddFriendMenu={false}
      showCustomCreateForm={false}
      draftName=""
      draftPersona=""
      draftStyle=""
      formatAgo={() => "刚刚"}
      onTabChange={vi.fn()}
      onGeneratePost={vi.fn()}
      onTriggerFromPost={vi.fn()}
      onShowCustomCreateFormChange={vi.fn()}
      onAiCreateAgent={vi.fn()}
      onCreateAgent={vi.fn()}
      onDraftNameChange={vi.fn()}
      onDraftPersonaChange={vi.fn()}
      onDraftStyleChange={vi.fn()}
      {...overrides}
    />,
  );
}

describe("RightPanel", () => {
  it("renders live state details for the selected agent", () => {
    const html = renderPanel();

    expect(html).toContain("当前心情");
    expect(html).toContain("愉悦");
    expect(html).toContain("72 bpm");
    expect(html).toContain("风险等级");
  });

  it("renders feed controls and post cards in feed mode", () => {
    const html = renderPanel({
      activeTab: "feed",
      feedPosts: [post],
    });

    expect(html).toContain("让 小伴 发一条动态");
    expect(html).toContain("今天想去散步。");
    expect(html).toContain("话题: 散步");
  });

  it("renders add-friend choices without store dependencies", () => {
    const html = renderPanel({
      showAddFriendMenu: true,
    });

    expect(html).toContain("添加好友");
    expect(html).toContain("自定义你的ta");
    expect(html).toContain("你有一个好友申请");
  });
});
