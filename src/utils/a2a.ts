/**
 * Canonical A2A (agent-to-agent) `message/send` request-body builder.
 *
 * The a2a protocol requires every outbound `message/send` envelope to be
 * schema-valid:
 *
 *   - `params.message.role` MUST be present and one of "user" | "agent".
 *   - Each message part MUST use the `kind` discriminator (e.g.
 *     `{ kind: "text", text: "..." }`) — NOT the legacy `type` field.
 *   - `params.message.messageId` MUST be a unique id for the message.
 *
 * Historically this server hand-rolled envelopes per call site, which drifted
 * out of spec (e.g. `parts: [{ type: "text", ... }]` with no `messageId`).
 * Every `message/send` body MUST now funnel through this builder so the wire
 * shape is the single source of truth.  See molecule-core #2251 for the
 * cross-repo "missing role / type-vs-kind" fix this mirrors.
 */

import { randomUUID } from "crypto";

/** A2A message roles, per the a2a spec. */
export type A2aRole = "user" | "agent";

/** A single text part of an a2a message — note the `kind` discriminator. */
export interface A2aTextPart {
  kind: "text";
  text: string;
}

/** The `message` object inside a `message/send` request's params. */
export interface A2aMessage {
  role: A2aRole;
  parts: A2aTextPart[];
  messageId: string;
}

/** A complete, schema-valid `message/send` JSON-RPC request body. */
export interface A2aMessageSendBody {
  method: "message/send";
  params: {
    message: A2aMessage;
  };
}

/** Options for {@link buildMessageSendBody}. */
export interface BuildMessageSendOptions {
  /** Sender role. Defaults to "user". */
  role?: A2aRole;
  /** Explicit message id. Defaults to a fresh `crypto.randomUUID()`. */
  messageId?: string;
}

/**
 * Build a schema-valid a2a `message/send` request body.
 *
 * @param text  The text content of the single text part.
 * @param opts  Optional `role` (default "user") and `messageId` (default a
 *              fresh UUID).
 * @returns A complete `message/send` request body with `role`, a `kind:"text"`
 *          part, and a `messageId`.
 */
export function buildMessageSendBody(
  text: string,
  opts?: BuildMessageSendOptions,
): A2aMessageSendBody {
  return {
    method: "message/send",
    params: {
      message: {
        role: opts?.role ?? "user",
        parts: [{ kind: "text", text }],
        messageId: opts?.messageId ?? randomUUID(),
      },
    },
  };
}
