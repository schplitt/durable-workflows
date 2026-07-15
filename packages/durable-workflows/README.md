# durable-workflows

Durable workflows for JavaScript, inspired by [Cloudflare Workflows](https://developers.cloudflare.com/workflows/).

Write a workflow as a plain async function. Each step's result is saved, so a workflow can pause for days, survive restarts and deploys, and continue right where it left off. No state machines, no manual bookkeeping.

> Status: work in progress. The authoring surface and runner are here; the full engine (persistence, scheduling) lands next.

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

## License

MIT
