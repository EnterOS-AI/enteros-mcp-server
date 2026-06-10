/**
 * Unit tests for the unified requests / inbox tools (src/tools/requests.ts).
 *
 * fetch is mocked globally (no real HTTP). Each test asserts the handler hits
 * the right path + method + body and returns the standard MCP envelope. Mirrors
 * the fetch-mock convention in index.test.ts / issues.test.ts.
 */

import { PLATFORM_URL } from "../api.js";
import {
  handleCreateRequest,
  handleListInbox,
  handleCheckRequests,
  handleGetRequest,
  handleRespondRequest,
  handleAddRequestMessage,
  handleCancelRequest,
} from "../tools/requests.js";

function mockFetch(payload: unknown, ok = true, status = 200) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return jest.fn().mockResolvedValue({
    ok,
    status,
    headers: { get: () => null },
    text: jest.fn().mockResolvedValue(body),
  });
}

function mockFetchSequence(responses: Array<{ payload: unknown; ok?: boolean; status?: number }>) {
  const fn = jest.fn();
  for (const r of responses) {
    fn.mockResolvedValueOnce({
      ok: r.ok ?? true,
      status: r.status ?? 200,
      headers: { get: () => null },
      text: jest.fn().mockResolvedValue(JSON.stringify(r.payload)),
    });
  }
  return fn;
}

function bodyOf(result: { content: { type: string; text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

afterEach(() => jest.restoreAllMocks());

describe("create_request", () => {
  it("POSTs a task to the requester workspace's /requests with the full body", async () => {
    global.fetch = mockFetch({ request_id: "req-1", status: "pending" }) as unknown as typeof fetch;
    const res = await handleCreateRequest({
      workspace_id: "ws-1",
      kind: "task",
      recipient_type: "agent",
      recipient_id: "ws-2",
      title: "do the thing",
      detail: "with care",
      priority: 5,
    });

    const call = (global.fetch as jest.Mock).mock.calls[0];
    expect(call[0]).toBe(`${PLATFORM_URL}/workspaces/ws-1/requests`);
    expect(call[1].method).toBe("POST");
    const sent = JSON.parse(call[1].body);
    expect(sent).toEqual({
      kind: "task",
      recipient_type: "agent",
      recipient_id: "ws-2",
      title: "do the thing",
      detail: "with care",
      priority: 5,
    });
    expect(bodyOf(res).request_id).toBe("req-1");
  });

  it("POSTs an approval addressed to a user", async () => {
    global.fetch = mockFetch({ request_id: "req-2", status: "pending" }) as unknown as typeof fetch;
    await handleCreateRequest({
      workspace_id: "ws-9",
      kind: "approval",
      recipient_type: "user",
      recipient_id: "user-7",
      title: "approve deploy",
    });
    const sent = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(sent.kind).toBe("approval");
    expect(sent.recipient_type).toBe("user");
    expect(sent.recipient_id).toBe("user-7");
  });
});

describe("list_inbox vs check_requests", () => {
  it("list_inbox GETs the recipient inbox path with a status filter", async () => {
    global.fetch = mockFetch([{ request_id: "req-1" }]) as unknown as typeof fetch;
    await handleListInbox({ workspace_id: "ws-1", status: "pending" });
    const url = (global.fetch as jest.Mock).mock.calls[0][0];
    expect(url).toBe(`${PLATFORM_URL}/workspaces/ws-1/requests/inbox?status=pending`);
    expect((global.fetch as jest.Mock).mock.calls[0][1].method).toBe("GET");
  });

  it("check_requests GETs the OUTGOING /requests path (not the inbox)", async () => {
    global.fetch = mockFetch([{ request_id: "req-2" }]) as unknown as typeof fetch;
    await handleCheckRequests({ workspace_id: "ws-1" });
    const url = (global.fetch as jest.Mock).mock.calls[0][0];
    expect(url).toBe(`${PLATFORM_URL}/workspaces/ws-1/requests`);
  });
});

describe("get_request", () => {
  it("GETs the per-workspace request path (agent auth scope)", async () => {
    global.fetch = mockFetch({ request: { request_id: "req-1" }, messages: [] }) as unknown as typeof fetch;
    const res = await handleGetRequest({ workspace_id: "ws-1", request_id: "req-1" });
    const url = (global.fetch as jest.Mock).mock.calls[0][0];
    expect(url).toBe(`${PLATFORM_URL}/workspaces/ws-1/requests/req-1`);
    expect(bodyOf(res).request.request_id).toBe("req-1");
  });
});

describe("respond_request", () => {
  it("POSTs the terminal action with responder_type=agent, responder_id=workspace_id", async () => {
    global.fetch = mockFetch({ status: "done", request_id: "req-1" }) as unknown as typeof fetch;
    await handleRespondRequest({ workspace_id: "ws-1", request_id: "req-1", action: "done" });
    const call = (global.fetch as jest.Mock).mock.calls[0];
    expect(call[0]).toBe(`${PLATFORM_URL}/workspaces/ws-1/requests/req-1/respond`);
    expect(call[1].method).toBe("POST");
    const sent = JSON.parse(call[1].body);
    expect(sent).toEqual({ action: "done", responder_type: "agent", responder_id: "ws-1" });
  });

  it("also posts a thread message when `message` is supplied, returning both results", async () => {
    global.fetch = mockFetchSequence([
      { payload: { status: "approved", request_id: "req-1" } },
      { payload: { status: "created", request_id: "req-1", message_id: "m-1" } },
    ]) as unknown as typeof fetch;
    const res = await handleRespondRequest({
      workspace_id: "ws-1",
      request_id: "req-1",
      action: "approved",
      message: "looks good",
    });
    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][0]).toBe(`${PLATFORM_URL}/workspaces/ws-1/requests/req-1/messages`);
    const msgBody = JSON.parse(calls[1][1].body);
    expect(msgBody).toEqual({ body: "looks good", author_type: "agent", author_id: "ws-1" });
    const out = bodyOf(res);
    expect(out.respond.status).toBe("approved");
    expect(out.message.message_id).toBe("m-1");
  });
});

describe("add_request_message", () => {
  it("POSTs the thread message with author_type=agent, author_id=workspace_id", async () => {
    global.fetch = mockFetch({ status: "created", request_id: "req-1", message_id: "m-9" }) as unknown as typeof fetch;
    await handleAddRequestMessage({ workspace_id: "ws-1", request_id: "req-1", body: "need more info" });
    const call = (global.fetch as jest.Mock).mock.calls[0];
    expect(call[0]).toBe(`${PLATFORM_URL}/workspaces/ws-1/requests/req-1/messages`);
    expect(call[1].method).toBe("POST");
    const sent = JSON.parse(call[1].body);
    expect(sent).toEqual({ body: "need more info", author_type: "agent", author_id: "ws-1" });
  });
});

describe("cancel_request", () => {
  it("POSTs the cancel path for the requester workspace", async () => {
    global.fetch = mockFetch({ status: "cancelled", request_id: "req-1" }) as unknown as typeof fetch;
    const res = await handleCancelRequest({ workspace_id: "ws-1", request_id: "req-1" });
    const call = (global.fetch as jest.Mock).mock.calls[0];
    expect(call[0]).toBe(`${PLATFORM_URL}/workspaces/ws-1/requests/req-1/cancel`);
    expect(call[1].method).toBe("POST");
    expect(bodyOf(res).status).toBe("cancelled");
  });
});

describe("error passthrough", () => {
  it("surfaces a non-2xx platform error in the envelope (HTTP <code>)", async () => {
    global.fetch = mockFetch("boom", false, 500) as unknown as typeof fetch;
    const res = await handleCreateRequest({
      workspace_id: "ws-1",
      kind: "task",
      recipient_type: "agent",
      recipient_id: "ws-2",
      title: "x",
    });
    expect(bodyOf(res).error).toContain("HTTP 500");
  });
});
