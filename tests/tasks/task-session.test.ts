import { describe, expect, test } from "vitest";

import {
  buildTaskExecutionKickoffEnvelope,
  buildTaskExecutionSupervisorReminderEnvelope,
} from "@/src/tasks/task-session.js";

describe("buildTaskExecutionKickoffEnvelope", () => {
  test("renders cron task definitions without recent runs when there is no prior execution", () => {
    const envelope = buildTaskExecutionKickoffEnvelope({
      runType: "cron",
      description: null,
      inputJson:
        "Seeing this message means the daily report task should run now. Organize what was completed yesterday and produce a complete daily report.",
    });

    expect(envelope.scenario).toBe("cron");
    expect(envelope.messageType).toBe("cron_kickoff");
    expect(envelope.content).toContain("<task_definition>");
    expect(envelope.content).toContain(
      "Seeing this message means the daily report task should run now",
    );
    expect(envelope.content).not.toContain("<recent_runs>");
    expect(envelope.content).toContain("scheduled task has been triggered");
    expect(envelope.content).toContain("You are running in background mode");
    expect(envelope.content).toContain("defines what this run should do");
    expect(envelope.content).toContain("Do not do more than the kickoff asks");
    expect(envelope.content).toContain("Inherited context is background reference");
    expect(envelope.content).toContain("explicit user instructions that still apply");
    expect(envelope.content).toContain("Do not automatically continue earlier setup conversation");
    expect(envelope.content).toContain("scheduled execution");
    expect(envelope.content).toContain("The final response is the primary user-facing output");
    expect(envelope.content).toContain("You must explicitly call finish_task");
  });

  test("renders only the latest successful run when no failure history is relevant", () => {
    const envelope = buildTaskExecutionKickoffEnvelope({
      runType: "cron",
      description: null,
      inputJson: JSON.stringify({
        taskDefinition:
          "Seeing this message means you should check today's PR queue and give the user a complete update.",
        recentRuns: {
          lastRun: {
            startedAt: "2026-03-27T08:00:00.000Z",
            status: "completed",
            summary: "Reviewed 3 pull requests.",
          },
          lastSuccessfulRun: {
            startedAt: "2026-03-27T08:00:00.000Z",
            status: "completed",
            summary: "Reviewed 3 pull requests.",
          },
        },
      }),
    });

    expect(envelope.content).toContain("<recent_runs>");
    expect(envelope.content).toContain("<last_run>");
    expect(envelope.content).toContain("Reviewed 3 pull requests.");
    expect(envelope.content).not.toContain("<last_successful_run>");
  });

  test("renders failed last run plus last successful run and escapes xml content", () => {
    const envelope = buildTaskExecutionKickoffEnvelope({
      runType: "cron",
      description: null,
      inputJson: JSON.stringify({
        taskDefinition:
          "Seeing this message means the <daily report> task should run now. Summarize yesterday's & key items and give a result that can be sent directly.",
        recentRuns: {
          lastRun: {
            startedAt: "2026-03-27T08:00:00.000Z",
            status: "failed",
            error: "Slack <API> timeout & retry exhausted",
          },
          lastSuccessfulRun: {
            startedAt: "2026-03-26T08:00:00.000Z",
            status: "completed",
            summary: "Posted report with 5 <items> & links.",
          },
        },
      }),
    });

    expect(envelope.content).toContain("&lt;daily report&gt;");
    expect(envelope.content).toContain("&amp; key items");
    expect(envelope.content).toContain("<recent_runs>");
    expect(envelope.content).toContain("<last_run>");
    expect(envelope.content).toContain("Slack &lt;API&gt; timeout &amp; retry exhausted");
    expect(envelope.content).toContain("<last_successful_run>");
    expect(envelope.content).toContain("Posted report with 5 &lt;items&gt; &amp; links.");
  });

  test("renders a supervisor reminder for task runs that ended without finish_task", () => {
    const envelope = buildTaskExecutionSupervisorReminderEnvelope({
      runType: "cron",
      nextPass: 2,
      maxPasses: 3,
    });

    expect(envelope.scenario).toBe("cron");
    expect(envelope.messageType).toBe("task_supervisor_followup");
    expect(envelope.visibility).toBe("hidden_system");
    expect(envelope.content).toContain("<task_supervisor_followup>");
    expect(envelope.content).toContain("ended without calling finish_task");
    expect(envelope.content).toContain('status="blocked"');
  });
});
