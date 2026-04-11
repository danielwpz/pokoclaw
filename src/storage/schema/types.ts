import type { InferInsertModel, InferSelectModel } from "drizzle-orm";

import type {
  agentPermissionGrants,
  agents,
  approvalLedger,
  authEvents,
  channelInstances,
  channelSurfaces,
  channelThreads,
  conversationBranches,
  conversations,
  cronJobs,
  harnessEvents,
  larkObjectBindings,
  meditationState,
  messages,
  sessions,
  subagentCreationRequests,
  taskRuns,
  taskWorkstreams,
} from "@/src/storage/schema/tables.js";

export type ChannelInstance = InferSelectModel<typeof channelInstances>;
export type NewChannelInstance = InferInsertModel<typeof channelInstances>;

export type Conversation = InferSelectModel<typeof conversations>;
export type NewConversation = InferInsertModel<typeof conversations>;

export type ConversationBranch = InferSelectModel<typeof conversationBranches>;
export type NewConversationBranch = InferInsertModel<typeof conversationBranches>;

export type ChannelSurface = InferSelectModel<typeof channelSurfaces>;
export type NewChannelSurface = InferInsertModel<typeof channelSurfaces>;

export type ChannelThread = InferSelectModel<typeof channelThreads>;
export type NewChannelThread = InferInsertModel<typeof channelThreads>;

export type Agent = InferSelectModel<typeof agents>;
export type NewAgent = InferInsertModel<typeof agents>;

export type TaskWorkstream = InferSelectModel<typeof taskWorkstreams>;
export type NewTaskWorkstream = InferInsertModel<typeof taskWorkstreams>;

export type Session = InferSelectModel<typeof sessions>;
export type NewSession = InferInsertModel<typeof sessions>;

export type Message = InferSelectModel<typeof messages>;
export type NewMessage = InferInsertModel<typeof messages>;

export type CronJob = InferSelectModel<typeof cronJobs>;
export type NewCronJob = InferInsertModel<typeof cronJobs>;

export type TaskRun = InferSelectModel<typeof taskRuns>;
export type NewTaskRun = InferInsertModel<typeof taskRuns>;

export type MeditationState = InferSelectModel<typeof meditationState>;
export type NewMeditationState = InferInsertModel<typeof meditationState>;

export type ApprovalRecord = InferSelectModel<typeof approvalLedger>;
export type NewApprovalRecord = InferInsertModel<typeof approvalLedger>;

export type AgentPermissionGrant = InferSelectModel<typeof agentPermissionGrants>;
export type NewAgentPermissionGrant = InferInsertModel<typeof agentPermissionGrants>;

export type SubagentCreationRequest = InferSelectModel<typeof subagentCreationRequests>;
export type NewSubagentCreationRequest = InferInsertModel<typeof subagentCreationRequests>;

export type AuthEvent = InferSelectModel<typeof authEvents>;
export type NewAuthEvent = InferInsertModel<typeof authEvents>;

export type HarnessEvent = InferSelectModel<typeof harnessEvents>;
export type NewHarnessEvent = InferInsertModel<typeof harnessEvents>;

export type LarkObjectBinding = InferSelectModel<typeof larkObjectBindings>;
export type NewLarkObjectBinding = InferInsertModel<typeof larkObjectBindings>;
