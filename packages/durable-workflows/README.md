# durable-workflows

Durable workflows for JavaScript, inspired by [Cloudflare Workflows](https://developers.cloudflare.com/workflows/).

Write a workflow as a plain async function. Each step's result is saved, so a workflow can pause for days, survive restarts and deploys, and continue right where it left off. No state machines, no manual bookkeeping.

> Status: work in progress. The authoring surface, the execution host and the engine (instance lifecycle over a pluggable store) are here; first-party capability plugins land next.

## Features

- **Steps that run once.** Wrap work in `step.do(id, fn)`. If the workflow runs again the saved value comes straight back and the body never re-runs, so side effects stay safe.
- **Nesting, sequential or parallel.** Call `step.do` inside `step.do`. Parallel branches under `Promise.all` each keep their own identity.
- **Pause and continue.** A step can wait on a timer, an approval, or a long job. While it waits nothing runs and no connection is held open.
- **Capabilities as imports.** A workflow imports only what it is allowed to touch (`my:sleep`, `my:approvals`, your own client). Anything else is simply not in scope.
- **Bring your own store.** Persistence is a small interface you implement against your database.
- **Whitelabel the imports.** Rename the built-in modules to your own namespace so every import reads as yours.

## Example

```ts
import { defineWorkflow, step } from 'durable-workflows:workflow'
import { inventory } from 'my:client'
import { awaitApproval } from 'my:approvals'

export default defineWorkflow({
  async run({ input }) {
    const device = await step.do('load-device', () => inventory.get(input.deviceId))

    const approval = await awaitApproval({ subject: device.name, timeout: '2 days' })
    if (!approval.approved)
      return { status: 'rejected' }

    await step.do('apply-fix', () => inventory.patch(device.id, input.fix))
    return { status: 'done' }
  },
})
```

Run one loads the device, asks for approval, and pauses. Days later the approval arrives, the workflow replays through the saved step in milliseconds, applies the fix, and finishes. A deploy in between changes nothing.

## Running workflows: the engine

`durableWorkflows` runs instances of deployed workflow code over a store you provide:

```ts
import { durableWorkflows, memoryStore } from 'durable-workflows'

const store = memoryStore() // or your own WorkflowStore adapter
store.deploy('device-fix', 'v1', workflowCode) // in production your own deploy layer writes these rows

const engine = durableWorkflows({
  store,
  plugins: {
    'my:approvals': approvalsPlugin(myBackend), // keys are the import specifiers workflows use
  },
})

// your triggers start instances — resolves the active version, pins it, runs the first turn
app.post('/devices/:id/fix', async (req) => {
  const outcome = await engine.create('device-fix', { deviceId: req.params.id })
  // outcome.status: 'completed' | 'waiting' | 'failed'
})

// and your own wiring (webhook, cron, queue) resumes waiting instances:
app.post('/approvals/:instanceId/decide', async (req) => {
  await engine.continueWorkflow(req.params.instanceId)
})
```

How the pieces divide:

- **The store** (`WorkflowStore`) is one persistent world: instance records, each instance's saved step history, and read access to deployed workflow code (`getDefinition`). Implement it once against your database.
- **Definitions are read-only to the engine.** Uploading, versioning and rollback belong to your app — you write code rows into the same backend the store reads. Instances pin the version they started on and always replay exactly that code, so rollbacks never disturb running instances. The one rule: never mutate or delete a version that instances still reference.
- **Resuming is re-running.** `continueWorkflow(id)` replays the workflow over its saved history; a step that was waiting asks its plugin handler again, and the handler checks your systems (the approval row, the clock, the job status) to answer, keep waiting, or fail. There are no callbacks to register and nothing to inject.
- **Scheduling is yours.** The engine never wakes anything up — your cron/webhooks/queues decide when to call `continueWorkflow`.
- **Remediation:** `evict(id, stepId)` deletes a step (and everything after it) from history and replays; `restart(id)` replays from scratch; `terminate(id)` ends an instance.

## License

MIT
