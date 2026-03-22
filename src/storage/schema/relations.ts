import { relations } from "drizzle-orm";

import {
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
  taskRuns,
} from "@/src/storage/schema/tables.js";

export const channelInstancesRelations = relations(channelInstances, ({ many }) => ({
  conversations: many(conversations),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  channelInstance: one(channelInstances, {
    fields: [conversations.channelInstanceId],
    references: [channelInstances.id],
  }),
  branches: many(conversationBranches),
  sessions: many(sessions),
  taskRuns: many(taskRuns),
  approvals: many(approvalLedger),
}));

export const conversationBranchesRelations = relations(conversationBranches, ({ one, many }) => ({
  conversation: one(conversations, {
    fields: [conversationBranches.conversationId],
    references: [conversations.id],
  }),
  sessions: many(sessions),
  taskRuns: many(taskRuns),
}));

export const agentsRelations = relations(agents, ({ one, many }) => ({
  conversation: one(conversations, {
    fields: [agents.conversationId],
    references: [conversations.id],
  }),
  cronJobs: many(cronJobs),
  taskRuns: many(taskRuns),
  approvals: many(approvalLedger),
  permissionGrants: many(agentPermissionGrants),
  authEvents: many(authEvents),
}));

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  conversation: one(conversations, {
    fields: [sessions.conversationId],
    references: [conversations.id],
  }),
  branch: one(conversationBranches, {
    fields: [sessions.branchId],
    references: [conversationBranches.id],
  }),
  ownerAgent: one(agents, {
    fields: [sessions.ownerAgentId],
    references: [agents.id],
  }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  session: one(sessions, {
    fields: [messages.sessionId],
    references: [sessions.id],
  }),
}));

export const cronJobsRelations = relations(cronJobs, ({ one, many }) => ({
  ownerAgent: one(agents, {
    fields: [cronJobs.ownerAgentId],
    references: [agents.id],
  }),
  targetConversation: one(conversations, {
    fields: [cronJobs.targetConversationId],
    references: [conversations.id],
  }),
  targetBranch: one(conversationBranches, {
    fields: [cronJobs.targetBranchId],
    references: [conversationBranches.id],
  }),
  taskRuns: many(taskRuns),
}));

export const taskRunsRelations = relations(taskRuns, ({ one, many }) => ({
  ownerAgent: one(agents, {
    fields: [taskRuns.ownerAgentId],
    references: [agents.id],
  }),
  conversation: one(conversations, {
    fields: [taskRuns.conversationId],
    references: [conversations.id],
  }),
  branch: one(conversationBranches, {
    fields: [taskRuns.branchId],
    references: [conversationBranches.id],
  }),
  cronJob: one(cronJobs, {
    fields: [taskRuns.cronJobId],
    references: [cronJobs.id],
  }),
  approvals: many(approvalLedger),
}));

export const approvalLedgerRelations = relations(approvalLedger, ({ one }) => ({
  ownerAgent: one(agents, {
    fields: [approvalLedger.ownerAgentId],
    references: [agents.id],
  }),
  taskRun: one(taskRuns, {
    fields: [approvalLedger.taskRunId],
    references: [taskRuns.id],
  }),
}));

export const agentPermissionGrantsRelations = relations(agentPermissionGrants, ({ one }) => ({
  ownerAgent: one(agents, {
    fields: [agentPermissionGrants.ownerAgentId],
    references: [agents.id],
  }),
  sourceApproval: one(approvalLedger, {
    fields: [agentPermissionGrants.sourceApprovalId],
    references: [approvalLedger.id],
  }),
}));

export const authEventsRelations = relations(authEvents, ({ one }) => ({
  conversation: one(conversations, {
    fields: [authEvents.conversationId],
    references: [conversations.id],
  }),
  agent: one(agents, {
    fields: [authEvents.agentId],
    references: [agents.id],
  }),
}));
