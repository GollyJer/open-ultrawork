import { Task } from "./types"
import { Store } from "./store.js"
import { notifyCompletion, notifyBatchCompletion } from "./notification.js"
import { TaskManager } from "./manager.js"
import { Log } from "../util/log"

const log = Log.create({ service: "task.orphan" })

/**
 * Initialize orphan cleanup on server startup.
 * Finds all tasks that were queued or running when the server crashed/restarted
 * and marks them as failed with a descriptive error.
 */
export async function initOrphanCleanup(): Promise<void> {
  log.info("Starting orphan cleanup")

  const all = await Store.listAll()

  // Group tasks by batchId (null for non-batched)
  const batches = new Map<string | null, Task.Info[]>()
  for (const task of all) {
    const key = task.batchId ?? null
    if (!batches.has(key)) {
      batches.set(key, [])
    }
    batches.get(key)!.push(task)
  }

  // Process non-batched orphans first
  const nonBatched = batches.get(null) ?? []
  for (const task of nonBatched) {
    if (task.status !== "queued" && task.status !== "running") continue

    log.info("Cleaning orphaned task (non-batched)", {
      taskId: task.id,
      status: task.status,
    })

    const failed: Task.TaskFailed = {
      ...task,
      status: "failed",
      startedAt: task.status === "running" ? task.startedAt : Date.now(),
      failedAt: Date.now(),
      error: "Task interrupted by server restart",
    }

    await Store.update(failed)

    try {
      await notifyCompletion(failed)
    } catch (error) {
      log.warn("Failed to notify orphaned task", {
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  batches.delete(null)

  // Process each batch
  for (const [batchId, tasks] of batches) {
    if (!batchId) continue

    log.info("Reconstructing batch", { batchId, taskCount: tasks.length })

    // Step 1: Register ALL tasks in the batch first
    for (const task of tasks) {
      TaskManager.registerBatch(batchId, task.parentSessionID, task.id, task.description)
    }

    // Step 2: Mark each task's final state
    for (const task of tasks) {
      if (task.status === "queued" || task.status === "running") {
        // Orphaned task - mark as failed
        log.info("Cleaning orphaned task (batched)", {
          taskId: task.id,
          batchId,
          status: task.status,
        })

        const failed: Task.TaskFailed = {
          ...task,
          status: "failed",
          startedAt: task.status === "running" ? task.startedAt : Date.now(),
          failedAt: Date.now(),
          error: "Task interrupted by server restart",
        }

        await Store.update(failed)
        TaskManager.markTaskFailed(batchId, task.id, "Task interrupted by server restart")
      } else if (task.status === "completed") {
        TaskManager.markTaskComplete(batchId, task.id, task.result ?? "")
      } else if (task.status === "failed") {
        TaskManager.markTaskFailed(batchId, task.id, task.error ?? "Unknown error")
      }
    }

    // Step 3: Send ONE batch notification if complete
    if (TaskManager.isBatchComplete(batchId) && !TaskManager.isBatchNotified(batchId)) {
      TaskManager.markBatchNotified(batchId)

      const batchResults = TaskManager.getBatchResults(batchId)
      if (batchResults) {
        try {
          await notifyBatchCompletion({
            batchId: batchResults.batchId,
            parentSessionID: batchResults.parentSessionID,
            results: batchResults.results,
          })
        } catch (error) {
          log.warn("Failed to send batch completion notification", {
            batchId,
            error,
          })
        }
        TaskManager.cleanupBatch(batchId)
      }
    }
  }

  log.info("Orphan cleanup complete")
}
