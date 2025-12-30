import { type StreamTextResult } from "ai"

export type StreamPart =
    | { type: 'text-delta'; text: string }
    | { type: 'tool-call'; toolCallId: string; toolName: string; input: any }
    | { type: 'reasoning-start'; id?: string; providerMetadata?: any }
    | { type: 'reasoning-delta'; id?: string; text: string; providerMetadata?: any }
    | { type: 'reasoning-end'; id?: string; providerMetadata?: any }
    | { type: 'tool-input-start'; toolName: string; id: string }
    | { type: 'tool-input-delta'; id: string; argsText: string }
    | { type: 'tool-input-end'; id: string; args: any }
    | any // Fallback for other types we might pass through

export interface Adapter {
    transform(stream: AsyncIterable<StreamPart>): AsyncIterable<StreamPart>
}
