import type { Adapter, StreamPart } from "./types"

type ParsedToolCall = {
  toolCallId: string
  toolName: string
  input: Record<string, any>
}

export class KimiAdapter implements Adapter {
  private idCounter = 0
  private textCounter = 0
  private reasoningCounter = 0

  async *transform(stream: AsyncIterable<StreamPart>): AsyncIterable<StreamPart> {
    let buffer = ""
    const prefixParts: StreamPart[] = []
    const suffixParts: StreamPart[] = []
    let sawText = false

    for await (const part of stream) {
      if (part.type === "text-delta") {
        buffer += part.text
        sawText = true
        continue
      }
      if (part.type === "text-start" || part.type === "text-end") {
        sawText = true
        continue
      }
      if (sawText) {
        suffixParts.push(part)
      } else {
        prefixParts.push(part)
      }
    }

    const otherParts = [...prefixParts, ...suffixParts]
    const hasToolCalls = otherParts.some(
      (part) =>
        part.type === "tool-call" ||
        part.type === "tool-input-start" ||
        part.type === "tool-input-delta" ||
        part.type === "tool-input-end",
    )
    const hasReasoning = otherParts.some(
      (part) => part.type === "reasoning-start" || part.type === "reasoning-delta" || part.type === "reasoning-end",
    )

    const events = this.parse(buffer, {
      emitToolCalls: !hasToolCalls,
      emitReasoning: !hasReasoning,
    })

    for (const part of prefixParts) {
      yield part
    }

    for (const event of events) {
      yield event
    }

    for (const part of suffixParts) {
      yield part
    }
  }

  private parse(
    text: string,
    options?: {
      emitToolCalls?: boolean
      emitReasoning?: boolean
    },
  ): StreamPart[] {
    const parts: StreamPart[] = []
    let currentText = text

    const emitToolCalls = options?.emitToolCalls ?? true
    const emitReasoning = options?.emitReasoning ?? true

    const pushText = (value: string) => {
      if (!value) return
      const id = `text-${this.textCounter++}`
      parts.push({ type: "text-start", id })
      parts.push({ type: "text-delta", id, text: value })
      parts.push({ type: "text-end", id })
    }

    const pushToolCall = (toolCall: ParsedToolCall) => {
      parts.push({ type: "tool-input-start", toolName: toolCall.toolName, id: toolCall.toolCallId })
      parts.push({
        type: "tool-call",
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        input: toolCall.input,
      })
    }

    // 1. Handle Reasoning
    const thinkEndIndex = currentText.indexOf("</think>")
    if (thinkEndIndex !== -1) {
      let reasoningContent = currentText.slice(0, thinkEndIndex)
      reasoningContent = reasoningContent.replace(/^\s*<think>/, "")

      if (emitReasoning) {
        const reasoningId = `reasoning-${this.reasoningCounter++}`
        parts.push({ type: "reasoning-start", id: reasoningId })
        parts.push({ type: "reasoning-delta", id: reasoningId, text: reasoningContent })
        parts.push({ type: "reasoning-end", id: reasoningId })
      }

      currentText = currentText.slice(thinkEndIndex + "</think>".length)
    }

    // 2. Handle Tool Calls
    while (true) {
      const callBegin = currentText.indexOf("<|tool_call_begin|>")
      if (callBegin === -1) {
        let remaining = currentText
          .replace(/<\|tool_calls_section_begin\|>/g, "")
          .replace(/<\|tool_calls_section_end\|>/g, "")

        const extracted = this.extractJsonToolCalls(remaining)
        if (extracted.text) {
          pushText(extracted.text)
        }
        if (emitToolCalls) {
          for (const toolCall of extracted.toolCalls) {
            pushToolCall(toolCall)
          }
        }
        break
      }

      const preText = currentText.slice(0, callBegin)
      let cleanPreText = preText
        .replace(/<\|tool_calls_section_begin\|>/g, "")
        .replace(/<\|tool_calls_section_end\|>/g, "")

      if (cleanPreText) {
        pushText(cleanPreText)
      }

      const rest = currentText.slice(callBegin + "<|tool_call_begin|>".length)

      const argBegin = rest.indexOf("<|tool_call_argument_begin|>")
      if (argBegin === -1) {
        pushText("<|tool_call_begin|>" + rest)
        break
      }

      const funcIdRaw = rest.slice(0, argBegin).trim()
      const rest2 = rest.slice(argBegin + "<|tool_call_argument_begin|>".length)
      const callEnd = rest2.indexOf("<|tool_call_end|>")
      if (callEnd === -1) {
        pushText("<|tool_call_begin|>" + rest)
        break
      }

      const argsJson = rest2.slice(0, callEnd).trim()

      let toolName = "unknown"
      if (funcIdRaw.startsWith("functions.")) {
        const parts = funcIdRaw.split(":")
        const namePart = parts[0]
        toolName = namePart.replace("functions.", "")
      } else {
        toolName = funcIdRaw.split(":")[0]
      }

      const normalizedId = `functions.${toolName}:${this.idCounter++}`
      const input = this.normalizeInput(argsJson)

      if (emitToolCalls) {
        pushToolCall({
          toolCallId: normalizedId,
          toolName,
          input,
        })
      }

      currentText = rest2.slice(callEnd + "<|tool_call_end|>".length)
    }

    return parts
  }

  private extractJsonToolCalls(text: string): { text: string; toolCalls: ParsedToolCall[] } {
    let remaining = text
    const toolCalls: ParsedToolCall[] = []
    const needle = '"tool_calls"'
    let index = remaining.indexOf(needle)

    while (index !== -1) {
      const start = this.findJsonStart(remaining, index)
      if (start === -1) break

      const block = this.extractJsonBlock(remaining, start)
      if (!block) break

      let parsed: unknown
      try {
        parsed = JSON.parse(block.jsonText)
      } catch {
        index = remaining.indexOf(needle, index + needle.length)
        continue
      }

      const rawCalls = this.collectToolCalls(parsed)
      if (rawCalls.length === 0) {
        index = remaining.indexOf(needle, index + needle.length)
        continue
      }

      for (const rawCall of rawCalls) {
        const normalized = this.normalizeToolCall(rawCall)
        if (normalized) {
          toolCalls.push(normalized)
        }
      }

      remaining = remaining.slice(0, start) + remaining.slice(block.endIndex + 1)
      index = remaining.indexOf(needle)
    }

    return { text: remaining, toolCalls }
  }

  private findJsonStart(text: string, index: number) {
    const objectStart = text.lastIndexOf("{", index)
    const arrayStart = text.lastIndexOf("[", index)
    return Math.max(objectStart, arrayStart)
  }

  private extractJsonBlock(text: string, start: number): { jsonText: string; endIndex: number } | null {
    const opener = text[start]
    if (opener !== "{" && opener !== "[") return null

    const stack = [opener]
    let inString = false
    let escape = false

    for (let i = start + 1; i < text.length; i++) {
      const ch = text[i]

      if (inString) {
        if (escape) {
          escape = false
          continue
        }
        if (ch === "\\") {
          escape = true
          continue
        }
        if (ch === '"') {
          inString = false
        }
        continue
      }

      if (ch === '"') {
        inString = true
        continue
      }

      if (ch === "{" || ch === "[") {
        stack.push(ch)
        continue
      }

      if (ch === "}" || ch === "]") {
        const last = stack.pop()
        if (!last) return null
        if (stack.length === 0) {
          return { jsonText: text.slice(start, i + 1), endIndex: i }
        }
      }
    }

    return null
  }

  private collectToolCalls(value: unknown): unknown[] {
    if (!value) return []
    if (Array.isArray(value)) {
      return value.flatMap((item) => this.collectToolCalls(item))
    }
    if (typeof value === "object") {
      const obj = value as { tool_calls?: unknown; toolCalls?: unknown }
      const calls = obj.tool_calls ?? obj.toolCalls
      if (Array.isArray(calls)) {
        return calls
      }
    }
    return []
  }

  private normalizeToolCall(rawCall: any): ParsedToolCall | null {
    if (!rawCall || typeof rawCall !== "object") return null

    const toolName =
      (typeof rawCall.function?.name === "string" && rawCall.function.name) ||
      (typeof rawCall.name === "string" && rawCall.name)
    if (!toolName) return null

    const input = this.normalizeInput(rawCall.function?.arguments ?? rawCall.arguments)
    const toolCallId =
      typeof rawCall.id === "string" && rawCall.id ? rawCall.id : `functions.${toolName}:${this.idCounter++}`

    return { toolCallId, toolName, input }
  }

  private normalizeInput(value: unknown): Record<string, any> {
    let parsed = value

    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed)
      } catch {
        return { raw: value }
      }
    }

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, any>
    }

    if (parsed === undefined) return {}
    return { value: parsed }
  }
}
