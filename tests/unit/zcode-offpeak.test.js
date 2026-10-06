import { describe, it, expect, vi, afterEach } from "vitest";

import {
  createOffPeakClient,
  OffPeakServerError,
  isTicketReady,
  isTicketExpired,
  isOffPeakTicketExpiredError,
} from "../../open-sse/offpeak/client.js";
import { keepaliveFrame } from "../../open-sse/offpeak/keepalive.js";
import { runAsyncBridge } from "../../open-sse/offpeak/bridge.js";
import { reconstructAnthropicBatch, aggregateOpenAIStream } from "../../open-sse/offpeak/aggregate.js";

const CREDENTIALS = { jwt: "jwt-1", codingPlanApiKey: "plan.key" };
const ORIGIN = "https://zcode.z.ai";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function readAll(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

describe("off-peak control-plane client", () => {
  it("unwraps the {code:0,data} envelope and builds auth headers", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ code: 0, data: { can_take_number: false, next_take_at: 111 } });
    });
    const client = createOffPeakClient({ origin: ORIGIN, credentials: CREDENTIALS, fetchImpl });

    const avail = await client.getAvailability();
    expect(avail).toEqual({ canTakeNumber: false, nextTakeAt: 111 });
    expect(calls[0].url).toBe("https://zcode.z.ai/api/v1/off-peak/ticket/availability");
    expect(calls[0].init.headers.authorization).toBe("Bearer jwt-1");
    expect(calls[0].init.headers["x-coding-plan-api-key"]).toBe("plan.key");
  });

  it("takeTicket maps snake_case and computes nextPollAfterMs", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 0, data: { ticket_id: "t1", state: "queued", position: 3, next_poll_after: 2 } }));
    const client = createOffPeakClient({ origin: ORIGIN, credentials: CREDENTIALS, fetchImpl });
    const t = await client.takeTicket("task-1");
    expect(t).toMatchObject({ ticketId: "t1", state: "queued", position: 3, nextPollAfterMs: 2000 });
  });

  it("throws OffPeakServerError with bizCode on a non-zero code", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 4001, msg: "nope" }));
    const client = createOffPeakClient({ origin: ORIGIN, credentials: CREDENTIALS, fetchImpl });
    await expect(client.getAvailability()).rejects.toMatchObject({ name: "OffPeakServerError", bizCode: "4001" });
  });

  it("treats settle 4xx as success", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ msg: "gone" }, 404));
    const client = createOffPeakClient({ origin: ORIGIN, credentials: CREDENTIALS, fetchImpl });
    await expect(client.settle("t1")).resolves.toBeUndefined();
  });

  it("throws on settle 5xx", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ msg: "boom" }, 500));
    const client = createOffPeakClient({ origin: ORIGIN, credentials: CREDENTIALS, fetchImpl });
    await expect(client.settle("t1")).rejects.toBeInstanceOf(OffPeakServerError);
  });
});

describe("off-peak helpers", () => {
  it("classifies ticket states", () => {
    expect(isTicketReady("ready")).toBe(true);
    expect(isTicketReady("active")).toBe(true);
    expect(isTicketReady("queued")).toBe(false);
    expect(isTicketExpired("expired")).toBe(true);
    expect(isTicketExpired("not_found")).toBe(true);
    expect(isOffPeakTicketExpiredError("x off-peak-ticket-expired y")).toBe(true);
  });

  it("emits a pure SSE comment frame", () => {
    expect(new TextDecoder().decode(keepaliveFrame())).toBe(": keepalive\n\n");
    expect(new TextDecoder().decode(keepaliveFrame("a\nb"))).toBe(": a b\n\n");
  });
});

describe("off-peak async bridge", () => {
  afterEach(() => vi.unstubAllGlobals());

  function makeClient({ states }) {
    let i = 0;
    return {
      settle: vi.fn(async () => {}),
      takeTicket: vi.fn(async () => ({ ticketId: `t${++i + 1}`, state: "queued" })),
      batchStatus: vi.fn(async () => ({ tickets: [states[Math.min(i, states.length - 1)]] })),
    };
  }

  it("waits, forwards, streams frames, and settles once (done)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response("event: message_start\ndata: {\"type\":\"message_start\"}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
    ));
    const client = makeClient({ states: [{ ticketId: "t1", state: "ready" }] });

    const { stream, outcome } = runAsyncBridge({
      client, credentials: { jwt: "j", codingPlanApiKey: "k" }, origin: ORIGIN,
      llmRequestBody: "{}", initialTicket: { ticketId: "t1", state: "queued" }, taskId: "task",
      pollIntervalMs: 1, keepAliveIntervalMs: 100000, maxRetries: 3, maxWaitMs: 0,
    });

    const text = await readAll(stream);
    const result = await outcome;
    expect(text).toContain("message_start");
    expect(result.terminalPhase).toBe("done");
    expect(client.settle).toHaveBeenCalledTimes(1);
    expect(client.settle).toHaveBeenCalledWith("t1");
  });

  it("retakes a ticket when the queue ticket expires", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("data: ok\n\n", { status: 200 })));
    const client = {
      settle: vi.fn(async () => {}),
      takeTicket: vi.fn(async () => ({ ticketId: "t2", state: "queued" })),
      batchStatus: vi.fn()
        .mockResolvedValueOnce({ tickets: [{ ticketId: "t1", state: "expired" }] })
        .mockResolvedValue({ tickets: [{ ticketId: "t2", state: "ready" }] }),
    };

    const { stream, outcome } = runAsyncBridge({
      client, credentials: { jwt: "j", codingPlanApiKey: "k" }, origin: ORIGIN,
      llmRequestBody: "{}", initialTicket: { ticketId: "t1", state: "queued" }, taskId: "task",
      pollIntervalMs: 1, keepAliveIntervalMs: 100000, maxRetries: 3, maxWaitMs: 0,
    });

    await readAll(stream);
    const result = await outcome;
    expect(client.takeTicket).toHaveBeenCalledTimes(1);
    expect(result.terminalPhase).toBe("done");
    expect(client.settle).toHaveBeenCalledWith("t1");
    expect(client.settle).toHaveBeenCalledWith("t2");
  });

  it("emits a terminal error when retries are exhausted", async () => {
    const client = {
      settle: vi.fn(async () => {}),
      takeTicket: vi.fn(async () => ({ ticketId: "tx", state: "queued" })),
      batchStatus: vi.fn(async () => ({ tickets: [{ ticketId: "t1", state: "expired" }] })),
    };
    const { stream, outcome } = runAsyncBridge({
      client, credentials: { jwt: "j", codingPlanApiKey: "k" }, origin: ORIGIN,
      llmRequestBody: "{}", initialTicket: { ticketId: "t1", state: "queued" }, taskId: "task",
      pollIntervalMs: 1, keepAliveIntervalMs: 100000, maxRetries: 1, maxWaitMs: 0,
    });
    const text = await readAll(stream);
    const result = await outcome;
    expect(text).toContain("event: error");
    expect(result.terminalPhase).toBe("error");
  });
});

describe("off-peak response aggregation", () => {
  it("reconstructs an Anthropic batch from SSE (fail-closed on error)", () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","role":"assistant","usage":{"input_tokens":3,"output_tokens":0}}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ].join("\n\n") + "\n\n";

    const msg = reconstructAnthropicBatch(sse);
    expect(msg.id).toBe("m1");
    expect(msg.content).toEqual([{ type: "text", text: "Hi" }]);
    expect(msg.stop_reason).toBe("end_turn");
    expect(msg.usage.output_tokens).toBe(1);

    expect(reconstructAnthropicBatch('event: error\ndata: {"type":"error"}')).toBeNull();
    expect(reconstructAnthropicBatch(sse.replace("message_stop", "nope"))).toBeNull();
  });

  it("aggregates OpenAI chunks into a single completion", () => {
    const sse = [
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"glm-4.6","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}',
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"glm-4.6","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}]}',
      "data: [DONE]",
    ].join("\n\n") + "\n\n";

    const out = aggregateOpenAIStream(sse);
    expect(out.id).toBe("c1");
    expect(out.choices[0].message).toEqual({ role: "assistant", content: "Hello" });
    expect(out.choices[0].finish_reason).toBe("stop");
  });
});