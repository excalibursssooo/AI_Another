import { AiAgent, ChatMessage, MemoryRecord } from "@/features/chat/types";

export const seedAgents: AiAgent[] = [
  {
    id: "default",
    name: "陆予怀",
    persona: "冷静、克制、善于安抚焦虑",
    background: "曾参与城市时序数据修复项目，习惯从细节里找秩序。",
    hobbies: ["老唱片", "夜跑", "观影"],
    speakingStyle: "沉稳温和",
    status: "active",
    tagline: "把复杂情绪拆成能走的下一步",
    avatarColor: "var(--agent-amber)",
  },
  {
    id: "a2",
    name: "林知夏",
    persona: "温暖、细腻、擅长倾听",
    background: "心理咨询志愿者背景，偏好陪伴式对话。",
    hobbies: ["散步", "烘焙", "手帐"],
    speakingStyle: "温柔鼓励",
    status: "active",
    tagline: "先接住你，再一起解决问题",
    avatarColor: "var(--agent-coral)",
  },
  {
    id: "a3",
    name: "周沐川",
    persona: "理性、清晰、注重计划",
    background: "项目经理出身，擅长把目标变成任务清单。",
    hobbies: ["攀岩", "播客", "黑胶"],
    speakingStyle: "简洁直接",
    status: "active",
    tagline: "今天做一件小事，也是在推进人生",
    avatarColor: "var(--agent-teal)",
  },
];

export const seedMessages: Record<string, ChatMessage[]> = {
  default: [
    {
      id: "m1",
      role: "assistant",
      content: "晚上好。我在这，先从你今天最想说的一件事开始。",
      createdAt: "22:01",
    },
  ],
  a2: [
    {
      id: "m2",
      role: "assistant",
      content: "欢迎回来。你可以慢慢说，我会一直在这里听你。",
      createdAt: "21:32",
    },
  ],
  a3: [
    {
      id: "m3",
      role: "assistant",
      content: "我们先定一个最小可执行目标，10分钟就能完成的那种。",
      createdAt: "19:48",
    },
  ],
};

export const seedMemories: MemoryRecord[] = [
  {
    id: "mem-1",
    agentId: "default",
    memoryType: "profile",
    content: "用户名字是黄小满。",
    confidence: 0.93,
    importance: 0.86,
    status: "active",
    createdAt: "2026-04-07 14:20",
  },
  {
    id: "mem-2",
    agentId: "default",
    memoryType: "goal",
    content: "用户希望两个月内完成论文初稿。",
    confidence: 0.88,
    importance: 0.91,
    status: "active",
    createdAt: "2026-04-07 14:55",
  },
  {
    id: "mem-3",
    agentId: "a2",
    memoryType: "preference",
    content: "用户更喜欢鼓励式语气，不喜欢过度说教。",
    confidence: 0.81,
    importance: 0.73,
    status: "frozen",
    createdAt: "2026-04-07 12:11",
  },
];
