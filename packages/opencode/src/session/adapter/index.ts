import type { Adapter, StreamPart } from "./types"
import { KimiAdapter } from "./kimi"

export * from "./types"
export * from "./kimi"

export class StreamAdapters {
    static apply(stream: AsyncIterable<StreamPart>, adapters: Adapter[]): AsyncIterable<StreamPart> {
        let current = stream
        for (const adapter of adapters) {
            current = adapter.transform(current)
        }
        return current
    }
}
