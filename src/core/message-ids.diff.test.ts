import { describe, expect, it } from "@effect/vitest"
import {
  formatBlockRef as srcFormatBlockRef,
  formatMessageIdTag as srcFormatMessageIdTag,
  formatMessageRef as srcFormatMessageRef,
  parseBlockRef as srcParseBlockRef,
  parseMessageRef as srcParseMessageRef
} from "../../../opencode-dynamic-context-pruning/lib/message-ids.ts"
import { formatBlockRef, formatMessageIdTag, formatMessageRef, parseBlockRef, parseMessageRef } from "./message-ids.js"

// ---------------------------------------------------------------------------
// Differential harness: run the REAL opencode-dcp message-id helpers and the
// pi-dcp port against identical inputs, assert byte-identical output. The port
// is a verbatim port of lib/message-ids.ts; this pins format/parse/XML-tag
// behavior so the mNNNN refs the model sees are identical to upstream DCP.
// ---------------------------------------------------------------------------

describe("differential: message-id helpers vs real opencode-dcp source", () => {
  it("formatMessageRef is byte-identical for valid indices", () => {
    for (const index of [1, 2, 9, 10, 9999]) {
      expect(formatMessageRef(index)).toBe(srcFormatMessageRef(index))
    }
  })

  it("formatMessageRef throws for the same out-of-range indices", () => {
    for (const index of [0, -1, 10000, 1.5, Number.NaN]) {
      expect(() => formatMessageRef(index)).toThrow()
      expect(() => srcFormatMessageRef(index)).toThrow()
    }
  })

  it("formatBlockRef is byte-identical for valid block ids", () => {
    for (const blockId of [1, 2, 123]) {
      expect(formatBlockRef(blockId)).toBe(srcFormatBlockRef(blockId))
    }
  })

  it("formatBlockRef throws for the same invalid block ids", () => {
    for (const blockId of [0, -1, 1.5]) {
      expect(() => formatBlockRef(blockId)).toThrow()
      expect(() => srcFormatBlockRef(blockId)).toThrow()
    }
  })

  it("parseMessageRef matches the source for a spread of refs", () => {
    for (const ref of ["m0001", "M0001", "m1", "m9999", "m0000", "b2", "", "  m0010  "]) {
      expect(parseMessageRef(ref)).toBe(srcParseMessageRef(ref))
    }
  })

  it("parseBlockRef matches the source for a spread of refs", () => {
    for (const ref of ["b2", "B2", "b123", "b0", "b", "m0001", "", "  b7  "]) {
      expect(parseBlockRef(ref)).toBe(srcParseBlockRef(ref))
    }
  })

  it("formatMessageIdTag is byte-identical with and without attributes", () => {
    const noAttrs = "m0001"
    expect(formatMessageIdTag(noAttrs)).toBe(srcFormatMessageIdTag(noAttrs))

    const attrs: Record<string, string | undefined> = {
      priority: "high",
      amp: "a&b",
      quote: 'say "hi"',
      lt: "<x>",
      empty: "",
      skipped: undefined
    }
    expect(formatMessageIdTag("m0002", attrs)).toBe(srcFormatMessageIdTag("m0002", attrs))

    expect(formatMessageIdTag("b7", { topic: "auth" })).toBe(srcFormatMessageIdTag("b7", { topic: "auth" }))
  })
})
