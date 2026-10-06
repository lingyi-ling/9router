// Off-peak async response aggregation — turns the bridge's SSE byte stream into
// a single non-streaming JSON document for clients that asked for stream:false.
//
// Two shapes:
//   - Anthropic (from zcode-api src/async/handler.ts reconstructAnthropicBatch)
//   - OpenAI (translated from the Anthropic SSE via the stream adapter)
//
// While waiting on the ticket queue the bridge emits keepalive comments; we
// mirror the reference and write one space byte per received chunk so a TCP
// idle timer never fires during the wait.

const SINGLE_SPACE = new Uint8Array([32]);

/**
 * Wrap an SSE byte stream as a chunked JSON response stream.
 * @param {ReadableStream<Uint8Array>} bridgeStream
 * @param {{translate?: "openai", model?: string}} [opts]
 * @returns {ReadableStream<Uint8Array>}
 */
export function nonStreamChunkedJson(bridgeStream, opts) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const reader = bridgeStream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          try { controller.enqueue(SINGLE_SPACE); } catch { return; }
          buffer += decoder.decode(value, { stream: true });
        }
        buffer += decoder.decode();
      } finally {
        reader.releaseLock?.();
      }

      let finalJson;
      if (opts?.translate === "openai") {
        const openai = aggregateOpenAIStream(buffer);
        finalJson = openai ? JSON.stringify(openai) : JSON.stringify({ error: { type: "async_aggregation_failed", message: "could not reconstruct OpenAI response from bridge stream" } });
      } else {
        const anthropic = reconstructAnthropicBatch(buffer);
        finalJson = anthropic ? JSON.stringify(anthropic) : JSON.stringify({ error: { type: "async_aggregation_failed", message: "could not reconstruct response from bridge stream" } });
      }
      try { controller.enqueue(encoder.encode(finalJson)); } catch { /* closed */ }
      controller.close();
    },
  });
}

/**
 * Reconstruct a synthetic Anthropic Messages response from Anthropic SSE bytes.
 * Fail-closed: returns null when `message_stop` is absent or an error event was
 * seen. Preserves thinking signatures and tool_use inputs.
 * @param {string} sseText
 * @returns {object|null}
 */
export function reconstructAnthropicBatch(sseText) {
  const blocks = sseText.split("\n\n");
  let message = null;
  const content = [];
  let currentBlock = null;
  let currentToolJson = "";
  let sawMessageStop = false;
  let sawError = false;

  for (const block of blocks) {
    const lines = block.split("\n");
    let eventType;
    let data;
    for (const line of lines) {
      if (line.startsWith("event:")) eventType = line.slice(6).trim();
      else if (line.startsWith("data:")) data = line.slice(5).trim();
    }
    if (!data) continue;
    let parsed;
    try { parsed = JSON.parse(data); } catch { continue; }
    const type = eventType ?? parsed.type;

    switch (type) {
      case "message_start":
        message = { ...(parsed.message ?? {}) };
        break;
      case "content_block_start": {
        const cb = parsed.content_block;
        if (!cb || !cb.type) break;
        if (cb.type === "text") currentBlock = { type: "text", text: "" };
        else if (cb.type === "thinking") currentBlock = { type: "thinking", thinking: "" };
        else if (cb.type === "tool_use" && typeof cb.id === "string" && typeof cb.name === "string") {
          currentBlock = { type: "tool_use", id: cb.id, name: cb.name, input: {} };
          currentToolJson = "";
        }
        break;
      }
      case "content_block_delta": {
        const delta = parsed.delta;
        if (!currentBlock || !delta) break;
        if (delta.type === "text_delta" && currentBlock.type === "text" && typeof delta.text === "string") {
          currentBlock.text += delta.text;
        } else if (delta.type === "thinking_delta" && currentBlock.type === "thinking" && typeof delta.thinking === "string") {
          currentBlock.thinking += delta.thinking;
        } else if (delta.type === "signature_delta" && currentBlock.type === "thinking" && typeof delta.signature === "string") {
          currentBlock.signature = (currentBlock.signature ?? "") + delta.signature;
        } else if (delta.type === "input_json_delta" && currentBlock.type === "tool_use" && typeof delta.partial_json === "string") {
          currentToolJson += delta.partial_json;
        }
        break;
      }
      case "content_block_stop":
        if (currentBlock) {
          if (currentBlock.type === "tool_use") {
            try { currentBlock.input = JSON.parse(currentToolJson || "{}"); } catch { currentBlock.input = {}; }
            currentToolJson = "";
          }
          content.push(currentBlock);
          currentBlock = null;
        }
        break;
      case "message_delta": {
        const delta = parsed.delta;
        const usage = parsed.usage;
        if (delta && message) Object.assign(message, delta);
        if (usage && message) message.usage = { ...(message.usage ?? { input_tokens: 0, output_tokens: 0 }), ...usage };
        break;
      }
      case "message_stop":
        sawMessageStop = true;
        break;
      case "error":
        sawError = true;
        break;
      default:
        break;
    }
  }

  if (sawError || !sawMessageStop || !message) return null;
  message.content = content;
  if (!message.stop_reason) message.stop_reason = "end_turn";
  if (!message.role) message.role = "assistant";
  if (!message.usage) message.usage = { input_tokens: 0, output_tokens: 0 };
  return message;
}

/**
 * Aggregate OpenAI chat.completion.chunk SSE bytes into a single
 * chat.completion object. Returns null when no usable chunk was seen.
 * @param {string} sseText
 * @returns {object|null}
 */
export function aggregateOpenAIStream(sseText) {
  const blocks = sseText.split("\n\n");
  const result = {
    id: null,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: null,
    choices: [],
    usage: null,
  };
  let content = "";
  let role = "assistant";
  let finishReason = null;
  const toolCalls = new Map();
  let sawChunk = false;

  for (const block of blocks) {
    if (!block.trim() || block.trim().startsWith(":")) continue;
    const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) continue;
    const dataStr = dataLine.slice(5).trim();
    if (!dataStr || dataStr === "[DONE]") continue;
    let parsed;
    try { parsed = JSON.parse(dataStr); } catch { continue; }
    if (parsed.error) return { error: parsed.error };
    if (parsed.object !== "chat.completion.chunk" && !parsed.choices) continue;
    sawChunk = true;
    result.id = result.id ?? parsed.id;
    result.model = result.model ?? parsed.model;
    result.created = parsed.created ?? result.created;
    if (parsed.usage) result.usage = parsed.usage;
    const choice = parsed.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (typeof delta.role === "string") role = delta.role;
    if (typeof delta.content === "string") content += delta.content;
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        const prev = toolCalls.get(idx) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
        if (tc.id) prev.id = tc.id;
        if (tc.type) prev.type = tc.type;
        if (tc.function?.name) prev.function.name += tc.function.name;
        if (typeof tc.function?.arguments === "string") prev.function.arguments += tc.function.arguments;
        toolCalls.set(idx, prev);
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  if (!sawChunk) return null;
  const message = { role, content };
  if (toolCalls.size > 0) message.tool_calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  result.choices = [{ index: 0, message, finish_reason: finishReason ?? "stop" }];
  return result;
}