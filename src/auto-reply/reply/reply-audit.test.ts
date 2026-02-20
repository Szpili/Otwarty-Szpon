import { beforeEach, describe, expect, it, vi } from "vitest";

const globalsMocks = vi.hoisted(() => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../globals.js", () => ({
  logVerbose: globalsMocks.logVerbose,
}));

const { classifyReplyIntent, createReplyAuditHandler } = await import("./reply-audit.js");

describe("classifyReplyIntent", () => {
  it.each([
    "What is the weather?",
    "how do I fix this",
    "Can you help me",
    "fix this bug",
    "please run tests",
    "hello",
    "cześć",
    "```\nconst x = 1\n```",
  ])("classifies %j as expects_reply", (input) => {
    expect(classifyReplyIntent(input)).toBe("expects_reply");
  });

  it.each(["ok", "thanks", "thank you", "noted", "yep", "👍", "😂😂"])(
    "classifies %j as informational",
    (input) => {
      expect(classifyReplyIntent(input)).toBe("informational");
    },
  );

  it.each(["", "   ", undefined, "mongoose"])("classifies %j as ambiguous", (input) => {
    expect(classifyReplyIntent(input)).toBe("ambiguous");
  });
});

describe("createReplyAuditHandler", () => {
  beforeEach(() => {
    globalsMocks.logVerbose.mockReset();
  });

  it("does not warn when a reply was delivered", () => {
    const handler = createReplyAuditHandler();
    handler.markReceived("how do I fix this?");
    handler.markReplyAttempted();
    handler.markReplyDelivered();
    const result = handler.finalize();

    expect(result.replyDelivered).toBe(true);
    expect(globalsMocks.logVerbose).not.toHaveBeenCalled();
  });

  it("warns when reply was expected but not delivered", () => {
    const handler = createReplyAuditHandler();
    handler.markReceived("please fix this");
    handler.markReplyAttempted();
    const result = handler.finalize({ sessionKey: "s", channel: "telegram" });

    expect(result.replyDelivered).toBe(false);
    expect(globalsMocks.logVerbose).toHaveBeenCalledTimes(1);
    expect(globalsMocks.logVerbose.mock.calls[0]?.[0]).toContain("reply_audit:no_reply");
  });

  it("does not warn for informational no-reply", () => {
    const handler = createReplyAuditHandler();
    handler.markReceived("ok");
    const result = handler.finalize();

    expect(result.intent).toBe("informational");
    expect(globalsMocks.logVerbose).not.toHaveBeenCalled();
  });

  it("does not warn when skipped intentionally", () => {
    const handler = createReplyAuditHandler();
    handler.markReceived("fix this");
    handler.markSkipped("duplicate", { intentional: true });
    const result = handler.finalize();

    expect(result.skippedIntentionally).toBe(true);
    expect(globalsMocks.logVerbose).not.toHaveBeenCalled();
  });

  it("warns for non-intentional silent skip when intent expects reply", () => {
    const handler = createReplyAuditHandler();
    handler.markReceived("fix this");
    handler.markReplyAttempted();
    handler.markSkipped("dispatcher:silent");
    handler.finalize();

    expect(globalsMocks.logVerbose).toHaveBeenCalledTimes(1);
    expect(globalsMocks.logVerbose.mock.calls[0]?.[0]).toContain("skip=dispatcher:silent");
  });

  it("treats ambiguous as expects_reply for safety", () => {
    const handler = createReplyAuditHandler();
    handler.markReceived("mongoose");
    const result = handler.finalize();

    expect(result.intent).toBe("ambiguous");
    expect(globalsMocks.logVerbose).toHaveBeenCalledTimes(1);
  });
});
