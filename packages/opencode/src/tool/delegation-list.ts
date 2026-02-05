import { z } from "zod"
import { Tool } from "./tool.js"
import { TaskManager } from "../task/manager.js"
import { taskOutputReminder, taskReadAfterNotification } from "../task/anti-polling.js"
import { Permission } from "../permission"

export const DelegationListTool = Tool.define("delegation_list", {
  description: `List all delegations for the current session. Shows both running and completed delegations. ${taskOutputReminder()} ${taskReadAfterNotification()}`,
  parameters: z.object({
    reason: z.string().describe("Brief explanation of why you are calling this tool"),
  }),
  async execute(params, ctx) {
    const tasks = await TaskManager.list(ctx.sessionID)

    if (tasks.length === 0) {
      return {
        title: "No delegations found",
        metadata: {},
        output: `No delegations found in this session.\n\n${taskOutputReminder()} ${taskReadAfterNotification()}`,
      }
    }

    // Hard block: prevent polling while tasks are running
    const hasRunning = tasks.some((d) => d.status === "queued" || d.status === "running")
    if (hasRunning) {
      throw new Permission.RejectedError(
        ctx.sessionID,
        "polling_forbidden",
        ctx.callID,
        {
          running_count: tasks.filter((d) => d.status === "queued" || d.status === "running").length,
        },
        "🚫 POLLING IS FORBIDDEN. TASKS ARE STILL RUNNING. WAIT FOR <BATCH-COMPLETE>.",
      )
    }

    // Format the list
    const lines = tasks.map((d) => {
      const statusIcon = {
        queued: "⏳",
        running: "⏳",
        completed: "✅",
        failed: "❌",
      }[d.status]
      return `${statusIcon} ${d.id} - ${d.description} (${d.status})`
    })

    return {
      title: `${tasks.length} delegation(s) found`,
      metadata: {},
      output: lines.join("\n") + `\n\n${taskOutputReminder()} ${taskReadAfterNotification()}`,
    }
  },
})
