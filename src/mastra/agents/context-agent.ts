import { Agent } from "@mastra/core";
import { cliTool } from "../tools/cli-tool";
import { dockerExecTool } from "../tools/docker-exec-tool";
import { openai } from "@ai-sdk/openai";
import { groq } from "@ai-sdk/groq";

export const contextAgent = new Agent({
    id: "contextAgent",
    name: "Context Agent",
    instructions:
        "You specialize in analyzing source code repositories and synthesizing structured RepoContext. Always be cautious and non-destructive. Prefer reasoning over assumptions, cite uncertainties with low confidence. When asked to return JSON, output strictly JSON with no extra commentary.",
    model: openai("gpt-5.1", {
        parallelToolCalls: true,
        reasoningEffort: "high",
    }),
    // model: groq('openai/gpt-oss-120b'),
    tools: {
        exec_command: cliTool,
        docker_exec: dockerExecTool,
    },
});