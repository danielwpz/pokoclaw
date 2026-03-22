import type { MessagesRepo } from "@/src/storage/repos/messages.repo.js";
import type { SessionsRepo } from "@/src/storage/repos/sessions.repo.js";
import type { Message, Session } from "@/src/storage/schema/types.js";

export interface AgentSessionContext {
  session: Session;
  compactSummary: string | null;
  messages: Message[];
}

export class AgentSessionService {
  constructor(
    private readonly sessionsRepo: SessionsRepo,
    private readonly messagesRepo: MessagesRepo,
  ) {}

  getContext(sessionId: string): AgentSessionContext {
    const session = this.sessionsRepo.getById(sessionId);
    if (session == null) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const messages = this.messagesRepo.listBySession(sessionId, {
      afterSeq: session.compactCursor,
    });

    return {
      session,
      compactSummary: session.compactSummary,
      messages,
    };
  }
}
