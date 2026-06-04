/**
 * Contract test for the canonical a2a `message/send` builder.
 *
 * These assertions encode the a2a wire contract (molecule-core #2251):
 *   - `params.message.role` is present and a valid role.
 *   - parts use the `kind:"text"` discriminator, NOT the legacy `type:"text"`.
 *   - a `messageId` is present and unique.
 *
 * The `type`/role-less-shape guards below would FAIL on the old hand-rolled
 * `{ role: "user", parts: [{ type: "text", text }] }` (no messageId) envelope.
 */

import { buildMessageSendBody } from "../utils/a2a.js";

describe("buildMessageSendBody()", () => {
  test("produces a schema-valid message/send envelope", () => {
    const body = buildMessageSendBody("Hello there");

    expect(body.method).toBe("message/send");
    expect(body.params.message.role).toBe("user");
    expect(body.params.message.parts).toEqual([{ kind: "text", text: "Hello there" }]);
    expect(typeof body.params.message.messageId).toBe("string");
    expect(body.params.message.messageId.length).toBeGreaterThan(0);
  });

  test("parts use the `kind` discriminator, NOT the legacy `type` field", () => {
    const body = buildMessageSendBody("payload");
    const part = body.params.message.parts[0] as unknown as Record<string, unknown>;

    expect(part.kind).toBe("text");
    expect(part.text).toBe("payload");
    // Guard against regression to the old `{ type: "text" }` shape.
    expect(part).not.toHaveProperty("type");
  });

  test("role defaults to 'user' and is always present", () => {
    const body = buildMessageSendBody("x");
    const message = body.params.message as unknown as Record<string, unknown>;

    // role MUST exist (the old shape was sometimes role-less).
    expect(message).toHaveProperty("role");
    expect(message.role).toBe("user");
  });

  test("honours an explicit 'agent' role", () => {
    const body = buildMessageSendBody("x", { role: "agent" });
    expect(body.params.message.role).toBe("agent");
  });

  test("generates a fresh messageId per call by default", () => {
    const a = buildMessageSendBody("a");
    const b = buildMessageSendBody("b");
    expect(a.params.message.messageId).not.toBe(b.params.message.messageId);
  });

  test("honours an explicit messageId", () => {
    const body = buildMessageSendBody("x", { messageId: "fixed-id-123" });
    expect(body.params.message.messageId).toBe("fixed-id-123");
  });
});
