import { relations } from "drizzle-orm";

import {
  agentPermissionGrants,
  agents,
  approvalLedger,
  authEvents,
  channelInstances,
  channelSurfaces,
  conversationBranches,
  conversations,
  cronJobs,
  harnessEvents,
  larkObjectBindings,
  messages,
  sessions,
  subagentCreationRequests,
  taskRuns,
} from "@/src/storage/schema/tables.js";

export const channelInstancesRelations = relations(channelInstances, ({ many }) => ({
  conversations: many(conversations),
  subagentCreationRequests: many(subagentCreationRequests),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  channelInstance: one(channelInstances, {
    fields: [conversations.channelInstanceId],
    references: [channelInstances.id],
  }),
  branches: many(conversationBranches),
  channelSurfaces: many(channelSurfaces),
  larkObjectBindings: many(larkObjectBindings),
  sessions: many(sessions),
  taskRuns: many(taskRuns),
  harnessEvents: many(harnessEvents),
  subagentCreationRequests: many(subagentCreationRequests),
}));

export const conversationBranchesRelations = relations(conversationBranches, ({ one, many }) => ({
  conversation: one(conversations, {
    fields: [conversationBranches.conversationId],
    references: [conversations.id],
  }),
  channelSurfaces: many(channelSurfaces),
  larkObjectBindings: many(larkObjectBindings),
  sessions: many(sessions),
  taskRuns: many(taskRuns),
  harnessEvents: many(harnessEvents),
}));

export const channelSurfacesRelations = relations(channelSurfaces, ({ one }) => ({
  conversation: one(conversations, {
    fields: [channelSurfaces.conversationId],
    references: [conversations.id],
  }),
  branch: one(conversationBranches, {
    fields: [channelSurfaces.branchId],
    references: [conversationBranches.id],
  }),
}));

export const agentsRelations = relations(agents, ({ one, many }) => ({
  conversation: one(conversations, {
    fields: [agents.conversationId],
    references: [conversations.id],
  }),
  mainAgent: one(agents, {
    fields: [agents.mainAgentId],
    references: [agents.id],
    relationName: "agent_main_agent",
  }),
  managedAgents: many(agents, {
    relationName: "agent_main_agent",
  }),
  cronJobs: many(cronJobs),
  taskRuns: many(taskRuns),
  approvals: many(approvalLedger),
  permissionGrants: many(agentPermissionGrants),
  authEvents: many(authEvents),
  harnessEvents: many(harnessEvents),
  subagentCreationRequests: many(subagentCreationRequests, {
    relationName: "subagent_creation_request_source_agent",
  }),
  createdFromRequests: many(subagentCreationRequests, {
    relationName: "subagent_creation_request_created_agent",
  }),
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
  approvals: many(approvalLedger),
  subagentCreationRequests: many(subagentCreationRequests),
  harnessEvents: many(harnessEvents),
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
  harnessEvents: many(harnessEvents),
}));

export const taskRunsRelations = relations(taskRuns, ({ one }) => ({
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
}));

export const approvalLedgerRelations = relations(approvalLedger, ({ one }) => ({
  ownerAgent: one(agents, {
    fields: [approvalLedger.ownerAgentId],
    references: [agents.id],
  }),
  requestedBySession: one(sessions, {
    fields: [approvalLedger.requestedBySessionId],
    references: [sessions.id],
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

export const harnessEventsRelations = relations(harnessEvents, ({ one }) => ({
  session: one(sessions, {
    fields: [harnessEvents.sessionId],
    references: [sessions.id],
  }),
  conversation: one(conversations, {
    fields: [harnessEvents.conversationId],
    references: [conversations.id],
  }),
  branch: one(conversationBranches, {
    fields: [harnessEvents.branchId],
    references: [conversationBranches.id],
  }),
  agent: one(agents, {
    fields: [harnessEvents.agentId],
    references: [agents.id],
  }),
  taskRun: one(taskRuns, {
    fields: [harnessEvents.taskRunId],
    references: [taskRuns.id],
  }),
  cronJob: one(cronJobs, {
    fields: [harnessEvents.cronJobId],
    references: [cronJobs.id],
  }),
}));

export const larkObjectBindingsRelations = relations(larkObjectBindings, ({ one }) => ({
  conversation: one(conversations, {
    fields: [larkObjectBindings.conversationId],
    references: [conversations.id],
  }),
  branch: one(conversationBranches, {
    fields: [larkObjectBindings.branchId],
    references: [conversationBranches.id],
  }),
}));

export const subagentCreationRequestsRelations = relations(subagentCreationRequests, ({ one }) => ({
  sourceSession: one(sessions, {
    fields: [subagentCreationRequests.sourceSessionId],
    references: [sessions.id],
  }),
  sourceAgent: one(agents, {
    fields: [subagentCreationRequests.sourceAgentId],
    references: [agents.id],
    relationName: "subagent_creation_request_source_agent",
  }),
  sourceConversation: one(conversations, {
    fields: [subagentCreationRequests.sourceConversationId],
    references: [conversations.id],
  }),
  channelInstance: one(channelInstances, {
    fields: [subagentCreationRequests.channelInstanceId],
    references: [channelInstances.id],
  }),
  createdSubagent: one(agents, {
    fields: [subagentCreationRequests.createdSubagentAgentId],
    references: [agents.id],
    relationName: "subagent_creation_request_created_agent",
  }),
}));
