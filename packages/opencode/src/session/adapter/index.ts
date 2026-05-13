import type { Adapter, StreamPart } from "./types"

export * from "./types"
export * from "./kimi"

export function apply(stream: AsyncIterable<StreamPart>, adapters: Adapter[]): AsyncIterable<StreamPart> {
  let current = stream
  for (const adapter of adapters) {
    current = adapter.transform(current)
  }
  return current
}
