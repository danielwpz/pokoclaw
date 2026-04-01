/**
 * Delegated approval delivery and decision flow.
 *
 * Handles the "main agent approves for unattended runs" path: create approval
 * review input, deliver into dedicated approval session, parse decisions, and
 * feed results back into runtime approval-resume ingress.
 */
import { resolveOrCreateMainAgentApprovalSession } from "@/src/orchestration/approval-session.js";
import type { ApprovalResponseInput } from "@/src/runtime/approval-waits.js";
import type { SubmitMessageInput, SubmitMessageResult } from "@/src/runtime/ingress.js";
import { describePermissionScope, parsePermissionRequestJson } from "@/src/security/scope.js";
import { createSubsystemLogger } from "@/src/shared/logger.js";
import type { StorageDb } from "@/src/storage/db/client.js";
import { AgentsRepo } from "@/src/storage/repos/agents.repo.js";
import { ApprovalsRepo } from "@/src/storage/repos/approvals.repo.js";
import { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import { TaskRunsRepo } from "@/src/storage/repos/task-runs.repo.js";
import type { Message } from "@/src/storage/schema/types.js";

const logger = createSubsystemLogger("orchestration/delegated-approval");
const APPROVAL_SESSION_MAX_DECISION_REMINDERS = 1;
const AUTO_DENY_REASON = "Approval review session ended without an explicit decision.";
const DELEGATED_APPROVAL_GUIDANCE_LINES = [
  "A background run paused because it needs approval.",
  "Review the request in the context of the current task before approving or denying it.",
];
const APPROVAL_DECISION_REMINDER_LINES = [
  "The approval is still pending.",
  "You may inspect available read-only tools if needed, but you must now call review_permission_request exactly once.",
  "Do not continue the task itself.",
];

export interface DelegatedApprovalDeliveryResult {
  status:
    | "delivered"
    | "delivered_reused_session"
    | "missing_approval"
    | "not_main_agent_target"
    | "missing_main_session";
  approvalId: number;
  targetSessionId?: string;
}

export interface DelegatedApprovalMessageIngress {
  submitMessage(input: SubmitMessageInput): Promise<SubmitMessageResult>;
  submitApprovalDecision(input: ApprovalResponseInput): boolean;
}

export async function deliverDelegatedApprovalRequest(input: {
  db: StorageDb;
  ingress: DelegatedApprovalMessageIngress;
  approvalId: number;
}): Promise<DelegatedApprovalDeliveryResult> {
  const approvalsRepo = new ApprovalsRepo(input.db);
  const approval = approvalsRepo.getById(input.approvalId);
  if (approval == null) {
    return {
      status: "missing_approval",
      approvalId: input.approvalId,
    };
  }

  if (approval.approvalTarget !== "main_agent") {
    return {
      status: "not_main_agent_target",
      approvalId: input.approvalId,
    };
  }

  if (approval.requestedBySessionId == null) {
    return {
      status: "missing_main_session",
      approvalId: input.approvalId,
    };
  }

  const approvalSession = resolveOrCreateMainAgentApprovalSession({
    db: input.db,
    ownerAgentId: approval.ownerAgentId,
    sourceSessionId: approval.requestedBySessionId,
    approvalId: approval.id,
    createdAt: new Date(approval.createdAt),
  });
  if (approvalSession == null) {
    return {
      status: "missing_main_session",
      approvalId: input.approvalId,
    };
  }

  const requestMessage = renderDelegatedApprovalMessage({
    approvalId: approval.id,
    ownerAgentId: approval.ownerAgentId,
    reasonText: approval.reasonText,
    requestedScopeJson: approval.requestedScopeJson,
    context: buildDelegatedApprovalContext({
      db: input.db,
      sourceSessionId: approval.requestedBySessionId,
      ownerAgentId: approval.ownerAgentId,
    }),
    history: listRecentApprovalHistory({
      approvalsRepo,
      sourceSessionId: approval.requestedBySessionId,
      currentApprovalId: approval.id,
    }),
  });
  await driveApprovalSessionToDecision({
    approvalsRepo,
    ingress: input.ingress,
    approvalId: approval.id,
    approvalSessionId: approvalSession.session.id,
    initialMessage: requestMessage,
  });

  return {
    status: approvalSession.created ? "delivered" : "delivered_reused_session",
    approvalId: approval.id,
    targetSessionId: approvalSession.session.id,
  };
}

async function driveApprovalSessionToDecision(input: {
  approvalsRepo: ApprovalsRepo;
  ingress: DelegatedApprovalMessageIngress;
  approvalId: number;
  approvalSessionId: string;
  initialMessage: string;
}): Promise<void> {
  for (let reminder = 0; reminder <= APPROVAL_SESSION_MAX_DECISION_REMINDERS; reminder += 1) {
    const content =
      reminder === 0
        ? input.initialMessage
        : renderApprovalDecisionReminder({
            approvalId: input.approvalId,
          });
    const messageType = reminder === 0 ? "approval_request" : "approval_followup";

    try {
      await input.ingress.submitMessage({
        sessionId: input.approvalSessionId,
        scenario: "chat",
        content,
        messageType,
        visibility: "hidden_system",
      });
    } catch (error) {
      logger.warn("approval session run failed before decision", {
        approvalId: input.approvalId,
        approvalSessionId: input.approvalSessionId,
        reminder,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const approval = input.approvalsRepo.getById(input.approvalId);
    if (approval == null || approval.status !== "pending") {
      return;
    }

    logger.info("approval session ended without explicit decision", {
      approvalId: input.approvalId,
      approvalSessionId: input.approvalSessionId,
      reminder,
    });
  }

  const matched = input.ingress.submitApprovalDecision({
    approvalId: input.approvalId,
    decision: "deny",
    actor: "system:approval_session_auto_deny",
    rawInput: null,
    reasonText: AUTO_DENY_REASON,
    decidedAt: new Date(),
  });

  logger.warn("auto-denied delegated approval after missing decision", {
    approvalId: input.approvalId,
    approvalSessionId: input.approvalSessionId,
    matched,
  });
}

export function renderDelegatedApprovalMessage(input: {
  approvalId: number;
  ownerAgentId: string;
  reasonText: string | null;
  requestedScopeJson: string;
  context?: DelegatedApprovalContext;
  history?: ApprovalHistoryItem[];
}): string {
  const request = parsePermissionRequestJson(input.requestedScopeJson);
  const lines = request.scopes.map((scope) => `- ${describePermissionScope(scope)}`);
  const history = input.history ?? [];

  const rendered = [
    renderXmlEnvelope("delegated_approval_request", [
      ...renderSingleLineElement("approval_id", String(input.approvalId)),
      ...renderSingleLineElement("owner_agent_id", input.ownerAgentId),
      "",
      ...renderMultilineElement(
        "summary",
        escapeXmlText(input.reasonText ?? "A background run needs additional approval."),
      ),
      "",
      ...renderLineBlock("requested_permissions", lines),
      "",
      ...renderLineBlock("guidance", DELEGATED_APPROVAL_GUIDANCE_LINES),
    ]),
  ];

  if (input.context != null && hasDelegatedApprovalContext(input.context)) {
    rendered.push("", ...renderDelegatedApprovalContext(input.context));
  }

  if (history.length > 0) {
    rendered.push(
      "",
      "<approval_history>",
      ...history.flatMap((item) => [
        "  <item>",
        `    <approval_id>${item.approvalId}</approval_id>`,
        `    <decision>${item.decision}</decision>`,
        `    <permissions>${item.permissions}</permissions>`,
        `    <reason>${item.reason}</reason>`,
        "  </item>",
      ]),
      "</approval_history>",
    );
  }

  return rendered.join("\n");
}

interface ApprovalHistoryItem {
  approvalId: number;
  decision: "approved" | "denied";
  permissions: string;
  reason: string;
}

interface DelegatedApprovalContext {
  sessionPurpose?: string;
  agentKind?: string;
  agentDescription?: string;
  taskRunId?: string;
  runType?: string;
  taskDescription?: string;
  taskInputSummary?: string;
  recentTranscript?: DelegatedTranscriptEntry[];
}

interface DelegatedTranscriptEntry {
  seq: number;
  role: string;
  summary: string;
}

function listRecentApprovalHistory(input: {
  approvalsRepo: ApprovalsRepo;
  sourceSessionId: string;
  currentApprovalId: number;
}): ApprovalHistoryItem[] {
  return input.approvalsRepo
    .listBySession(input.sourceSessionId, {
      statuses: ["approved", "denied"],
      limit: 8,
    })
    .filter((approval) => approval.id !== input.currentApprovalId)
    .slice(0, 3)
    .reverse()
    .map((approval) => {
      const request = parsePermissionRequestJson(approval.requestedScopeJson);
      const permissions =
        request.scopes.length === 1 && request.scopes[0] != null
          ? describePermissionScope(request.scopes[0])
          : `${request.scopes.length} permissions`;
      const decision: ApprovalHistoryItem["decision"] =
        approval.status === "approved" ? "approved" : "denied";

      return {
        approvalId: approval.id,
        decision,
        permissions,
        reason: approval.reasonText ?? "No reason recorded.",
      };
    });
}

function buildDelegatedApprovalContext(input: {
  db: StorageDb;
  sourceSessionId: string;
  ownerAgentId: string;
}): DelegatedApprovalContext {
  const agentsRepo = new AgentsRepo(input.db);
  const messagesRepo = new MessagesRepo(input.db);
  const sessionsRepo = new SessionsRepo(input.db);
  const taskRunsRepo = new TaskRunsRepo(input.db);

  const agent = agentsRepo.getById(input.ownerAgentId);
  const sourceSession = sessionsRepo.getById(input.sourceSessionId);
  const taskRun = taskRunsRepo.getByExecutionSessionId(input.sourceSessionId);
  const recentTranscript = messagesRepo
    .listBySession(input.sourceSessionId)
    .slice(-5)
    .map((message) => summarizeTranscriptMessage(message))
    .filter((entry): entry is DelegatedTranscriptEntry => entry != null);

  return {
    ...(sourceSession == null ? {} : { sessionPurpose: sourceSession.purpose }),
    ...(agent?.kind == null ? {} : { agentKind: agent.kind }),
    ...(agent?.description == null ? {} : { agentDescription: agent.description }),
    ...(taskRun?.id == null ? {} : { taskRunId: taskRun.id }),
    ...(taskRun?.runType == null ? {} : { runType: taskRun.runType }),
    ...(taskRun?.description == null ? {} : { taskDescription: taskRun.description }),
    ...(taskRun?.inputJson == null
      ? {}
      : { taskInputSummary: summarizeTaskInput(taskRun.inputJson) }),
    ...(recentTranscript.length === 0 ? {} : { recentTranscript }),
  };
}

function hasDelegatedApprovalContext(input: DelegatedApprovalContext): boolean {
  return (
    input.sessionPurpose != null ||
    input.agentKind != null ||
    input.agentDescription != null ||
    input.taskRunId != null ||
    input.runType != null ||
    input.taskDescription != null ||
    input.taskInputSummary != null ||
    (input.recentTranscript?.length ?? 0) > 0
  );
}

function renderDelegatedApprovalContext(input: DelegatedApprovalContext): string[] {
  const lines = renderXmlBody([
    ...renderOptionalSingleLineElement("session_purpose", input.sessionPurpose),
    ...renderOptionalSingleLineElement("agent_kind", input.agentKind),
    ...renderOptionalMultilineElement("agent_description", input.agentDescription),
    ...renderOptionalSingleLineElement("task_run_id", input.taskRunId),
    ...renderOptionalSingleLineElement("run_type", input.runType),
    ...renderOptionalMultilineElement("task_description", input.taskDescription),
    ...renderOptionalMultilineElement("task_input", input.taskInputSummary),
  ]);

  if ((input.recentTranscript?.length ?? 0) === 0) {
    return ["<task_context>", ...lines, "</task_context>"];
  }

  return [
    "<task_context>",
    ...lines,
    "</task_context>",
    "",
    "<recent_task_transcript>",
    ...(input.recentTranscript ?? []).flatMap((message) =>
      renderXmlBody([
        "  <message>",
        ...renderSingleLineElement("seq", String(message.seq), 4),
        ...renderSingleLineElement("role", escapeXmlText(message.role), 4),
        ...renderMultilineElement("summary", escapeXmlText(message.summary), 4, 6),
        "  </message>",
      ]),
    ),
    "</recent_task_transcript>",
  ];
}

function renderApprovalDecisionReminder(input: { approvalId: number }): string {
  return renderXmlEnvelope("approval_decision_required", [
    ...renderSingleLineElement("approval_id", String(input.approvalId)),
    "",
    ...renderLineBlock("guidance", APPROVAL_DECISION_REMINDER_LINES),
  ]);
}

function summarizeTranscriptMessage(message: Message): DelegatedTranscriptEntry | null {
  try {
    const payload = JSON.parse(message.payloadJson) as Record<string, unknown>;
    switch (message.role) {
      case "user":
        return {
          seq: message.seq,
          role: "user",
          summary: summarizeFreeText(payload.content),
        };
      case "assistant":
        return {
          seq: message.seq,
          role: "assistant",
          summary: summarizeAssistantPayload(payload.content),
        };
      case "tool":
        return {
          seq: message.seq,
          role: "tool",
          summary: summarizeToolPayload(payload),
        };
      default:
        return null;
    }
  } catch {
    return {
      seq: message.seq,
      role: message.role,
      summary: truncateText(message.payloadJson, 240),
    };
  }
}

function summarizeAssistantPayload(content: unknown): string {
  if (!Array.isArray(content)) {
    return "Assistant turn.";
  }

  const textParts: string[] = [];
  const toolCalls: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block == null) {
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      textParts.push(truncateText(record.text, 140));
      continue;
    }
    if (record.type === "toolCall") {
      const argsSummary =
        record.arguments == null
          ? ""
          : ` args=${truncateText(JSON.stringify(record.arguments), 100)}`;
      toolCalls.push(`assistant requested a tool action${argsSummary}`);
    }
  }

  const parts = [];
  if (textParts.length > 0) {
    parts.push(`text=${textParts.join(" | ")}`);
  }
  if (toolCalls.length > 0) {
    parts.push(`tool_calls=${toolCalls.join(", ")}`);
  }
  return parts.length === 0 ? "Assistant turn." : parts.join(" ; ");
}

function renderXmlEnvelope(tagName: string, bodyLines: string[]): string {
  return [`<${tagName}>`, ...bodyLines, `</${tagName}>`].join("\n");
}

function renderXmlBody(lines: string[]): string[] {
  return lines.filter((line, index, allLines) => {
    if (line !== "") {
      return true;
    }
    return index > 0 && index < allLines.length - 1;
  });
}

function renderSingleLineElement(tagName: string, value: string, indent = 2): string[] {
  const prefix = " ".repeat(indent);
  return [`${prefix}<${tagName}>${value}</${tagName}>`];
}

function renderOptionalSingleLineElement(
  tagName: string,
  value: string | null | undefined,
  indent = 2,
): string[] {
  return value == null ? [] : renderSingleLineElement(tagName, escapeXmlText(value), indent);
}

function renderOptionalMultilineElement(
  tagName: string,
  value: string | null | undefined,
  indent = 2,
  contentIndent = indent + 2,
): string[] {
  if (value == null) {
    return [];
  }

  return renderMultilineElement(tagName, escapeXmlText(value), indent, contentIndent);
}

function renderMultilineElement(
  tagName: string,
  value: string,
  indent = 2,
  contentIndent = indent + 2,
): string[] {
  const prefix = " ".repeat(indent);
  return [`${prefix}<${tagName}>`, indentText(value, contentIndent), `${prefix}</${tagName}>`];
}

function renderLineBlock(
  tagName: string,
  lines: readonly string[],
  indent = 2,
  contentIndent = indent + 2,
): string[] {
  const prefix = " ".repeat(indent);
  const contentPrefix = " ".repeat(contentIndent);
  return [
    `${prefix}<${tagName}>`,
    ...lines.map((line) => `${contentPrefix}${line}`),
    `${prefix}</${tagName}>`,
  ];
}

function summarizeToolPayload(payload: Record<string, unknown>): string {
  const isError = payload.isError === true;
  const details = payload.details;
  if (isPermissionDeniedDetails(details)) {
    return `blocked by permissions: ${details.summary}`;
  }

  const content = Array.isArray(payload.content) ? payload.content : [];
  const text = content
    .map((block) => {
      if (typeof block !== "object" || block == null) {
        return "";
      }
      const record = block as Record<string, unknown>;
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter((entry) => entry.length > 0)
    .join(" | ");

  return `${isError ? "tool error" : "tool result"}: ${truncateText(text, 180)}`;
}

function isPermissionDeniedDetails(value: unknown): value is { summary: string } {
  if (typeof value !== "object" || value == null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return candidate.code === "permission_denied" && typeof candidate.summary === "string";
}

function summarizeTaskInput(inputJson: string): string {
  try {
    return truncateText(JSON.stringify(JSON.parse(inputJson)), 240);
  } catch {
    return truncateText(inputJson, 240);
  }
}

function summarizeFreeText(value: unknown): string {
  return typeof value === "string" ? truncateText(value, 220) : "Non-text user content.";
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function indentText(value: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return value.split("\n").join(`\n${prefix}`);
}
