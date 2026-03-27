import { describe, expect, test } from "vitest";

import { buildTaskExecutionKickoffEnvelope } from "@/src/tasks/task-session.js";

describe("buildTaskExecutionKickoffEnvelope", () => {
  test("renders cron task definitions without recent runs when there is no prior execution", () => {
    const envelope = buildTaskExecutionKickoffEnvelope({
      runType: "cron",
      description: null,
      inputJson: "看到这条消息意味着现在要执行日报任务。请整理昨天完成的事项并输出一条完整日报。",
    });

    expect(envelope.scenario).toBe("cron");
    expect(envelope.messageType).toBe("cron_kickoff");
    expect(envelope.content).toContain("<task_definition>");
    expect(envelope.content).toContain("看到这条消息意味着现在要执行日报任务");
    expect(envelope.content).not.toContain("<recent_runs>");
    expect(envelope.content).toContain("You are running in background mode");
    expect(envelope.content).toContain("The final response is the primary user-facing output");
  });

  test("renders only the latest successful run when no failure history is relevant", () => {
    const envelope = buildTaskExecutionKickoffEnvelope({
      runType: "cron",
      description: null,
      inputJson: JSON.stringify({
        taskDefinition: "看到这条消息意味着要检查今天的 PR 队列，并给用户一条完整结果更新。",
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
          "看到这条消息意味着现在要执行 <日报> 任务。请汇总昨天的 & 关键事项，并给出可直接发送的结果。",
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

    expect(envelope.content).toContain("&lt;日报&gt;");
    expect(envelope.content).toContain("&amp; 关键事项");
    expect(envelope.content).toContain("<recent_runs>");
    expect(envelope.content).toContain("<last_run>");
    expect(envelope.content).toContain("Slack &lt;API&gt; timeout &amp; retry exhausted");
    expect(envelope.content).toContain("<last_successful_run>");
    expect(envelope.content).toContain("Posted report with 5 &lt;items&gt; &amp; links.");
  });
});
