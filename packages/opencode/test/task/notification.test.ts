import { describe, expect, spyOn, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { notifyBatchCompletion, notifyCompletion } from "../../src/task/notification"
import type { Task } from "../../src/task/types"
import { tmpdir } from "../fixture/fixture"

describe("task notification behavior", () => {
  test("notifyCompletion truncates long completed result", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const tail = "__tail_should_be_truncated__"
        const result = "x".repeat(11 * 1024) + tail

        const task: Task.TaskCompleted = {
          id: "task-truncate",
          status: "completed",
          sessionID: session.id,
          parentSessionID: session.id,
          parentMessageID: "msg-1",
          parentPartID: "part-1",
          parentCallID: "call-1",
          childSessionID: "child-1",
          description: "Long result task",
          agent: "build",
          prompt: "noop",
          createdAt: Date.now(),
          startedAt: Date.now(),
          completedAt: Date.now(),
          result,
        }

        await notifyCompletion(task)

        const msgs = await Session.messages({ sessionID: session.id })
        const note = msgs.findLast((msg) =>
          msg.parts.some((part) => part.type === "text" && part.text?.includes("<task-notification>")),
        )
        const text = note?.parts.find((part) => part.type === "text")?.text ?? ""

        expect(note).toBeDefined()
        expect(text).toContain("[truncated - use task_read(id) for full content]")
        expect(text).not.toContain(tail)

        await Session.remove(session.id)
      },
    })
  })

  test("notifyBatchCompletion does not throw when SessionPrompt.prompt fails", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const promptSpy = spyOn(SessionPrompt, "prompt").mockRejectedValue(new Error("prompt failed"))

        try {
          await expect(
            notifyBatchCompletion({
              batchId: "batch-prompt-failure",
              parentSessionID: session.id,
              results: [
                {
                  id: "task-1",
                  status: "completed",
                  description: "Task",
                  result: "Done",
                },
              ],
              noReply: true,
            }),
          ).resolves.toBeUndefined()
          expect(promptSpy).toHaveBeenCalledTimes(1)
        } finally {
          promptSpy.mockRestore()
        }

        await Session.remove(session.id)
      },
    })
  })
})
