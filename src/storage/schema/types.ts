import type { InferInsertModel, InferSelectModel } from "drizzle-orm";

import type {
  agentPermissionGrants,
  agents,
  approvalLedger,
  authEvents,
  channelInstances,
  conversationBranches,
  conversations,
  cronJobs,
  messages,
  sessions,
  subagentCreationRequests,
  taskRuns,
} from "@/src/storage/schema/tables.js";

export type ChannelInstance = InferSelectModel<typeof channelInstances>;
export type NewChannelInstance = InferInsertModel<typeof channelInstances>;

export type Conversation = InferSelectModel<typeof conversations>;
export type NewConversation = InferInsertModel<typeof conversations>;

export type ConversationBranch = InferSelectModel<typeof conversationBranches>;
export type NewConversationBranch = InferInsertModel<typeof conversationBranches>;

export type Agent = InferSelectModel<typeof agents>;
export type NewAgent = InferInsertModel<typeof agents>;

export type Session = InferSelectModel<typeof sessions>;
export type NewSession = InferInsertModel<typeof sessions>;

export type Message = InferSelectModel<typeof messages>;
export type NewMessage = InferInsertModel<typeof messages>;

export type CronJob = InferSelectModel<typeof cronJobs>;
export type NewCronJob = InferInsertModel<typeof cronJobs>;

export type TaskRun = InferSelectModel<typeof taskRuns>;
export type NewTaskRun = InferInsertModel<typeof taskRuns>;

export type ApprovalRecord = InferSelectModel<typeof approvalLedger>;
export type NewApprovalRecord = InferInsertModel<typeof approvalLedger>;

export type AgentPermissionGrant = InferSelectModel<typeof agentPermissionGrants>;
export type NewAgentPermissionGrant = InferInsertModel<typeof agentPermissionGrants>;

export type SubagentCreationRequest = InferSelectModel<typeof subagentCreationRequests>;
export type NewSubagentCreationRequest = InferInsertModel<typeof subagentCreationRequests>;

export type AuthEvent = InferSelectModel<typeof authEvents>;
export type NewAuthEvent = InferInsertModel<typeof authEvents>;
