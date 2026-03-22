import {
  type AnySQLiteColumn,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const channelInstances = sqliteTable(
  "channel_instances",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    accountKey: text("account_key").notNull(),
    displayName: text("display_name"),
    status: text("status").notNull().default("active"),
    configRef: text("config_ref"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("uidx_channel_instances_provider_account_key").on(table.provider, table.accountKey),
  ],
);

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    channelInstanceId: text("channel_instance_id")
      .notNull()
      .references(() => channelInstances.id, { onDelete: "restrict" }),
    externalChatId: text("external_chat_id").notNull(),
    kind: text("kind").notNull(),
    title: text("title"),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("uidx_conversations_channel_external_chat").on(
      table.channelInstanceId,
      table.externalChatId,
    ),
    index("idx_conversations_channel_chat").on(table.channelInstanceId, table.externalChatId),
  ],
);

export const conversationBranches = sqliteTable(
  "conversation_branches",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    branchKey: text("branch_key").notNull(),
    externalBranchId: text("external_branch_id"),
    parentBranchId: text("parent_branch_id").references(
      (): AnySQLiteColumn => conversationBranches.id,
      {
        onDelete: "set null",
      },
    ),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("uidx_conversation_branches_conversation_branch_key").on(
      table.conversationId,
      table.branchKey,
    ),
    index("idx_branches_root_key").on(table.conversationId, table.branchKey),
  ],
);

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id")
    .notNull()
    .unique()
    .references(() => conversations.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  displayName: text("display_name"),
  policyProfile: text("policy_profile"),
  defaultModel: text("default_model"),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull(),
  archivedAt: text("archived_at"),
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    branchId: text("branch_id")
      .notNull()
      .references(() => conversationBranches.id, { onDelete: "cascade" }),
    ownerAgentId: text("owner_agent_id").references(() => agents.id, { onDelete: "set null" }),
    purpose: text("purpose").notNull(),
    contextMode: text("context_mode").notNull().default("isolated"),
    forkedFromSessionId: text("forked_from_session_id").references(
      (): AnySQLiteColumn => sessions.id,
      {
        onDelete: "set null",
      },
    ),
    forkSourceSeq: integer("fork_source_seq"),
    status: text("status").notNull().default("active"),
    compactCursor: integer("compact_cursor").notNull().default(0),
    compactSummary: text("compact_summary"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    endedAt: text("ended_at"),
  },
  (table) => [
    index("idx_sessions_branch_status_updated").on(table.branchId, table.status, table.updatedAt),
    index("idx_sessions_conversation_status_updated").on(
      table.conversationId,
      table.status,
      table.updatedAt,
    ),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    role: text("role").notNull(),
    messageType: text("message_type").notNull().default("text"),
    visibility: text("visibility").notNull().default("user_visible"),
    channelMessageId: text("channel_message_id"),
    provider: text("provider"),
    model: text("model"),
    modelApi: text("model_api"),
    stopReason: text("stop_reason"),
    errorMessage: text("error_message"),
    payloadJson: text("payload_json").notNull(),
    tokenInput: integer("token_input"),
    tokenOutput: integer("token_output"),
    tokenCacheRead: integer("token_cache_read"),
    tokenCacheWrite: integer("token_cache_write"),
    tokenTotal: integer("token_total"),
    usageJson: text("usage_json"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("uidx_messages_session_seq").on(table.sessionId, table.seq),
    index("idx_messages_session_seq").on(table.sessionId, table.seq),
    index("idx_messages_channel_msg").on(table.channelMessageId),
  ],
);

export const cronJobs = sqliteTable(
  "cron_jobs",
  {
    id: text("id").primaryKey(),
    ownerAgentId: text("owner_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    targetConversationId: text("target_conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    targetBranchId: text("target_branch_id")
      .notNull()
      .references(() => conversationBranches.id, { onDelete: "cascade" }),
    name: text("name"),
    scheduleKind: text("schedule_kind").notNull(),
    scheduleValue: text("schedule_value").notNull(),
    timezone: text("timezone"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    sessionTarget: text("session_target").notNull().default("isolated"),
    contextMode: text("context_mode").notNull().default("isolated"),
    payloadJson: text("payload_json").notNull(),
    nextRunAt: text("next_run_at"),
    lastRunAt: text("last_run_at"),
    lastStatus: text("last_status"),
    lastOutput: text("last_output"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    deleteAfterRun: integer("delete_after_run", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("idx_cron_due").on(table.enabled, table.nextRunAt)],
);

export const taskRuns = sqliteTable(
  "task_runs",
  {
    id: text("id").primaryKey(),
    runType: text("run_type").notNull(),
    ownerAgentId: text("owner_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    branchId: text("branch_id")
      .notNull()
      .references(() => conversationBranches.id, { onDelete: "cascade" }),
    initiatorSessionId: text("initiator_session_id").references(() => sessions.id, {
      onDelete: "set null",
    }),
    parentRunId: text("parent_run_id").references((): AnySQLiteColumn => taskRuns.id, {
      onDelete: "set null",
    }),
    cronJobId: text("cron_job_id").references(() => cronJobs.id, { onDelete: "set null" }),
    executionSessionId: text("execution_session_id")
      .unique()
      .references(() => sessions.id, { onDelete: "set null" }),
    status: text("status").notNull(),
    priority: integer("priority").notNull().default(0),
    attempt: integer("attempt").notNull().default(1),
    inputJson: text("input_json"),
    resultSummary: text("result_summary"),
    errorText: text("error_text"),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    durationMs: integer("duration_ms"),
    cancelledBy: text("cancelled_by"),
  },
  (table) => [
    index("idx_runs_conversation_status_started").on(
      table.conversationId,
      table.status,
      table.startedAt,
    ),
    index("idx_runs_owner_status_started").on(table.ownerAgentId, table.status, table.startedAt),
    index("idx_runs_cron_started").on(table.cronJobId, table.startedAt),
  ],
);

export const approvalLedger = sqliteTable(
  "approval_ledger",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ownerAgentId: text("owner_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    taskRunId: text("task_run_id")
      .notNull()
      .references(() => taskRuns.id, { onDelete: "cascade" }),
    requestedBySessionId: text("requested_by_session_id").references(() => sessions.id, {
      onDelete: "set null",
    }),
    requestSource: text("request_source").notNull(),
    requestedScopeJson: text("requested_scope_json").notNull(),
    decision: text("decision").notNull(),
    reasonText: text("reason_text"),
    usedHistoryLookup: integer("used_history_lookup", { mode: "boolean" }).notNull().default(false),
    modelSessionId: text("model_session_id").references(() => sessions.id, {
      onDelete: "set null",
    }),
    decidedAt: text("decided_at").notNull(),
  },
  (table) => [
    index("idx_approval_owner_time").on(table.ownerAgentId, table.decidedAt),
    index("idx_approval_task_run").on(table.taskRunId),
  ],
);

export const agentPermissionGrants = sqliteTable(
  "agent_permission_grants",
  {
    id: text("id").primaryKey(),
    ownerAgentId: text("owner_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    sourceApprovalId: integer("source_approval_id").references(() => approvalLedger.id, {
      onDelete: "set null",
    }),
    scopeJson: text("scope_json").notNull(),
    grantedBy: text("granted_by").notNull(),
    status: text("status").notNull().default("active"),
    ttlSeconds: integer("ttl_seconds"),
    grantedAt: text("granted_at").notNull(),
    expiresAt: text("expires_at"),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    index("idx_grants_owner_status_exp").on(table.ownerAgentId, table.status, table.expiresAt),
  ],
);

export const authEvents = sqliteTable(
  "auth_events",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
    eventType: text("event_type").notNull(),
    provider: text("provider"),
    status: text("status").notNull(),
    detailsJson: text("details_json"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("idx_auth_events_time").on(table.createdAt)],
);
