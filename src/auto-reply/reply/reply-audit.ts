import { logVerbose } from "../../globals.js";

export type ReplyIntent = "expects_reply" | "informational" | "ambiguous";

const INFORMATIONAL_PATTERNS: RegExp[] = [
  /^(ok|okay|k|kk|sure|alright|got\s*it|noted|roger|ack|bet|copy|yep|yup|yea|yeah)[\s.!]*$/i,
  /^(thanks|thank\s*you|thx|ty|tysm|appreciate\s*it|cheers|ta)[\s.!]*$/i,
  /^(yes|no|nah|nope|maybe|correct|right|exactly|agreed|true|false|indeed)[\s.!]*$/i,
  /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]{1,12}$/u,
  // eslint-disable-next-line no-misleading-character-class
  /^[👍👎👌🙏❤️💜🔥✅💯🎉🤝]{1,5}$/u,
  /^(ha(ha)+|lol|lmao|rofl|xd|😂+|🤣+)[\s!.]*$/i,
];

const QUESTION_START_RE =
  /^(what|who|where|when|why|how|which|is|are|do|does|can|could|would|will|should|shall|did|has|have|tell\s+me)\b/i;
const COMMAND_START_RE =
  /^(do|make|create|build|fix|write|implement|add|remove|delete|update|change|edit|show|list|find|search|check|test|run|explain|describe|summarize|translate|convert|help|generate|design|refactor|debug|deploy)\b/i;
const GREETING_RE =
  /^(hi|hello|hey|yo|sup|good\s*(morning|afternoon|evening|night)|greetings|howdy|hola|czesc|cześć|siema|witaj)(?:[\s,.!]|$)/i;
const CODE_HINT_RE = /```|\b(function|class|const|let|var|import|export)\b/i;

export function classifyReplyIntent(text: string | undefined): ReplyIntent {
  if (!text) {
    return "ambiguous";
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return "ambiguous";
  }

  for (const pattern of INFORMATIONAL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return "informational";
    }
  }

  if (trimmed.includes("?")) {
    return "expects_reply";
  }
  if (QUESTION_START_RE.test(trimmed)) {
    return "expects_reply";
  }
  if (/^(please|plz|pls)\b/i.test(trimmed) || COMMAND_START_RE.test(trimmed)) {
    return "expects_reply";
  }
  if (GREETING_RE.test(trimmed)) {
    return "expects_reply";
  }
  if (CODE_HINT_RE.test(trimmed)) {
    return "expects_reply";
  }
  if (trimmed.length > 80 || /[.!]\s+[A-Z]/.test(trimmed)) {
    return "expects_reply";
  }

  return "ambiguous";
}

export type ReplyAuditResult = {
  inboundReceived: boolean;
  intent: ReplyIntent;
  replyAttempted: boolean;
  replyDelivered: boolean;
  skipReason?: string;
  skippedIntentionally: boolean;
  elapsedMs: number;
};

export type ReplyAuditHandler = {
  markReceived(text?: string): void;
  markReplyAttempted(): void;
  markReplyDelivered(): void;
  markSkipped(reason: string, opts?: { intentional?: boolean }): void;
  finalize(context?: { sessionKey?: string; channel?: string }): ReplyAuditResult;
};

export function createReplyAuditHandler(): ReplyAuditHandler {
  const startedAt = Date.now();
  let received = false;
  let intent: ReplyIntent = "ambiguous";
  let attempted = false;
  let delivered = false;
  let skipReason: string | undefined;
  let skippedIntentionally = false;

  return {
    markReceived(text?: string) {
      received = true;
      intent = classifyReplyIntent(text);
    },
    markReplyAttempted() {
      attempted = true;
    },
    markReplyDelivered() {
      delivered = true;
    },
    markSkipped(reason: string, opts?: { intentional?: boolean }) {
      skipReason = reason;
      skippedIntentionally = opts?.intentional === true;
    },
    finalize(context?: { sessionKey?: string; channel?: string }): ReplyAuditResult {
      const result: ReplyAuditResult = {
        inboundReceived: received,
        intent,
        replyAttempted: attempted,
        replyDelivered: delivered,
        skipReason,
        skippedIntentionally,
        elapsedMs: Date.now() - startedAt,
      };

      const expectsReply = intent === "expects_reply" || intent === "ambiguous";
      if (received && expectsReply && !delivered && !skippedIntentionally) {
        const detail = context
          ? ` [session=${context.sessionKey ?? "?"}, channel=${context.channel ?? "?"}]`
          : "";
        logVerbose(
          `reply_audit:no_reply${detail} intent=${intent} attempted=${attempted} skip=${skipReason ?? "none"} elapsedMs=${result.elapsedMs}`,
        );
      }

      return result;
    },
  };
}
