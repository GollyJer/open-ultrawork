import { describe, expect, spyOn, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Server } from "../../src/server/server"
import { TaskManager } from "../../src/task/manager"
import { TaskRunner } from "../../src/task/runner"
import { Store } from "../../src/task/store"

describe("session.abort task cancellation", () => {
  test("aborting parent session cancels running child task sessions", async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runSpy = spyOn(TaskRunner, "run").mockImplementation(() => gate)
    const cancelSpy = spyOn(SessionPrompt, "cancel")

    try {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const parent = await Session.create({})
          const child = await Session.create({ parentID: parent.id })

          const taskID = await TaskManager.start({
            sessionID: parent.id,
            parentMessageID: "msg_parent",
            parentPartID: "part_parent",
            parentCallID: "call_parent",
            description: "test child cancellation",
            agent: "build",
            prompt: "noop",
          })

          const queued = await Store.get(parent.id, taskID)
          if (!queued) throw new Error("Task should exist")

          await Store.update({
            ...queued,
            status: "running",
            childSessionID: child.id,
            startedAt: Date.now(),
          })
          expect(TaskManager.isTaskActive(taskID)).toBe(true)

          const app = Server.App()
          const response = await app.request(`/session/${parent.id}/abort`, {
            method: "POST",
          })

          expect(response.status).toBe(200)
          expect(await response.json()).toBe(true)
          expect(cancelSpy).toHaveBeenCalledWith(parent.id)
          expect(cancelSpy).toHaveBeenCalledWith(child.id)
        },
      })
    } finally {
      release()
      await Bun.sleep(0)
      cancelSpy.mockRestore()
      runSpy.mockRestore()
    }
  })
})
