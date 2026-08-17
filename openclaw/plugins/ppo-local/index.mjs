import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { runPpoLocalTool } from "./bridge.mjs";

export default defineToolPlugin({
  id: "ppo-local",
  name: "PPO Local",
  description: "Registers the deterministic Personal Project Operator local wrapper tool.",
  tools: (tool) => [
    tool({
      name: "ppo_local",
      description: "Run one approved Personal Project Operator Phase 2C command through the local read-only wrapper.",
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
