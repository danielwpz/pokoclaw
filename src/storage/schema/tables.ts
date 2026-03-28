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

export const channelSurfaces = sqliteTable(
  "channel_surfaces",
  {
    id: text("id").primaryKey(),
    channelType: text("channel_type").notNull(),
    channelInstallationId: text("channel_installation_id").notNull(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    branchId: text("branch_id")
      .notNull()
      .references(() => conversationBranches.id, { onDelete: "cascade" }),
    surfaceKey: text("surface_key").notNull(),
    surfaceObjectJson: text("surface_object_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("uidx_channel_surfaces_internal").on(
      table.channelType,
      table.channelInstallationId,
      table.conversationId,
      table.branchId,
    ),
    uniqueIndex("uidx_channel_surfaces_lookup").on(
      table.channelType,
      table.channelInstallationId,
      table.surfaceKey,
    ),
    index("idx_channel_surfaces_conversation_branch").on(table.conversationId, table.branchId),
  ],
);

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id")
    .notNull()
    .unique()
    .references(() => conversations.id, { onDelete: "cascade" }),
  mainAgentId: text("main_agent_id").references((): AnySQLiteColumn => agents.id, {
    onDelete: "set null",
  }),
  kind: text("kind").notNull(),
  displayName: text("display_name"),
  description: text("description"),
  workdir: text("workdir"),
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
    approvalForSessionId: text("approval_for_session_id").references(
      (): AnySQLiteColumn => sessions.id,
      {
        onDelete: "set null",
      },
    ),
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
    compactSummaryTokenTotal: integer("compact_summary_token_total"),
    compactSummaryUsageJson: text("compact_summary_usage_json"),
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
    index("idx_sessions_approval_for_status_updated").on(
      table.approvalForSessionId,
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
    runningAt: text("running_at"),
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
    description: text("description"),
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
    requestedBySessionId: text("requested_by_session_id").references(() => sessions.id, {
      onDelete: "set null",
    }),
    requestedScopeJson: text("requested_scope_json").notNull(),
    approvalTarget: text("approval_target").notNull(),
    status: text("status").notNull(),
    reasonText: text("reason_text"),
    expiresAt: text("expires_at"),
    resumePayloadJson: text("resume_payload_json"),
    createdAt: text("created_at").notNull(),
    decidedAt: text("decided_at"),
  },
  (table) => [
    index("idx_approval_owner_time").on(table.ownerAgentId, table.decidedAt),
    index("idx_approval_session_status_created").on(
      table.requestedBySessionId,
      table.status,
      table.createdAt,
    ),
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
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at"),
  },
  (table) => [index("idx_grants_owner_exp").on(table.ownerAgentId, table.expiresAt)],
);

export const subagentCreationRequests = sqliteTable(
  "subagent_creation_requests",
  {
    id: text("id").primaryKey(),
    sourceSessionId: text("source_session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    sourceAgentId: text("source_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    sourceConversationId: text("source_conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    channelInstanceId: text("channel_instance_id")
      .notNull()
      .references(() => channelInstances.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    description: text("description").notNull(),
    initialTask: text("initial_task").notNull(),
    workdir: text("workdir").notNull(),
    initialExtraScopesJson: text("initial_extra_scopes_json").notNull(),
    status: text("status").notNull(),
    createdSubagentAgentId: text("created_subagent_agent_id").references(
      (): AnySQLiteColumn => agents.id,
      {
        onDelete: "set null",
      },
    ),
    failureReason: text("failure_reason"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    decidedAt: text("decided_at"),
    expiresAt: text("expires_at"),
  },
  (table) => [
    index("idx_subagent_creation_requests_status_created").on(table.status, table.createdAt),
    index("idx_subagent_creation_requests_source_session").on(
      table.sourceSessionId,
      table.createdAt,
    ),
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

export const larkObjectBindings = sqliteTable(
  "lark_object_bindings",
  {
    id: text("id").primaryKey(),
    channelInstallationId: text("channel_installation_id").notNull(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    branchId: text("branch_id")
      .notNull()
      .references(() => conversationBranches.id, { onDelete: "cascade" }),
    internalObjectKind: text("internal_object_kind").notNull(),
    internalObjectId: text("internal_object_id").notNull(),
    larkMessageId: text("lark_message_id"),
    larkOpenMessageId: text("lark_open_message_id"),
    larkCardId: text("lark_card_id"),
    threadRootMessageId: text("thread_root_message_id"),
    cardElementId: text("card_element_id"),
    lastSequence: integer("last_sequence"),
    status: text("status").notNull().default("active"),
    metadataJson: text("metadata_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("uidx_lark_object_bindings_internal").on(
      table.channelInstallationId,
      table.internalObjectKind,
      table.internalObjectId,
    ),
    uniqueIndex("uidx_lark_object_bindings_message").on(
      table.channelInstallationId,
      table.larkMessageId,
    ),
    uniqueIndex("uidx_lark_object_bindings_open_message").on(
      table.channelInstallationId,
      table.larkOpenMessageId,
    ),
    uniqueIndex("uidx_lark_object_bindings_card").on(table.channelInstallationId, table.larkCardId),
    index("idx_lark_object_bindings_conversation_branch").on(table.conversationId, table.branchId),
    index("idx_lark_object_bindings_thread_root").on(
      table.channelInstallationId,
      table.threadRootMessageId,
    ),
  ],
);
