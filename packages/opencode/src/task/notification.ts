import { SessionPrompt } from "../session/prompt.js"
import { Task } from "./types.js"
import { escape, cdata } from "../util/xml"
import { Log } from "../util/log"
import { TaskManager } from "./manager.js"
import { reminderRemaining, reminderFinal } from "./anti-polling.js"
import { MessageV2 } from "../session/message-v2.js"

const log = Log.create({ service: "task.notification" })

export async function notifyCompletion(task: Task.TaskCompleted | Task.TaskFailed): Promise<void> {
  const status = task.status
  const id = task.id
  const description = escape(task.description)

  // Check if there are remaining tasks in the session
  let antiPollingNote = ""
  try {
    const allTasks = await TaskManager.list(task.parentSessionID)
    const remainingCount = allTasks.filter((d) => d.status === "queued" || d.status === "running").length

    if (remainingCount > 0) {
      antiPollingNote = `\n\n${reminderRemaining(remainingCount)}`
    } else {
      antiPollingNote = `\n\n${reminderFinal()}`
    }
  } catch (error) {
    // Fallback if we can't get task list
    antiPollingNote = `\n\n${reminderFinal()}`
  }

  let message: string
  if (task.status === "completed") {
    message = `<task-notification>
<task-id>${escape(id)}</task-id>
<status>complete</status>
<summary>Task "${description}" completed successfully</summary>
<result>${cdata(truncateResult(task.result))}</result>
</task-notification>${antiPollingNote}`
  } else {
    message = `<task-notification>
<task-id>${escape(id)}</task-id>
<status>failed</status>
<summary>Task "${description}" failed</summary>
<error>${cdata(task.error)}</error>
</task-notification>${antiPollingNote}`
  }

  // Inject the notification into the parent session WITHOUT triggering a model response
  try {
    await SessionPrompt.prompt({
      sessionID: task.parentSessionID,
      noReply: true, // Critical: don't trigger model response
      parts: [{ type: "text", text: message }],
    })
  } catch (error) {
    // Catch and log notification failures; do not fail task because notification failed
    log.error("Failed to send notification", {
      taskId: task.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

const MAX_RESULT_LENGTH = 10 * 1024 // 10KB

function truncateResult(text: string): string {
  if (text.length <= MAX_RESULT_LENGTH) return text
  return text.slice(0, MAX_RESULT_LENGTH) + "\n\n[truncated - use task_read(id) for full content]"
}

export interface BatchResult {
  id: string
  status: "pending" | "completed" | "failed"
  description: string
  result?: string
  error?: string
}

export type TerminalBatchResult = BatchResult & { status: "completed" | "failed" }

export interface BatchCompletionInput {
  batchId: string
  parentSessionID: string
  results: TerminalBatchResult[]
  /** @internal For testing only - prevents triggering agent loop */
  noReply?: boolean
}

export async function notifyBatchCompletion(input: BatchCompletionInput): Promise<void> {
  const { batchId, parentSessionID, results, noReply } = input

  // Build XML for each task
  const tasksXml = results
    .map((task) => {
      if (task.status === "completed") {
        return `  <task id="${escape(task.id)}" status="completed">
    <description>${escape(task.description)}</description>
    <result>${cdata(truncateResult(task.result ?? ""))}</result>
  </task>`
      } else {
        return `  <task id="${escape(task.id)}" status="failed">
    <description>${escape(task.description)}</description>
    <error>${cdata(task.error ?? "Unknown error")}</error>
  </task>`
      }
    })
    .join("\n")

  const message = `<batch-complete batch-id="${escape(batchId)}">
${tasksXml}
</batch-complete>`

  // Preserve agent context from latest user message to avoid false plan->build transitions
  let agent: string | undefined
  for await (const msg of MessageV2.stream(parentSessionID)) {
    if (msg.info.role === "user") {
      agent = msg.info.agent
      break
    }
  }

  // Inject with synthetic: true (hidden from user) and noReply: false (wake agent)
  try {
    await SessionPrompt.prompt({
      sessionID: parentSessionID,
      agent, // Preserve agent context to avoid false plan->build switching
      noReply: noReply ?? false, // Wake the agent! (unless testing)
      parts: [
        {
          type: "text",
          text: message,
          synthetic: true, // Hidden from user, visible to agent
        },
      ],
    })
  } catch (error) {
    log.error("Failed to send batch completion notification", {
      batchId,
      parentSessionID,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
