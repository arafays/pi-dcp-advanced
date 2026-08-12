import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { loadConfig, type ResolvedConfig } from "./config.js"

describe("loadConfig", () => {
  let tempDir: string

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "dcp-config-"))
  })

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  const path = (name: string) => join(tempDir, name)

  const write = (name: string, data: unknown) =>
    Effect.promise(() => writeFile(path(name), JSON.stringify(data), "utf8"))

  it.effect("applies defaults when no files exist", () =>
    Effect.gen(function* () {
      const config: ResolvedConfig = yield* loadConfig({
        globalPath: path("missing-global.json"),
        projectPath: path("missing-project.json")
      })
      expect(config.enabled).toBe(true)
      expect(config.compress.mode).toBe("range")
      expect(config.compress.maxContextLimit).toBe(100000)
      expect(config.compress.minContextLimit).toBe(50000)
      expect(config.manualMode.enabled).toBe(false)
      expect(config.manualMode.automaticStrategies).toBe(true)
      expect(config.compress.permission).toBe("allow")
    })
  )

  it.effect("project overrides global on a field and wins", () =>
    Effect.gen(function* () {
      yield* write("global.json", {
        enabled: false,
        compress: { maxContextLimit: 200000 }
      })
      yield* write("project.json", {
        compress: { maxContextLimit: 300000 }
      })
      const config = yield* loadConfig({
        globalPath: path("global.json"),
        projectPath: path("project.json")
      })
      // Project wins on the conflicting field.
      expect(config.compress.maxContextLimit).toBe(300000)
      // A field only present in global still applies.
      expect(config.enabled).toBe(false)
      // An untouched field falls back to the default.
      expect(config.compress.mode).toBe("range")
    })
  )

  it.effect("ignores unknown fields", () =>
    Effect.gen(function* () {
      yield* write("project.json", { enabled: true, bogusField: 123 })
      const config = yield* loadConfig({
        globalPath: path("missing-global.json"),
        projectPath: path("project.json")
      })
      expect(config.enabled).toBe(true)
      expect("bogusField" in config).toBe(false)
    })
  )

  it.effect("fails on a malformed value", () =>
    Effect.gen(function* () {
      yield* write("project.json", { enabled: "yes" })
      const result = yield* Effect.exit(
        loadConfig({ globalPath: path("missing-global.json"), projectPath: path("project.json") })
      )
      expect(Exit.isFailure(result)).toBe(true)
    })
  )
})
