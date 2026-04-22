import type { ThinkTankParticipantAssignment } from "@/src/think-tank/types.js";

export const THINK_TANK_PARTICIPANT_MAX_WORDS = 500;

export interface BuildThinkTankModeratorSetupEnvelopeInput {
  consultationId: string;
  topic: string;
  context: string;
  participants: ThinkTankParticipantAssignment[];
  participantPersonas: Array<{
    id: string;
    persona: string;
    title: string | null;
    model: string;
  }>;
}

export interface BuildThinkTankEpisodeKickoffEnvelopeInput {
  consultationId: string;
  episodeId: string;
  episodeSequence: number;
  episodePrompt: string;
  latestConclusion?: string | null;
}

export function buildThinkTankModeratorSetupEnvelope(
  input: BuildThinkTankModeratorSetupEnvelopeInput,
): string {
  const lines = [
    "<think_tank_consultation_setup>",
    `  <consultation_id>${escapeXml(input.consultationId)}</consultation_id>`,
    "  <topic>",
    ...indentLines(input.topic, 4),
    "  </topic>",
    "  <context>",
    ...indentLines(input.context, 4),
    "  </context>",
    "  <participants>",
  ];

  for (const participant of input.participantPersonas) {
    lines.push("    <participant>");
    lines.push(`      <id>${escapeXml(participant.id)}</id>`);
    if (participant.title != null && participant.title.trim().length > 0) {
      lines.push(`      <title>${escapeXml(participant.title.trim())}</title>`);
    }
    lines.push(`      <model>${escapeXml(participant.model)}</model>`);
    lines.push("      <persona>");
    lines.push(...indentLines(participant.persona, 8));
    lines.push("      </persona>");
    lines.push("    </participant>");
  }

  lines.push("  </participants>");
  lines.push("  <rules>");
  lines.push(
    "    You are moderating a persistent think tank consultation. Advisors are advisory only; you own the conclusion.",
  );
  lines.push(
    "    Default pattern: independent perspectives, then one exchange round where each participant sees the combined outputs of all other participants from the prior round.",
  );
  lines.push("    You may stop after one round if the question is already resolved.");
  lines.push("    You may add a third round only when it materially improves the conclusion.");
  lines.push(
    "    Use upsert_think_tank_step to mark a round or moderator synthesis as started or updated while the episode is running.",
  );
  lines.push(
    "    Use consult_participant for advisor turns. Pass stable round metadata in the step field for every advisor call in the same round.",
  );
  lines.push("    Call finish_think_tank_episode exactly once when this episode is done.");
  lines.push("  </rules>");
  lines.push("</think_tank_consultation_setup>");

  return lines.join("\n");
}

export function buildThinkTankParticipantSetupEnvelope(input: {
  consultationId: string;
  participantId: string;
  title: string | null;
  model: string;
  topic: string;
  context: string;
  persona: string;
}): string {
  const lines = [
    "<think_tank_participant_setup>",
    `  <consultation_id>${escapeXml(input.consultationId)}</consultation_id>`,
    `  <participant_id>${escapeXml(input.participantId)}</participant_id>`,
    `  <model>${escapeXml(input.model)}</model>`,
  ];
  if (input.title != null && input.title.trim().length > 0) {
    lines.push(`  <title>${escapeXml(input.title.trim())}</title>`);
  }
  lines.push("  <topic>");
  lines.push(...indentLines(input.topic, 4));
  lines.push("  </topic>");
  lines.push("  <context>");
  lines.push(...indentLines(input.context, 4));
  lines.push("  </context>");
  lines.push("  <persona>");
  lines.push(...indentLines(input.persona, 4));
  lines.push("  </persona>");
  lines.push("</think_tank_participant_setup>");
  return lines.join("\n");
}

export function buildThinkTankEpisodeKickoffEnvelope(
  input: BuildThinkTankEpisodeKickoffEnvelopeInput,
): string {
  const lines = [
    "<think_tank_episode_kickoff>",
    `  <consultation_id>${escapeXml(input.consultationId)}</consultation_id>`,
    `  <episode_id>${escapeXml(input.episodeId)}</episode_id>`,
    `  <episode_sequence>${String(input.episodeSequence)}</episode_sequence>`,
    "  <episode_prompt>",
    ...indentLines(input.episodePrompt, 4),
    "  </episode_prompt>",
  ];

  if (input.latestConclusion != null && input.latestConclusion.trim().length > 0) {
    lines.push("  <latest_conclusion>");
    lines.push(...indentLines(input.latestConclusion, 4));
    lines.push("  </latest_conclusion>");
  }

  lines.push("  <instructions>");
  lines.push(
    "    Run a focused think tank episode. Default to one independent round plus one exchange round. Keep the process tight.",
  );
  lines.push(
    "    At the start of each participant round, call upsert_think_tank_step with kind participant_round and status pending so channels can render the live placeholder card.",
  );
  lines.push(
    "    Every consult_participant call in the same round must reuse the same step metadata: roundIndex plus stable key/title/order when available.",
  );
  lines.push(
    "    When using consult_participant for exchange, include all other participants' previous-round outputs in the prompt you send.",
  );
  lines.push(
    "    When you begin synthesizing, call upsert_think_tank_step with kind moderator_summary or final_summary and status pending.",
  );
  lines.push(
    "    When that synthesis is ready, call upsert_think_tank_step again with status completed and the structured summary payload.",
  );
  lines.push(
    "    When the episode is done, call finish_think_tank_episode with structured summary fields and semantic step snapshots.",
  );
  lines.push("  </instructions>");
  lines.push("</think_tank_episode_kickoff>");

  return lines.join("\n");
}

export function buildThinkTankEpisodeSupervisorReminderEnvelope(input: {
  episodeSequence: number;
  nextPass: number;
  maxPasses: number;
}): string {
  return [
    "<think_tank_supervisor_followup>",
    `  <episode_sequence>${String(input.episodeSequence)}</episode_sequence>`,
    `  <next_pass>${String(input.nextPass)}</next_pass>`,
    `  <max_passes>${String(input.maxPasses)}</max_passes>`,
    "  <guidance>",
    "    The previous moderator pass ended without finish_think_tank_episode.",
    "    Continue only if concrete work remains.",
    "    If the episode is ready to conclude, call finish_think_tank_episode now.",
    "  </guidance>",
    "</think_tank_supervisor_followup>",
  ].join("\n");
}

export function buildThinkTankParticipantConsultEnvelope(input: { prompt: string }): string {
  return [
    "<think_tank_consult_request>",
    "  <instructions>",
    `    Respond in at most ${String(THINK_TANK_PARTICIPANT_MAX_WORDS)} words.`,
    "    Be direct. Do not repeat the full prompt. Focus on the requested analysis.",
    "  </instructions>",
    "  <prompt>",
    ...indentLines(input.prompt, 4),
    "  </prompt>",
    "</think_tank_consult_request>",
  ].join("\n");
}

function indentLines(value: string, spaces: number): string[] {
  const prefix = " ".repeat(spaces);
  return value.split(/\r?\n/).map((line) => `${prefix}${escapeXml(line)}`);
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
