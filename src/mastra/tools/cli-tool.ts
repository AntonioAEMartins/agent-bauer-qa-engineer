import { createTool } from "@mastra/core";
import z from "zod";

export const cliToolMetrics = {
    callCount: 0,
};

const inputSchema = z.object({
    cmd: z.string().describe("The shell command to run"),
});

const outputSchema = z.string().describe("The stdout output from the command");

export const cliTool = createTool({
    id: "exec_command",
    description: "Run a shell command locally",
    inputSchema,
    outputSchema,
    execute: async ({ context }) => {
        const { cmd } = context as z.infer<typeof inputSchema>;

        // Count every tool invocation
        cliToolMetrics.callCount += 1;

        const { exec } = await import("child_process");
        return await new Promise<string>((resolve, reject) => {
            exec(cmd, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(stderr || error.message));
                } else {
                    resolve(stdout);
                }
            });
        });
    },
});
