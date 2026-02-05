import z from "zod"
import { Tool } from "./tool.js"
import { TaskManager } from "../task/manager.js"
import { taskReadAfterNotification, standardWarning } from "../task/anti-polling.js"
import { Permission } from "../permission"

export const DelegationReadTool = Tool.define("delegation_read", {
  description: `Read the output of a delegation by its ID. Use this to retrieve results from delegated tasks if the inline notification was lost during compaction. ${taskReadAfterNotification()} ${standardWarning()}`,
  parameters: z.object({
    id: z.string().describe("The task ID to read (e.g., 'swift-amber-falcon')"),
  }),
  async execute(params, ctx) {
    const task = await TaskManager.get(ctx.sessionID, params.id)

    if (!task) {
      return {
        title: `Task not found: ${params.id}`,
        metadata: {},
        output: `No task found with ID "${params.id}" in current session.`,
      }
    }

    // Hard block: prevent polling on running tasks
    const status = task.status
    if (status === "queued" || status === "running") {
      throw new Permission.RejectedError(
        ctx.sessionID,
        "polling_forbidden",
        ctx.callID,
        {
          task_id: params.id,
          task_status: task.status,
        },
        "🚫 POLLING IS FORBIDDEN. TASK IS STILL RUNNING. WAIT FOR <BATCH-COMPLETE>.",
      )
    }

    // Format output based on status
    let output: string
    switch (status) {
      case "completed":
        output = `Status: Completed\nDescription: ${task.description}\nAgent: ${task.agent}\nResult:\n${task.result}`
        break
      case "failed":
        output = `Status: Failed\nDescription: ${task.description}\nAgent: ${task.agent}\nError: ${task.error}`
        break
    }

    return {
      title: `Task ${params.id}: ${status}`,
      metadata: {},
      output,
    }
  },
})
