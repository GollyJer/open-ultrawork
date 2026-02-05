import z from "zod"
import { Tool } from "./tool.js"
import { TaskManager } from "../task/manager.js"
import { Agent } from "../agent/agent.js"
import { standardWarning } from "../task/anti-polling.js"
import { PermissionNext } from "@/permission/next.js"

const parameters = z.object({
  prompt: z.string().describe("The task for the agent to perform"),
  agent: z.string().describe("The type of specialized agent to use for this task"),
})

export const DelegateTool = Tool.define("delegate", async (ctx) => {
  const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary"))

  // Filter agents by permissions if agent provided
  const caller = ctx?.agent
  const accessibleAgents = caller
    ? agents.filter((a) => PermissionNext.evaluate("task", a.name, caller.permission).action !== "deny")
    : agents

  const description = `Delegate a task to an agent. Returns immediately with a readable ID.

Use this for:
- Research tasks (will be auto-saved)
- Parallel work that can run in background
- Any task where you want persistent, retrievable output

On completion, a notification will arrive with the ID, title, description, and result.
Use \`delegation_read\` with the ID to retrieve the result again if it is lost during compaction.

Available agents:
${accessibleAgents
  .map((a) => `- ${a.name}: ${a.description ?? "This agent should only be called manually by the user."}`)
  .join("\n")}

${standardWarning()}`

  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      // Skip permission check when user explicitly invoked via @ or command subtask
      if (!ctx.extra?.bypassAgentCheck) {
        await ctx.ask({
          permission: "task",
          patterns: [params.agent],
          always: ["*"],
          metadata: {
            agent: params.agent,
          },
        })
      }

      const agent = await Agent.get(params.agent)
      if (!agent) throw new Error(`Unknown agent type: ${params.agent} is not a valid agent type`)

      // Generate a brief description from the prompt (first line or first 50 chars)
      const description = params.prompt.split("\n")[0].slice(0, 50)

      // Start the task using TaskManager with batchId = messageID
      const id = await TaskManager.start({
        sessionID: ctx.sessionID,
        parentMessageID: ctx.messageID,
        parentPartID: ctx.callID!,
        parentCallID: ctx.callID!,
        description,
        agent: params.agent,
        prompt: params.prompt,
        batchId: ctx.messageID,
      })

      const output = [
        `Task delegated: ${id}`,
        `Agent: ${params.agent}`,
        `Description: ${description}`,
        "",
        `${standardWarning()}`,
        "",
        "Continue productive work. You will be notified when complete.",
      ].join("\n")

      return {
        title: `Delegated: ${id}`,
        metadata: {
          taskId: id,
          agent: params.agent,
        },
        output,
      }
    },
  }
})
