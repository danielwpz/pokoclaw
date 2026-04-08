import type { ModelScenario } from "@/src/agent/llm/models.js";
import { extractCronTaskDefinition } from "@/src/cron/payload.js";
import type { TaskRun } from "@/src/storage/schema/types.js";

export interface TaskExecutionKickoffEnvelope {
  scenario: ModelScenario;
  content: string;
  messageType: string;
  visibility: "hidden_system";
}

export interface TaskExecutionKickoffOptions {
  cronContext?: CronKickoffContext;
  contextMode?: "group" | "isolated" | null;
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

const TASK_SUPERVISOR_GUIDANCE_LINES = [
  "This unattended task run ended without calling finish_task.",
  "Do not wait for a user reply.",
  "Continue the work if there is still concrete work left to do.",
  'If the task is already complete, explicitly call finish_task with status="completed".',
  'If the task is blocked on missing information, credentials, or a user decision, explicitly call finish_task with status="blocked".',
  'If the task has failed and should stop, explicitly call finish_task with status="failed".',
  "You must call finish_task before this task can be considered settled.",
];

const TASK_EXECUTION_GUIDANCE_LINES = [
  "Execute this background task in this session.",
  "Use tools directly when they help move the task forward.",
  "Keep the work in this task session; do not assume a user is watching live.",
  "The current kickoff message defines what this run should do, its scope, and what counts as done.",
  "Do not do more than the kickoff asks, and do not do less.",
  "Inherited context is background reference for how to carry out the run: use it for relevant user preferences, standing instructions, constraints, and task background.",
  "If prior context contains explicit user instructions that still apply, continue to follow them.",
  "Do not automatically continue earlier setup conversation, temporary assistant plans, or unfinished narration unless they are still relevant to the current kickoff.",
  "This session is unattended. Do not wait for live user feedback before ending the task.",
  "You must explicitly call finish_task to end this task with completed, blocked, or failed status.",
];

const CRON_EXECUTION_GUIDANCE_LINES = [
  "Seeing this message means the scheduled task has been triggered and should be executed now.",
  "You are running in background mode rather than an interactive chat turn.",
  "Treat this as a scheduled execution, not as an unfinished interactive conversation that should simply be continued.",
  "Keep intermediate assistant text minimal unless it materially helps execution.",
  "Prefer direct tool use and concrete work over status narration.",
  "The final response is the primary user-facing output, so make it complete and standalone.",
  "If the task fails or is blocked, end with a clear final result explaining what happened and what follow-up is needed.",
  "Use recent run context as reference, not as a hard constraint.",
  "recent_runs and last_run are historical reference only.",
  "They are not evidence that the current run has already completed its required work.",
  "Only mark the task completed when this run has actually produced the required result for the current kickoff.",
  "The internal kickoff/reference blocks above are not visible to the user.",
  "Do not tell the user to look at them. If they contain useful context, restate it explicitly in your own final user-facing output.",
  "If the previous run failed, avoid blindly repeating the same failing path.",
];

const GROUP_CRON_TRANSCRIPT_GUIDANCE_LINES = [
  "If inherited transcript is present, use it only for task-relevant background, standing instructions, constraints, and user preferences.",
  "Do not resume unrelated unfinished discussion just because it appears in inherited transcript.",
  "Do not treat inherited transcript as a request to continue the broader conversation.",
  "Complete the scheduled objective for this run, then end the task instead of continuing broader conversation.",
];

export function resolveTaskExecutionScenario(runType: string): ModelScenario {
  return runType === "cron" ? "cron" : "subagent";
}

export function buildTaskExecutionKickoffEnvelope(
  taskRun: Pick<TaskRun, "runType" | "description" | "inputJson">,
  options: TaskExecutionKickoffOptions = {},
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
  return {
    scenario: resolveTaskExecutionScenario(input.runType),
    messageType: "task_supervisor_followup",
    visibility: "hidden_system",
    content: renderXmlEnvelope("task_supervisor_followup", [
      ...renderSingleLineElement("run_type", input.runType),
      ...renderSingleLineElement("next_pass", String(input.nextPass)),
      ...renderSingleLineElement("max_passes", String(input.maxPasses)),
      ...renderLineBlock("guidance", TASK_SUPERVISOR_GUIDANCE_LINES),
    ]),
  };
}

function renderTaskKickoffMessage(
  taskRun: Pick<TaskRun, "runType" | "description" | "inputJson">,
  options: TaskExecutionKickoffOptions,
) {
  const cronContext = options.cronContext ?? extractCronContextFromInput(taskRun);
  const guidanceLines =
    taskRun.runType === "cron"
      ? buildCronExecutionGuidanceLines(options.contextMode)
      : TASK_EXECUTION_GUIDANCE_LINES;

  return renderXmlEnvelope("task_execution", [
    ...renderSingleLineElement("run_type", taskRun.runType),
    ...renderOptionalMultilineElement("description", taskRun.description?.trim() ?? ""),
    ...renderKickoffInput(taskRun, cronContext),
    ...renderLineBlock("guidance", guidanceLines),
  ]);
}

function buildCronExecutionGuidanceLines(contextMode?: string | null): string[] {
  return [
    ...TASK_EXECUTION_GUIDANCE_LINES,
    ...CRON_EXECUTION_GUIDANCE_LINES,
    ...(contextMode === "group" ? GROUP_CRON_TRANSCRIPT_GUIDANCE_LINES : []),
  ];
}

function formatTaskInput(inputJson: string): string {
  try {
    return JSON.stringify(JSON.parse(inputJson), null, 2);
  } catch {
    return inputJson;
  }
}

function renderKickoffInput(
  taskRun: Pick<TaskRun, "runType" | "inputJson">,
  cronContext?: CronKickoffContext,
): string[] {
  if (taskRun.inputJson != null && taskRun.inputJson.trim().length > 0) {
    if (taskRun.runType === "cron") {
      return [...renderCronTaskDefinition(cronContext), ...renderCronRecentRuns(cronContext)];
    }

    return renderMultilineElement("input", formatTaskInput(taskRun.inputJson));
  }

  if (taskRun.runType === "cron") {
    return [...renderCronTaskDefinition(cronContext), ...renderCronRecentRuns(cronContext)];
  }

  return [];
}

function renderCronRecentRuns(context?: CronKickoffContext): string[] {
  const lastRun = context?.lastRun ?? null;
  const lastSuccessfulRun = context?.lastSuccessfulRun ?? null;
  if (lastRun == null && lastSuccessfulRun == null) {
    return [];
  }

  const blocks: string[] = [];
  if (lastRun != null) {
    blocks.push(...renderRunBlock("last_run", lastRun));
  }
  if (lastSuccessfulRun != null) {
    const duplicate =
      lastRun != null &&
      lastRun.startedAt === lastSuccessfulRun.startedAt &&
      lastRun.status === lastSuccessfulRun.status;
    if (!duplicate) {
      blocks.push(...renderRunBlock("last_successful_run", lastSuccessfulRun));
    }
  }

  return [
    "  <recent_runs>",
    ...renderSingleLineElement(
      "reference_only",
      "Historical context only. Not proof that the current run has already produced its required result.",
      4,
    ),
    ...blocks,
    "  </recent_runs>",
  ];
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

function renderCronTaskDefinition(context?: CronKickoffContext): string[] {
  const taskDefinition = context?.taskDefinition?.trim() ?? "";
  if (taskDefinition.length === 0) {
    return [];
  }

  return renderMultilineElement("task_definition", escapeXml(taskDefinition));
}

function renderRunBlock(
  tagName: "last_run" | "last_successful_run",
  run: CronKickoffRunReference,
): string[] {
  const lines = [
    `    <${tagName}>`,
    ...renderSingleLineElement("run_at", escapeXml(run.startedAt), 6),
    ...renderSingleLineElement("status", escapeXml(run.status), 6),
  ];
  if (run.summary != null && run.summary.trim().length > 0) {
    lines.push(...renderMultilineElement("summary", escapeXml(run.summary.trim()), 6, 8));
  }
  if (run.error != null && run.error.trim().length > 0) {
    lines.push(...renderMultilineElement("error", escapeXml(run.error.trim()), 6, 8));
  }
  lines.push(`    </${tagName}>`);
  return lines;
}

function renderXmlEnvelope(tagName: string, bodyLines: string[]): string {
  return [`<${tagName}>`, ...bodyLines, `</${tagName}>`].join("\n");
}

function renderSingleLineElement(tagName: string, value: string, indent = 2): string[] {
  const prefix = " ".repeat(indent);
  return [`${prefix}<${tagName}>${value}</${tagName}>`];
}

function renderOptionalMultilineElement(tagName: string, value: string, indent = 2): string[] {
  return value.length === 0 ? [] : renderMultilineElement(tagName, value, indent);
}

function renderMultilineElement(
  tagName: string,
  value: string,
  indent = 2,
  contentIndent = indent + 2,
): string[] {
  const prefix = " ".repeat(indent);
  return [`${prefix}<${tagName}>`, indentBlock(value, contentIndent), `${prefix}</${tagName}>`];
}

function renderLineBlock(
  tagName: string,
  entries: readonly string[],
  indent = 2,
  contentIndent = indent + 2,
): string[] {
  const prefix = " ".repeat(indent);
  const contentPrefix = " ".repeat(contentIndent);
  return [
    `${prefix}<${tagName}>`,
    ...entries.map((entry) => `${contentPrefix}${entry}`),
    `${prefix}</${tagName}>`,
  ];
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
