import { createTool } from "@mastra/core";
import z from "zod";
import { cliToolMetrics } from "./cli-tool";

const inputSchema = z.object({
    containerId: z.string().describe("Docker container ID to run analysis in"),
    filePath: z.string().describe("Path to the source code file to analyze"),
    analysisType: z.enum(["structure", "functions", "dependencies", "exports", "full"]).describe("Type of analysis to perform"),
    language: z.string().optional().describe("Programming language (auto-detected if not provided)"),
});

const analysisResultSchema = z.object({
    command: z.string(),
    output: z.string(),
    error: z.string().optional(),
});

const outputSchema = z.object({
    filePath: z.string(),
    analysisType: z.string(),
    language: z.string(),
    fileExists: z.boolean(),
    results: z.array(analysisResultSchema),
    timestamp: z.string(),
});

type CodeAnalysisInput = z.infer<typeof inputSchema>;
type CodeAnalysisOutput = z.infer<typeof outputSchema>;
type AnalysisResult = z.infer<typeof analysisResultSchema>;

export const codeAnalysisTool = createTool({
    id: "code_analysis",
    description: "Perform deep analysis of source code files to extract structure, functions, classes, and testing requirements",
    inputSchema,
    outputSchema,
    execute: async ({ context }): Promise<CodeAnalysisOutput> => {
        const { containerId, filePath, analysisType, language } = context as CodeAnalysisInput;

        // Count every tool invocation
        cliToolMetrics.callCount += 1;

        const { exec } = await import("child_process");

        // Build analysis commands based on type
        const commands: string[] = [];
        
        // Check if file exists first
        commands.push(`docker exec ${containerId} bash -lc "test -f ${filePath} && echo 'FILE_EXISTS' || echo 'FILE_NOT_FOUND'"`);
        
        if (analysisType === "structure" || analysisType === "full") {
            // Get basic file structure and language detection
            commands.push(`docker exec ${containerId} bash -lc "file ${filePath}"`);
            commands.push(`docker exec ${containerId} bash -lc "wc -l ${filePath}"`);
            commands.push(`docker exec ${containerId} bash -lc "head -20 ${filePath}"`);
        }

        if (analysisType === "functions" || analysisType === "full") {
            // Language-specific function extraction
            if (language === "typescript" || language === "javascript" || filePath.endsWith(".ts") || filePath.endsWith(".js")) {
                // Extract functions, classes, exports for TS/JS
                commands.push(`docker exec ${containerId} bash -lc "grep -n 'function\\|class\\|const.*=\\|export' ${filePath} || true"`);
                commands.push(`docker exec ${containerId} bash -lc "grep -n 'async\\|await\\|Promise' ${filePath} || true"`);
            } else if (language === "python" || filePath.endsWith(".py")) {
                // Extract functions, classes for Python
                commands.push(`docker exec ${containerId} bash -lc "grep -n 'def\\|class\\|@' ${filePath} || true"`);
            } else {
                // Generic pattern matching
                commands.push(`docker exec ${containerId} bash -lc "grep -n 'function\\|class\\|def\\|fn\\|func' ${filePath} || true"`);
            }
        }

        if (analysisType === "dependencies" || analysisType === "full") {
            // Extract imports and dependencies
            commands.push(`docker exec ${containerId} bash -lc "grep -n 'import\\|require\\|from.*import' ${filePath} || true"`);
        }

        if (analysisType === "exports" || analysisType === "full") {
            // Extract exports
            commands.push(`docker exec ${containerId} bash -lc "grep -n 'export\\|module.exports' ${filePath} || true"`);
        }

        // Execute all commands and collect results
        const results: AnalysisResult[] = [];
        let fileExists = false;

        for (let i = 0; i < commands.length; i++) {
            const cmd = commands[i];
            try {
                const result = await new Promise<string>((resolve, reject) => {
                    exec(cmd, (error, stdout, stderr) => {
                        if (error) {
                            // Don't reject for grep not finding patterns
                            if (cmd.includes('grep') && (error as NodeJS.ErrnoException).code === '1') {
                                resolve("");
                            } else {
                                reject(new Error(stderr || error.message));
                            }
                        } else {
                            resolve(stdout);
                        }
                    });
                });
                
                // First command checks file existence
                if (i === 0) {
                    fileExists = result.trim() === "FILE_EXISTS";
                } else {
                    results.push({ command: cmd, output: result.trim() });
                }
            } catch (error) {
                if (i > 0) {
                    results.push({ 
                        command: cmd, 
                        output: "", 
                        error: error instanceof Error ? error.message : 'Unknown error' 
                    });
                }
            }
        }

        // Structure the results
        return {
            filePath,
            analysisType,
            language: language || "auto-detected",
            fileExists,
            results,
            timestamp: new Date().toISOString(),
        };
    },
});
