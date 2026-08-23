import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { runPpoLocalTool } from "./bridge.mjs";

export default defineToolPlugin({
  id: "ppo-local",
  name: "PPO Local",
  description: "Registers the deterministic Personal Project Operator local wrapper tool.",
  tools: (tool) => [
    tool({
      name: "ppo_local",
      description: "Run one approved Personal Project Operator /ppo command through the local deterministic wrapper, including GitHub read-only, deterministic text routes, Phase 5B approval-gated issue creation, Phase 5D approval-gated project note creation, Phase 6O read-only development run catalog summaries, Phase 6K one-boundary ordinary development continue, and Phase 6M read-only development recovery.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          command: {
            type: "string",
            description: "Raw /ppo argument string forwarded by OpenClaw command dispatch."
          },
          commandName: {
            type: "string",
            description: "OpenClaw slash command name."
          },
          skillName: {
            type: "string",
            description: "OpenClaw skill name."
          }
        },
        required: ["command"]
      },
      async execute(params) {
        const result = await runPpoLocalTool(params);
        return result.stdout;
      }
    })
  ]
});
