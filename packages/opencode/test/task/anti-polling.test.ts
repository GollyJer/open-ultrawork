import { describe, expect, test } from "bun:test"
import { reminderRemaining } from "../../src/task/anti-polling"

describe("anti-polling reminders", () => {
  test("reminderRemaining includes remaining task count", () => {
    const text = reminderRemaining(3)
    expect(text).toContain("3")
  })
})
