import { createTool } from "@mastra/core";
import z from "zod";
import { cliToolMetrics } from "./cli-tool";
import { exec } from "child_process";

function sh(cmd: string): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        exec(cmd, { maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
            if (error) {
                resolve({ stdout: stdout + (stderr || ''), stderr: stderr || error.message });
            } else {
                resolve({ stdout, stderr });
            }
        });
    });
}

function shellEscape(str: string): string {
    return "'" + String(str).replace(/'/g, "'\"'\"'") + "'";
}

const inputSchema = z.object({
    containerId: z.string().describe("Docker container ID"),
    repoPath: z.string().describe("Path to the repository inside the container"),
    install: z.string().nullable().optional().describe("Installation command to run first"),
    run: z.string().describe("Coverage run command"),
});

const outputSchema = z.object({
    stdout: z.string(),
    stderr: z.string(),
});

type CoverageRunnerInput = z.infer<typeof inputSchema>;
type CoverageRunnerOutput = z.infer<typeof outputSchema>;

export const coverageRunnerTool = createTool({
    id: "coverage_runner",
    description: "Run installation and coverage command inside Docker container and return stdout/stderr",
    inputSchema,
    outputSchema,
    execute: async ({ context }): Promise<CoverageRunnerOutput> => {
        const { containerId, repoPath, install, run } = context as CoverageRunnerInput;
        
        cliToolMetrics.callCount += 1;

        if (install && typeof install === 'string' && install.trim()) {
            await sh(`docker exec ${containerId} bash -lc "cd ${shellEscape(repoPath)} && ${install}"`).catch(() => {});
        }

        const { stdout, stderr } = await sh(`docker exec ${containerId} bash -lc "cd ${shellEscape(repoPath)} && ${run} 2>&1 || true"`);
        return { stdout, stderr };
    },
});
