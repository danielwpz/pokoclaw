import type { ModelScenario } from "@/src/agent/llm/models.js";
import { extractCronTaskDefinition } from "@/src/cron/payload.js";
import type { TaskRun } from "@/src/storage/schema/types.js";

export interface TaskExecutionKickoffEnvelope {
  scenario: ModelScenario;
  content: string;
  messageType: string;
  visibility: "hidden_system";
}

export interface CronKickoffRunReference {
  startedAt: string;
  status: string;
  summary?: string | null;
  error?: string | null;
}

export interface CronKickoffContext {
  taskDefinition?: string | null;
  lastRun?: CronKickoffRunReference | null;
  lastSuccessfulRun?: CronKickoffRunReference | null;
}

export function resolveTaskExecutionScenario(runType: string): ModelScenario {
  return runType === "cron" ? "cron" : "subagent";
}

export function buildTaskExecutionKickoffEnvelope(
  taskRun: Pick<TaskRun, "runType" | "description" | "inputJson">,
  options: {
    cronContext?: CronKickoffContext;
  } = {},
): TaskExecutionKickoffEnvelope {
  return {
    scenario: resolveTaskExecutionScenario(taskRun.runType),
    messageType: taskRun.runType === "cron" ? "cron_kickoff" : "task_kickoff",
    visibility: "hidden_system",
    content: renderTaskKickoffMessage(taskRun, options),
  };
}

export function buildTaskExecutionSupervisorReminderEnvelope(input: {
  runType: string;
  nextPass: number;
  maxPasses: number;
}): TaskExecutionKickoffEnvelope {
  const lines = [
    "<task_supervisor_followup>",
    `  <run_type>${input.runType}</run_type>`,
    `  <next_pass>${input.nextPass}</next_pass>`,
    `  <max_passes>${input.maxPasses}</max_passes>`,
    "  <guidance>",
    "    This unattended task run ended without calling finish_task.",
    "    Do not wait for a user reply.",
    "    Continue the work if there is still concrete work left to do.",
    '    If the task is already complete, explicitly call finish_task with status="completed".',
    '    If the task is blocked on missing information, credentials, or a user decision, explicitly call finish_task with status="blocked".',
    '    If the task has failed and should stop, explicitly call finish_task with status="failed".',
    "    You must call finish_task before this task can be considered settled.",
    "  </guidance>",
    "</task_supervisor_followup>",
  ];

  return {
    scenario: resolveTaskExecutionScenario(input.runType),
    messageType: "task_supervisor_followup",
    visibility: "hidden_system",
    content: lines.join("\n"),
  };
}

function renderTaskKickoffMessage(
  taskRun: Pick<TaskRun, "runType" | "description" | "inputJson">,
  options: {
    cronContext?: CronKickoffContext;
  },
) {
  const lines = ["<task_execution>"];
  const cronContext = options.cronContext ?? extractCronContextFromInput(taskRun);

  lines.push(`  <run_type>${taskRun.runType}</run_type>`);

  if (taskRun.description != null && taskRun.description.trim().length > 0) {
    lines.push("  <description>");
    lines.push(`  ${taskRun.description.trim()}`);
    lines.push("  </description>");
  }

  if (taskRun.inputJson != null && taskRun.inputJson.trim().length > 0) {
    if (taskRun.runType === "cron") {
      appendCronTaskDefinition(lines, cronContext);
      appendCronRecentRuns(lines, cronContext);
    } else {
      lines.push("  <input>");
      lines.push(indentBlock(formatTaskInput(taskRun.inputJson), 4));
      lines.push("  </input>");
    }
  } else if (taskRun.runType === "cron") {
    appendCronTaskDefinition(lines, cronContext);
    appendCronRecentRuns(lines, cronContext);
  }

  lines.push("  <guidance>");
  lines.push("    Execute this background task in this session.");
  lines.push("    Use tools directly when they help move the task forward.");
  lines.push("    Keep the work in this task session; do not assume a user is watching live.");
  lines.push(
    "    This session is unattended. Do not wait for live user feedback before ending the task.",
  );
  lines.push(
    "    You must explicitly call finish_task to end this task with completed, blocked, or failed status.",
  );
  if (taskRun.runType === "cron") {
    lines.push(
      "    Seeing this message means the scheduled task has been triggered and should be executed now.",
    );
    lines.push("    You are running in background mode rather than an interactive chat turn.");
    lines.push(
      "    Keep intermediate assistant text minimal unless it materially helps execution.",
    );
    lines.push("    Prefer direct tool use and concrete work over status narration.");
    lines.push(
      "    The final response is the primary user-facing output, so make it complete and standalone.",
    );
    lines.push(
      "    If the task fails or is blocked, end with a clear final result explaining what happened and what follow-up is needed.",
    );
    lines.push("    Use recent run context as reference, not as a hard constraint.");
    lines.push("    If the previous run failed, avoid blindly repeating the same failing path.");
  }
  lines.push("  </guidance>");
  lines.push("</task_execution>");

  return lines.join("\n");
}

function formatTaskInput(inputJson: string): string {
  try {
    return JSON.stringify(JSON.parse(inputJson), null, 2);
  } catch {
    return inputJson;
  }
}

function appendCronRecentRuns(lines: string[], context?: CronKickoffContext) {
  const lastRun = context?.lastRun ?? null;
  const lastSuccessfulRun = context?.lastSuccessfulRun ?? null;
  if (lastRun == null && lastSuccessfulRun == null) {
    return;
  }

  lines.push("  <recent_runs>");
  if (lastRun != null) {
    appendRunBlock(lines, "last_run", lastRun);
  }
  if (lastSuccessfulRun != null) {
    const duplicate =
      lastRun != null &&
      lastRun.startedAt === lastSuccessfulRun.startedAt &&
      lastRun.status === lastSuccessfulRun.status;
    if (!duplicate) {
      appendRunBlock(lines, "last_successful_run", lastSuccessfulRun);
    }
  }
  lines.push("  </recent_runs>");
}

function extractCronContextFromInput(
  taskRun: Pick<TaskRun, "runType" | "inputJson">,
): CronKickoffContext | undefined {
  if (
    taskRun.runType !== "cron" ||
    taskRun.inputJson == null ||
    taskRun.inputJson.trim().length === 0
  ) {
    return undefined;
  }

  const taskDefinition = extractCronTaskDefinition(taskRun.inputJson);

  try {
    const parsed = JSON.parse(taskRun.inputJson) as unknown;
    const recentRuns =
      parsed != null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      "recentRuns" in parsed &&
      parsed.recentRuns != null &&
      typeof parsed.recentRuns === "object" &&
      !Array.isArray(parsed.recentRuns)
        ? (parsed.recentRuns as {
            lastRun?: CronKickoffRunReference | null;
            lastSuccessfulRun?: CronKickoffRunReference | null;
          })
        : null;

    if (recentRuns == null && taskDefinition.length === 0) {
      return undefined;
    }

    return {
      taskDefinition,
      lastRun: recentRuns?.lastRun ?? null,
      lastSuccessfulRun: recentRuns?.lastSuccessfulRun ?? null,
    };
  } catch {
    return taskDefinition.length > 0 ? { taskDefinition } : undefined;
  }
}

function appendCronTaskDefinition(lines: string[], context?: CronKickoffContext) {
  const taskDefinition = context?.taskDefinition?.trim() ?? "";
  if (taskDefinition.length === 0) {
    return;
  }

  lines.push("  <task_definition>");
  lines.push(indentBlock(escapeXml(taskDefinition), 4));
  lines.push("  </task_definition>");
}

function appendRunBlock(
  lines: string[],
  tagName: "last_run" | "last_successful_run",
  run: CronKickoffRunReference,
) {
  lines.push(`    <${tagName}>`);
  lines.push(`      <run_at>${escapeXml(run.startedAt)}</run_at>`);
  lines.push(`      <status>${escapeXml(run.status)}</status>`);
  if (run.summary != null && run.summary.trim().length > 0) {
    lines.push("      <summary>");
    lines.push(indentBlock(escapeXml(run.summary.trim()), 8));
    lines.push("      </summary>");
  }
  if (run.error != null && run.error.trim().length > 0) {
    lines.push("      <error>");
    lines.push(indentBlock(escapeXml(run.error.trim()), 8));
    lines.push("      </error>");
  }
  lines.push(`    </${tagName}>`);
}

function indentBlock(text: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
