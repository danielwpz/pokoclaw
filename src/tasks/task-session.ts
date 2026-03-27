import type { ModelScenario } from "@/src/agent/llm/models.js";
import type { TaskRun } from "@/src/storage/schema/types.js";

export interface TaskExecutionKickoffEnvelope {
  scenario: ModelScenario;
  content: string;
  messageType: string;
  visibility: "hidden_system";
}

export function resolveTaskExecutionScenario(runType: string): ModelScenario {
  return runType === "cron" ? "cron" : "subagent";
}

export function buildTaskExecutionKickoffEnvelope(
  taskRun: Pick<TaskRun, "runType" | "description" | "inputJson">,
): TaskExecutionKickoffEnvelope {
  return {
    scenario: resolveTaskExecutionScenario(taskRun.runType),
    messageType: taskRun.runType === "cron" ? "cron_kickoff" : "task_kickoff",
    visibility: "hidden_system",
    content: renderTaskKickoffMessage(taskRun),
  };
}

function renderTaskKickoffMessage(taskRun: Pick<TaskRun, "runType" | "description" | "inputJson">) {
  const lines = ["<task_execution>"];

  lines.push(`  <run_type>${taskRun.runType}</run_type>`);

  if (taskRun.description != null && taskRun.description.trim().length > 0) {
    lines.push("  <description>");
    lines.push(`  ${taskRun.description.trim()}`);
    lines.push("  </description>");
  }

  if (taskRun.inputJson != null && taskRun.inputJson.trim().length > 0) {
    lines.push("  <input>");
    lines.push(indentBlock(formatTaskInput(taskRun.inputJson), 4));
    lines.push("  </input>");
  }

  lines.push("  <guidance>");
  lines.push("    Execute this background task in this session.");
  lines.push("    Use tools directly when they help move the task forward.");
  lines.push("    Keep the work in this task session; do not assume a user is watching live.");
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

function indentBlock(text: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}
