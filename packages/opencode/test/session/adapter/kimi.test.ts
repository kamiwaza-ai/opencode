import { describe, expect, test } from "bun:test"
import { apply, KimiAdapter, type StreamPart } from "@/session/adapter"

async function collect(parts: StreamPart[]) {
  async function* source() {
    yield* parts
  }
  return Array.fromAsync(apply(source(), [new KimiAdapter()]))
}

describe("KimiAdapter", () => {
  test("splits tagged reasoning from answer text", async () => {
    const result = await collect([
      { type: "start" },
      { type: "text-start", id: "provider-text" },
      { type: "text-delta", id: "provider-text", text: "<think>check the facts</think>The answer." },
      { type: "text-end", id: "provider-text" },
      { type: "finish", finishReason: "stop" },
    ])

    expect(result).toEqual([
      { type: "start" },
      { type: "reasoning-start", id: "reasoning-0" },
      { type: "reasoning-delta", id: "reasoning-0", text: "check the facts" },
      { type: "reasoning-end", id: "reasoning-0" },
      { type: "text-start", id: "text-0" },
      { type: "text-delta", id: "text-0", text: "The answer." },
      { type: "text-end", id: "text-0" },
      { type: "finish", finishReason: "stop" },
    ])
  })

  test("converts Kimi tool tokens and preserves surrounding text", async () => {
    const result = await collect([
      {
        type: "text-delta",
        text:
          "Before<|tool_calls_section_begin|><|tool_call_begin|>functions.shell:0<|tool_call_argument_begin|>" +
          '{"command":"pwd"}<|tool_call_end|><|tool_calls_section_end|>After',
      },
    ])

    expect(result).toEqual([
      { type: "text-start", id: "text-0" },
      { type: "text-delta", id: "text-0", text: "Before" },
      { type: "text-end", id: "text-0" },
      { type: "tool-input-start", toolName: "shell", id: "functions.shell:0" },
      { type: "tool-call", toolCallId: "functions.shell:0", toolName: "shell", input: { command: "pwd" } },
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", text: "After" },
      { type: "text-end", id: "text-1" },
    ])
  })

  test("converts JSON tool_calls emitted as text", async () => {
    const result = await collect([
      {
        type: "text-delta",
        text: JSON.stringify({
          tool_calls: [{ id: "call-7", type: "function", function: { name: "search", arguments: '{"query":"kbox"}' } }],
        }),
      },
    ])

    expect(result).toEqual([
      { type: "tool-input-start", toolName: "search", id: "call-7" },
      { type: "tool-call", toolCallId: "call-7", toolName: "search", input: { query: "kbox" } },
    ])
  })

  test("does not duplicate provider-native reasoning or tool calls", async () => {
    const result = await collect([
      { type: "reasoning-start", id: "native-reasoning" },
      { type: "reasoning-delta", id: "native-reasoning", text: "native thought" },
      { type: "reasoning-end", id: "native-reasoning" },
      { type: "text-delta", text: "<think>duplicate thought</think>Visible" },
      { type: "tool-call", toolCallId: "native-call", toolName: "read", input: { path: "/tmp/x" } },
    ])

    expect(result).toEqual([
      { type: "reasoning-start", id: "native-reasoning" },
      { type: "reasoning-delta", id: "native-reasoning", text: "native thought" },
      { type: "reasoning-end", id: "native-reasoning" },
      { type: "text-start", id: "text-0" },
      { type: "text-delta", id: "text-0", text: "Visible" },
      { type: "text-end", id: "text-0" },
      { type: "tool-call", toolCallId: "native-call", toolName: "read", input: { path: "/tmp/x" } },
    ])
  })

  test("preserves orphaned and unclosed reasoning markers as text", async () => {
    for (const text of ["visible</think>tail", "<think>unfinished"]) {
      const result = await collect([{ type: "text-delta", text }])

      expect(
        result
          .filter((part) => part.type === "text-delta")
          .map((part) => part.text)
          .join(""),
      ).toBe(text)
      expect(result.some((part) => part.type === "reasoning-start")).toBe(false)
    }
  })

  test("preserves malformed tool markers and section wrappers as text", async () => {
    const text = "Keep <|tool_calls_section_begin|><|tool_call_begin|>functions.shell:0 without arguments"
    const result = await collect([{ type: "text-delta", text }])

    expect(
      result
        .filter((part) => part.type === "text-delta")
        .map((part) => part.text)
        .join(""),
    ).toBe(text)
    expect(result.some((part) => part.type === "tool-call")).toBe(false)
  })
})
