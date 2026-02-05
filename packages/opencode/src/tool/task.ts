import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Agent } from "../agent/agent"
import { TaskManager } from "../task/manager.js"
import { standardWarning } from "../task/anti-polling.js"
import { PermissionNext } from "@/permission/next"

const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),
})

export const TaskTool = Tool.define("task", async (ctx) => {
  const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary"))

  // Filter agents by permissions if agent provided
  const caller = ctx?.agent
  const accessibleAgents = caller
    ? agents.filter((a) => PermissionNext.evaluate("task", a.name, caller.permission).action !== "deny")
    : agents

  const description = DESCRIPTION.replace(
    "{agents}",
    accessibleAgents
      .map((a) => `- ${a.name}: ${a.description ?? "This subagent should only be called manually by the user."}`)
      .join("\n"),
  )
  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      // Skip permission check when user explicitly invoked via @ or command subtask
      if (!ctx.extra?.bypassAgentCheck) {
        await ctx.ask({
          permission: "task",
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const agent = await Agent.get(params.subagent_type)
      if (!agent) throw new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`)

      // Start the task using TaskManager (async, fire-and-forget)
      const id = await TaskManager.start({
        sessionID: ctx.sessionID,
        parentMessageID: ctx.messageID,
        parentPartID: ctx.callID!,
        parentCallID: ctx.callID!,
        description: params.description,
        agent: params.subagent_type,
        prompt: params.prompt,
        batchId: ctx.messageID,
      })

      const output = [
        `Task started: ${id}`,
        `Agent: ${params.subagent_type}`,
        `Description: ${params.description}`,
        "",
        standardWarning(),
        "",
        "Continue productive work. You will be notified when complete.",
      ].join("\n")

      return {
        title: `Task: ${id}`,
        metadata: {
          taskId: id,
          sessionId: id, // For TUI compatibility
          agent: params.subagent_type,
        },
        output,
      }
    },
  }
})
