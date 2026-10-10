#!/usr/bin/env node
import { run } from './app.js';
import { ReviewMergeGate } from './gate.js';
// Fail closed until trusted GitHub/Git evidence adapters are implemented.
const gate = new ReviewMergeGate({ read: async () => undefined });
process.exitCode = await run(process.argv.slice(2), gate, {
  out: (message) => console.log(message), error: (message) => console.error(message),
});
