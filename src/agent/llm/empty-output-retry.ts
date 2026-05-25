import { type AgentLlmError, isAgentLlmError } from "@/src/agent/llm/errors.js";

export function getEmptyOutputLlmRetryLimit(maxAttempts: number): number {
  return Math.max(0, maxAttempts - 1);
}

export function getNextEmptyOutputLlmAttempt(input: { retryCount: number }): number {
  return input.retryCount + 1;
}

export function shouldRetrySuccessfulEmptyAssistantOutput(input: {
  assistantText: string;
  reasoningText: string;
  toolCallsRequested: number;
  sawStreamedText: boolean;
  sawStreamedReasoning: boolean;
  retryCount: number;
  maxAttempts: number;
}): boolean {
  if (
    input.retryCount >= getEmptyOutputLlmRetryLimit(input.maxAttempts) ||
    input.sawStreamedText ||
    input.sawStreamedReasoning
  ) {
    return false;
  }

  return (
    input.assistantText.length === 0 &&
    input.reasoningText.length === 0 &&
    input.toolCallsRequested === 0
  );
}

export function getRetryableLlmFailureWithoutVisibleOutput(input: {
  error: unknown;
  sawStreamedText: boolean;
  sawStreamedReasoning: boolean;
  retryCount: number;
  maxAttempts: number;
}): AgentLlmError | null {
  if (
    input.retryCount >= getEmptyOutputLlmRetryLimit(input.maxAttempts) ||
    !isAgentLlmError(input.error) ||
    !input.error.retryable ||
    input.sawStreamedText ||
    input.sawStreamedReasoning
  ) {
    return null;
  }

  return input.error;
}
