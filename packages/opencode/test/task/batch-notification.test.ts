import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"
import { tmpdir } from "../fixture/fixture"
import { Provider } from "../../src/provider/provider"
import { SessionPrompt } from "../../src/session/prompt"
import { notifyBatchCompletion } from "../../src/task/notification"
import { handleBatchCompletion } from "../../src/task/runner"
import { TaskManager } from "../../src/task/manager"

describe("batch-complete agent preservation", () => {
  test("handleBatchCompletion sends one batch notification for concurrent duplicate completion", async () => {
    const batchId = `race-batch-${Date.now()}`
    const taskId = `race-task-${Date.now()}`
    TaskManager.registerBatch(batchId, "session-race", taskId, "Race task")

    let calls = 0
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const notify = async () => {
      calls++
      await gate
    }

    const a = handleBatchCompletion(batchId, taskId, "completed", "ok", "Race task", notify)
    const b = handleBatchCompletion(batchId, taskId, "completed", "ok", "Race task", notify)

    await Bun.sleep(0)
    expect(calls).toBe(1)

    release()
    await Promise.all([a, b])
  })

  test("notifyBatchCompletion preserves plan agent from latest user message", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const defaultModel = await Provider.defaultModel()

        // Create user message with plan agent
        const userMsg: MessageV2.User = {
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "plan",
          model: defaultModel,
        }
        await Session.updateMessage(userMsg)

        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: userMsg.id,
          sessionID: session.id,
          type: "text",
          text: "Test planning request",
        })

        // Call notifyBatchCompletion with noReply to avoid triggering agent loop
        await notifyBatchCompletion({
          batchId: "test-batch-1",
          parentSessionID: session.id,
          results: [
            {
              id: "task-1",
              status: "completed",
              description: "Test task",
              result: "Task completed successfully",
            },
          ],
          noReply: true, // For testing - avoid agent loop
        })

        // Verify the synthetic batch-complete message was created with plan agent
        const msgs = await Session.messages({ sessionID: session.id })
        const batchMsg = msgs.findLast((m) => m.info.role === "user" && m.info.id !== userMsg.id)

        expect(batchMsg).toBeDefined()
        expect(batchMsg?.info.agent).toBe("plan")

        // Verify the message contains batch-complete content
        expect(batchMsg?.parts.some((p) => p.type === "text" && p.text?.includes("<batch-complete"))).toBe(true)
        expect(batchMsg?.parts.some((p) => p.type === "text" && p.text?.includes("task-1"))).toBe(true)

        await Session.remove(session.id)
      },
    })
  })

  test("notifyBatchCompletion uses default build agent when no prior user message exists", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        // Call notifyBatchCompletion without any prior user messages
        await notifyBatchCompletion({
          batchId: "test-batch-2",
          parentSessionID: session.id,
          results: [
            {
              id: "task-2",
              status: "completed",
              description: "Test task",
              result: "Task completed successfully",
            },
          ],
          noReply: true, // For testing - avoid agent loop
        })

        // Verify the synthetic batch-complete message was created with default build agent
        const msgs = await Session.messages({ sessionID: session.id })
        const batchMsg = msgs.findLast((m) => m.info.role === "user")

        expect(batchMsg).toBeDefined()
        expect(batchMsg?.info.agent).toBe("build")

        await Session.remove(session.id)
      },
    })
  })

  test("notifyBatchCompletion preserves plan agent even with intervening assistant messages", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const defaultModel = await Provider.defaultModel()

        // Create user message with plan agent
        const userMsg: MessageV2.User = {
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "plan",
          model: defaultModel,
        }
        await Session.updateMessage(userMsg)

        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: userMsg.id,
          sessionID: session.id,
          type: "text",
          text: "Test planning request",
        })

        // Create assistant message (simulating a conversation in progress)
        const assistantMsg: MessageV2.Assistant = {
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "assistant",
          parentID: userMsg.id,
          time: { created: Date.now() },
          agent: "plan",
          mode: "plan",
          modelID: defaultModel.modelID,
          providerID: defaultModel.providerID,
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "stop",
        }
        await Session.updateMessage(assistantMsg)

        // Call notifyBatchCompletion - should still find plan agent from user message
        await notifyBatchCompletion({
          batchId: "test-batch-3",
          parentSessionID: session.id,
          results: [
            {
              id: "task-3",
              status: "failed",
              description: "Test failed task",
              error: "Something went wrong",
            },
          ],
          noReply: true, // For testing - avoid agent loop
        })

        // Verify the synthetic batch-complete message used plan agent
        const msgs = await Session.messages({ sessionID: session.id })
        const batchMsg = msgs.findLast((m) => m.info.role === "user" && m.info.id !== userMsg.id)

        expect(batchMsg).toBeDefined()
        expect(batchMsg?.info.agent).toBe("plan")

        // Verify it's not the original user message
        expect(batchMsg?.info.id).not.toBe(userMsg.id)

        await Session.remove(session.id)
      },
    })
  })

  test("notifyBatchCompletion handles multiple tasks in batch", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const defaultModel = await Provider.defaultModel()

        // Create user message with plan agent
        const userMsg: MessageV2.User = {
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "plan",
          model: defaultModel,
        }
        await Session.updateMessage(userMsg)

        // Call notifyBatchCompletion with multiple tasks
        await notifyBatchCompletion({
          batchId: "test-batch-4",
          parentSessionID: session.id,
          results: [
            {
              id: "task-4a",
              status: "completed",
              description: "First task",
              result: "Success",
            },
            {
              id: "task-4b",
              status: "failed",
              description: "Second task",
              error: "Failed",
            },
          ],
          noReply: true, // For testing - avoid agent loop
        })

        // Verify message was created with plan agent
        const msgs = await Session.messages({ sessionID: session.id })
        const batchMsg = msgs.findLast((m) => m.info.role === "user" && m.info.id !== userMsg.id)

        expect(batchMsg).toBeDefined()
        expect(batchMsg?.info.agent).toBe("plan")

        // Verify message contains both tasks
        const batchText = batchMsg?.parts.find((p) => p.type === "text")?.text ?? ""
        expect(batchText).toContain("task-4a")
        expect(batchText).toContain("task-4b")
        expect(batchText).toContain("completed")
        expect(batchText).toContain("failed")

        await Session.remove(session.id)
      },
    })
  })

  test("agent extraction logic finds latest user message with plan agent", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const defaultModel = await Provider.defaultModel()

        // Create user message with plan agent
        const userMsg: MessageV2.User = {
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "plan",
          model: defaultModel,
        }
        await Session.updateMessage(userMsg)

        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: userMsg.id,
          sessionID: session.id,
          type: "text",
          text: "Test planning request",
        })

        // Simulate the agent extraction logic from notifyBatchCompletion
        let agent: string | undefined
        for await (const msg of MessageV2.stream(session.id)) {
          if (msg.info.role === "user") {
            agent = msg.info.agent
            break
          }
        }

        expect(agent).toBe("plan")

        await Session.remove(session.id)
      },
    })
  })

  test("agent extraction finds plan agent even with intervening assistant messages", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const defaultModel = await Provider.defaultModel()

        // Create user message with plan agent
        const userMsg: MessageV2.User = {
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "plan",
          model: defaultModel,
        }
        await Session.updateMessage(userMsg)

        // Create assistant message
        const assistantMsg: MessageV2.Assistant = {
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "assistant",
          parentID: userMsg.id,
          time: { created: Date.now() },
          agent: "plan",
          mode: "plan",
          modelID: defaultModel.modelID,
          providerID: defaultModel.providerID,
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "stop",
        }
        await Session.updateMessage(assistantMsg)

        // Simulate the agent extraction logic from notifyBatchCompletion
        let agent: string | undefined
        for await (const msg of MessageV2.stream(session.id)) {
          if (msg.info.role === "user") {
            agent = msg.info.agent
            break
          }
        }

        expect(agent).toBe("plan")

        await Session.remove(session.id)
      },
    })
  })

  test("agent extraction returns undefined when no user messages exist", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        // Simulate the agent extraction logic from notifyBatchCompletion
        let agent: string | undefined
        for await (const msg of MessageV2.stream(session.id)) {
          if (msg.info.role === "user") {
            agent = msg.info.agent
            break
          }
        }

        expect(agent).toBeUndefined()

        await Session.remove(session.id)
      },
    })
  })

  test("SessionPrompt.prompt preserves plan agent when explicitly passed", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const defaultModel = await Provider.defaultModel()

        // Create user message with plan agent
        const userMsg: MessageV2.User = {
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "plan",
          model: defaultModel,
        }
        await Session.updateMessage(userMsg)

        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: userMsg.id,
          sessionID: session.id,
          type: "text",
          text: "Test planning request",
        })

        // Create a synthetic batch-complete message, explicitly passing plan agent
        const batchMsg = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "plan", // Explicitly preserve plan agent
          noReply: true,
          parts: [
            {
              type: "text",
              text: "<batch-complete>test</batch-complete>",
              synthetic: true,
            },
          ],
        })

        // Verify the batch message used plan agent
        expect(batchMsg.info.role).toBe("user")
        expect(batchMsg.info.agent).toBe("plan")

        await Session.remove(session.id)
      },
    })
  })

  test("SessionPrompt.prompt defaults to build agent when no agent specified", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const defaultModel = await Provider.defaultModel()

        // Create user message with plan agent
        const userMsg: MessageV2.User = {
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "plan",
          model: defaultModel,
        }
        await Session.updateMessage(userMsg)

        // Create a synthetic message WITHOUT specifying agent (old buggy behavior)
        const batchMsg = await SessionPrompt.prompt({
          sessionID: session.id,
          // agent not specified - will default to Agent.defaultAgent()
          noReply: true,
          parts: [
            {
              type: "text",
              text: "<batch-complete>test</batch-complete>",
              synthetic: true,
            },
          ],
        })

        // Without agent preservation, this defaults to "build"
        expect(batchMsg.info.role).toBe("user")
        expect(batchMsg.info.agent).toBe("build")

        await Session.remove(session.id)
      },
    })
  })

  test("batch message XML contains task details", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        // Create batch message with multiple tasks
        const batchMsg = await SessionPrompt.prompt({
          sessionID: session.id,
          noReply: true,
          parts: [
            {
              type: "text",
              text: `<batch-complete batch-id="test-batch">
  <task id="task-1" status="completed">
    <description>First task</description>
    <result><![CDATA[Success]]></result>
  </task>
  <task id="task-2" status="failed">
    <description>Second task</description>
    <error><![CDATA[Error message]]></error>
  </task>
</batch-complete>`,
              synthetic: true,
            },
          ],
        })

        const msgs = await Session.messages({ sessionID: session.id })
        const msg = msgs.find((m) => m.info.id === batchMsg.info.id)
        const text = msg?.parts.find((p) => p.type === "text")?.text ?? ""

        expect(text).toContain("task-1")
        expect(text).toContain("task-2")
        expect(text).toContain("completed")
        expect(text).toContain("failed")

        await Session.remove(session.id)
      },
    })
  })
})
