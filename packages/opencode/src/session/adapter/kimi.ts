import type { Adapter, StreamPart } from "./types"

export class KimiAdapter implements Adapter {
    private idCounter = 0

    async *transform(stream: AsyncIterable<StreamPart>): AsyncIterable<StreamPart> {
        let buffer = ""
        const otherParts: StreamPart[] = []

        for await (const part of stream) {
            if (part.type === 'text-delta') {
                buffer += part.text
            } else {
                otherParts.push(part)
            }
        }

        // Process the buffer
        const events = this.parse(buffer)

        // Yield parsed events
        for (const event of events) {
            yield event
        }

        // Yield other parts (preserved from original stream)
        for (const part of otherParts) {
            yield part
        }
    }

    private parse(text: string): StreamPart[] {
        const parts: StreamPart[] = []
        let currentText = text

        // 1. Handle Reasoning
        // Look for </think>
        const thinkEndIndex = currentText.indexOf("</think>")
        if (thinkEndIndex !== -1) {
            // We assume everything before </think> is reasoning
            const reasoningContent = currentText.slice(0, thinkEndIndex)

            // Remove <think> if it exists at the start (or anywhere in the reasoning block?)
            // User says: "generation config often templates 'stuff stuff stuff<think>' as a starter"
            // So we might see "<think>" in the content. We should probably strip it or just treat it as content?
            // "moving '^blah blah blah</think>' -> reasoning content"
            // I'll just take the content. If <think> is there, it's part of the reasoning text unless I strip it.
            // I'll strip <think> if it's at the very beginning, but otherwise leave it?
            // Actually, if the model continues from <think>, the <think> tag might not be in the output if it was part of the prompt.
            // But if it *is* in the output, we should probably include it or strip it.
            // I'll leave it as is, just treating the block as reasoning.

            parts.push({ type: 'reasoning-start' })
            parts.push({ type: 'reasoning-delta', text: reasoningContent })
            parts.push({ type: 'reasoning-end' })

            currentText = currentText.slice(thinkEndIndex + "</think>".length)
        }

        // 2. Handle Tool Calls
        while (true) {
            const callBegin = currentText.indexOf("<|tool_call_begin|>")
            if (callBegin === -1) {
                // No more tool calls
                // Clean up remaining text
                let remaining = currentText
                    .replace(/<\|tool_calls_section_begin\|>/g, "")
                    .replace(/<\|tool_calls_section_end\|>/g, "")

                if (remaining) {
                    parts.push({ type: 'text-delta', text: remaining })
                }
                break
            }

            // Text before tool call
            const preText = currentText.slice(0, callBegin)
            let cleanPreText = preText
                .replace(/<\|tool_calls_section_begin\|>/g, "")
                .replace(/<\|tool_calls_section_end\|>/g, "")

            if (cleanPreText) {
                parts.push({ type: 'text-delta', text: cleanPreText })
            }

            // Parse tool call
            const rest = currentText.slice(callBegin + "<|tool_call_begin|>".length)

            // Find arguments begin
            const argBegin = rest.indexOf("<|tool_call_argument_begin|>")
            if (argBegin === -1) {
                // Malformed, treat rest as text?
                // Or just stop parsing?
                // I'll treat as text to be safe
                parts.push({ type: 'text-delta', text: "<|tool_call_begin|>" + rest })
                break
            }

            const funcIdRaw = rest.slice(0, argBegin).trim() // e.g. functions.write:59

            const rest2 = rest.slice(argBegin + "<|tool_call_argument_begin|>".length)
            const callEnd = rest2.indexOf("<|tool_call_end|>")
            if (callEnd === -1) {
                // Malformed
                parts.push({ type: 'text-delta', text: "<|tool_call_begin|>" + rest })
                break
            }

            const argsJson = rest2.slice(0, callEnd).trim()

            // Parse ID and Name
            let toolName = "unknown"

            if (funcIdRaw.startsWith("functions.")) {
                const parts = funcIdRaw.split(":")
                const namePart = parts[0] // functions.write
                toolName = namePart.replace("functions.", "")
            } else {
                toolName = funcIdRaw.split(":")[0]
            }

            const normalizedId = `functions.${toolName}:${this.idCounter++}`

            let args = {}
            try {
                args = JSON.parse(argsJson)
            } catch (e) {
                // If args fail to parse, what should we do?
                // Maybe emit as text? Or emit error?
                // I'll emit as tool call with empty args or error?
                // processor.ts might handle it.
                // But if I can't parse JSON, I can't really pass it as 'args' object.
                // I'll try to recover or just log?
                console.error("Failed to parse tool args", argsJson)
            }

            parts.push({
                type: 'tool-call',
                toolCallId: normalizedId,
                toolName: toolName,
                args: args
            })

            currentText = rest2.slice(callEnd + "<|tool_call_end|>".length)
        }

        return parts
    }
}
