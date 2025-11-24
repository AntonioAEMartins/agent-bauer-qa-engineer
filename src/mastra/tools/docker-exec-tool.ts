import { createTool } from "@mastra/core";
import z from "zod";
import { cliToolMetrics } from "./cli-tool";

const inputSchema = z.object({
    containerId: z.string().describe("Docker container ID or name"),
    cmd: z.string().describe("The shell command to run inside the container (raw, unwrapped)"),
});

const outputSchema = z.string().describe("The stdout output from the docker exec command");

export const dockerExecTool = createTool({
    id: "docker_exec",
    description: "Run a shell command inside a docker container. Pass RAW commands only (no 'bash -lc' wrapper).",
    inputSchema,
    outputSchema,
    execute: async ({ context }) => {
        const { containerId, cmd } = context as z.infer<typeof inputSchema>;

        // Count every tool invocation
        cliToolMetrics.callCount += 1;

        const { exec } = await import("child_process");
        // Normalize: strip accidental nested wrappers and surrounding quotes
        let normalized = cmd.trim();
        if (normalized.startsWith("bash -lc ")) {
            normalized = normalized.slice("bash -lc ".length).trim();
        }
        if ((normalized.startsWith("'") && normalized.endsWith("'")) || (normalized.startsWith('"') && normalized.endsWith('"'))) {
            normalized = normalized.slice(1, -1);
        }

        const wrapped = JSON.stringify(normalized);
        const full = `docker exec ${containerId} bash -lc ${wrapped}`;
        return await new Promise<string>((resolve, reject) => {
            exec(full, { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(stderr || error.message));
                } else {
                    resolve(stdout);
                }
            });
        });
    },
});
