import { createStep, createWorkflow } from "@mastra/core";
import z from "zod";
import { notifyStepStatus } from "../../tools/alert-notifier";
import { cliToolMetrics } from "../../tools/cli-tool";
import { mastra } from "../..";
import { 
    getErrorMessage,
    extractJsonFromText,
    CoverageStatsSchema,
} from "../../types";

const ALERTS_ONLY = (process.env.ALERTS_ONLY === 'true') || (process.env.LOG_MODE === 'alerts_only') || (process.env.MASTRA_LOG_MODE === 'alerts_only');

// Logger interface for type safety
interface Logger {
    info?: (message: string, meta?: Record<string, unknown>) => void;
    debug?: (message: string, meta?: Record<string, unknown>) => void;
    warn?: (message: string, meta?: Record<string, unknown>) => void;
    error?: (message: string, meta?: Record<string, unknown>) => void;
}

// =============================================================================
// SCHEMAS
// =============================================================================

const CoverageInputSchema = z.object({
    containerId: z.string(),
    projectId: z.string(),
    repoPath: z.string().optional(),
    prUrl: z.string().optional(),
    contextPath: z.string().optional(),
    result: z.string().optional(),
    success: z.boolean().optional(),
    toolCallCount: z.number().optional(),
});

const CoverageOutputSchema = z.object({
    containerId: z.string(),
    projectId: z.string(),
    coverage: z.number(), // 0..1
    repoPath: z.string(),
    language: z.string(),
    framework: z.string(),
    method: z.string(), // 'json' | 'xml' | 'stdout' | 'algorithmic'
    stats: CoverageStatsSchema,
    files: z.number(),
    prUrl: z.string().optional(),
    contextPath: z.string().optional(),
    result: z.string().optional(),
    success: z.boolean(),
    toolCallCount: z.number().optional(),
});

type CoverageInput = z.infer<typeof CoverageInputSchema>;
type CoverageOutput = z.infer<typeof CoverageOutputSchema>;

// Agent coverage response schema
const CoverageAgentResponseSchema = z.object({
    isValid: z.boolean(),
    repoPath: z.string(),
    language: z.string().default("TypeScript"),
    framework: z.string().default("Vitest"),
    coverage: z.number(),
    method: z.string(),
    stats: CoverageStatsSchema.optional(),
    files: z.number(),
    reason: z.string().optional(),
});

type CoverageAgentResponse = z.infer<typeof CoverageAgentResponseSchema>;

// =============================================================================
// STEP 1: Run TypeScript + Vitest Coverage
// =============================================================================

export const runCoverageStep = createStep({
    id: "runCoverageStep",
    inputSchema: CoverageInputSchema,
    outputSchema: CoverageOutputSchema,
    execute: async ({ inputData, runId }): Promise<CoverageOutput> => {
        await notifyStepStatus({
            stepId: "runCoverageStep",
            status: "starting",
            runId,
            containerId: inputData.containerId,
            title: "Run TypeScript + Vitest coverage",
            subtitle: "Using intelligent agent to validate and calculate coverage",
        });

        const logger = ALERTS_ONLY ? null : mastra.getLogger() as Logger | undefined;
        const agent = mastra.getAgent("testCoverageAgent");
        if (!agent) throw new Error("testCoverageAgent not registered");

        const prompt = `CRITICAL: Analyze this TypeScript + Vitest project for coverage.

Container ID: ${inputData.containerId}
Repo Path Hint: ${inputData.repoPath || 'Not provided - please discover'}

CRITICAL: Node.js may NOT be available in the container. Handle gracefully!

YOUR MISSION:
1. DISCOVER REPOSITORY PATH DYNAMICALLY (works for ANY repository):
   - Search broadly: docker exec ${inputData.containerId} find /app -name "package.json" -type f -not -path "*/node_modules/*" 2>/dev/null | head -1
   - Extract directory: dirname of the found package.json path  
   - If /app search fails, try common container paths: /workspace/, /code/, /src/, /project/, /home/, /usr/src/
   - Verify both package.json AND tsconfig.json exist at discovered path
   - NEVER hardcode repository names - use dynamic discovery

2. Check Node.js availability FIRST:
   - Run: docker exec ${inputData.containerId} which node
   - If "command not found" → Use ALGORITHMIC approach
   - If found → Use standard Vitest approach

3. IF NODE.JS MISSING (likely scenario):
   - Read package.json: docker exec ${inputData.containerId} cat DISCOVERED_REPO_PATH/package.json
   - Manually parse JSON to check for "typescript" and "vitest" in dependencies/devDependencies
   - Count ALL TypeScript files: docker exec ${inputData.containerId} find DISCOVERED_REPO_PATH -name "*.ts" -o -name "*.tsx" -not -path "*/node_modules/*" -not -path "*/dist/*" -not -path "*/build/*" | wc -l
   - Count test files ANYWHERE: docker exec ${inputData.containerId} find DISCOVERED_REPO_PATH \\( -name "*.test.ts" -o -name "*.spec.ts" -o -name "*.test.tsx" -o -name "*.spec.tsx" \\) -not -path "*/node_modules/*" | wc -l
   - Calculate: source_files = total_files - test_files, coverage = min(1.0, test_count / max(source_count, 1) * 2.5)
   - IMPORTANT: Tests may be co-located with source files, not in separate test/ folder

4. IF NODE.JS AVAILABLE:
   - Install: docker exec ${inputData.containerId} bash -c "cd DISCOVERED_REPO_PATH && npm ci --no-audit --no-fund"
   - Run: docker exec ${inputData.containerId} bash -c "cd DISCOVERED_REPO_PATH && npx vitest run --coverage"

5. Return ONLY JSON - no explanatory text or markdown!

REQUIRED JSON OUTPUT:
{
  "isValid": boolean,
  "repoPath": string, 
  "language": "TypeScript",
  "framework": "Vitest",
  "coverage": number,
  "method": string,
  "stats": {
    "statements": {"total": number, "covered": number, "pct": number},
    "branches": {"total": number, "covered": number, "pct": number},
    "functions": {"total": number, "covered": number, "pct": number}, 
    "lines": {"total": number, "covered": number, "pct": number}
  },
  "files": number,
  "reason": string
}

BE SPECIFIC: Include exact commands you tried and their outputs in the reason field if anything fails.

CRITICAL: This solution must work for ANY TypeScript + Vitest repository in any container setup - never hardcode paths or repository names!`;

        const result = await agent.generate(prompt, { maxSteps: 100, maxRetries: 2 });
        const resultObj = result as { text?: string };
        const text = String(resultObj?.text || "{}");
        
        // Extract JSON from response
        const jsonText = extractJsonFromText(text);
        
        let parsed: CoverageAgentResponse;
        try {
            const rawParsed = JSON.parse(jsonText);
            // Validate with Zod schema
            parsed = CoverageAgentResponseSchema.parse(rawParsed);
        } catch (error) {
            logger?.error?.("Failed to parse agent response", { 
                originalText: text, 
                extractedJson: jsonText, 
                error: getErrorMessage(error),
            });
            
            // If JSON parsing fails, try to create a fallback response
            console.log("JSON parsing failed, attempting fallback parsing...");
            console.log("Original text length:", text.length);
            console.log("Extracted JSON:", jsonText);
            
            throw new Error(`Agent returned invalid JSON response. Extracted: "${jsonText.substring(0, 200)}..."`);
        }

        if (!parsed.isValid) {
            await notifyStepStatus({
                stepId: "runCoverageStep",
                status: "completed",
                runId,
                containerId: inputData.containerId,
                title: "Project validation failed",
                subtitle: parsed.reason || "Unknown validation error",
                toolCallCount: cliToolMetrics.callCount,
            });

            throw new Error(`Invalid project for TypeScript + Vitest coverage: ${parsed.reason}`);
        }

        const coverage = Math.max(0, Math.min(1, Number(parsed.coverage) || 0));
        
        logger?.info?.("TypeScript + Vitest coverage analysis completed", { 
            coverage, 
            method: parsed.method, 
            files: parsed.files,
            repoPath: parsed.repoPath 
        });

        await notifyStepStatus({
            stepId: "runCoverageStep",
            status: "completed",
            runId,
            containerId: inputData.containerId,
            title: "TypeScript + Vitest coverage calculated",
            subtitle: `${(coverage * 100).toFixed(2)}% via ${parsed.method} (${parsed.files} files)`,
            toolCallCount: cliToolMetrics.callCount,
        });

        return {
            containerId: inputData.containerId,
            projectId: inputData.projectId,
            coverage,
            repoPath: parsed.repoPath,
            language: "TypeScript",
            framework: "Vitest",
            method: parsed.method,
            stats: parsed.stats || {
                statements: { total: 0, covered: 0, pct: coverage * 100 },
                branches: { total: 0, covered: 0, pct: 0 },
                functions: { total: 0, covered: 0, pct: 0 },
                lines: { total: 0, covered: 0, pct: coverage * 100 },
            },
            files: parsed.files || 0,
            prUrl: inputData.prUrl,
            contextPath: inputData.contextPath,
            result: inputData.result,
            success: true,
            toolCallCount: inputData.toolCallCount,
        };
    },
});

// =============================================================================
// STEP 2: Post Test Coverage to Backend
// =============================================================================

export const postCoverageStep = createStep({
    id: "postCoverageStep",
    inputSchema: CoverageOutputSchema,
    outputSchema: CoverageOutputSchema,
    execute: async ({ inputData, runId }): Promise<CoverageOutput> => {
        const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
        const url = `${baseUrl}/api/projects/${inputData.projectId}/test-coverage`;

        await notifyStepStatus({
            stepId: "postCoverageStep",
            status: "starting",
            runId,
            containerId: inputData.containerId,
            title: "Post TypeScript + Vitest coverage",
            subtitle: `${(inputData.coverage * 100).toFixed(2)}% (${inputData.method}) → ${url}`,
        });

        const payload = {
            coverage: inputData.coverage,
            language: inputData.language,
            framework: inputData.framework,
            method: inputData.method,
            stats: inputData.stats,
            files: inputData.files,
        };

        try {
            await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
        } catch {
            // Best effort - continue even if POST fails
        }

        await notifyStepStatus({
            stepId: "postCoverageStep",
            status: "completed",
            runId,
            containerId: inputData.containerId,
            title: "TypeScript + Vitest coverage posted",
            subtitle: `${(inputData.coverage * 100).toFixed(2)}% (${inputData.files} files, ${inputData.method} method)`,
            toolCallCount: cliToolMetrics.callCount,
        });

        return inputData;
    },
});

// =============================================================================
// WORKFLOW DEFINITION
// =============================================================================

export const coverageAnalysisWorkflow = createWorkflow({
    id: "coverageAnalysisWorkflow",
    description: "Calculate TypeScript + Vitest test coverage using algorithms/statistics and POST to backend",
    inputSchema: z.object({
        containerId: z.string(),
        projectId: z.string(),
        repoPath: z.string().optional(),
    }),
    outputSchema: z.object({
        coverage: z.number(),
        projectId: z.string(),
        language: z.string(),
        framework: z.string(),
        method: z.string(),
        files: z.number(),
        stats: CoverageStatsSchema,
    }),
})
.then(runCoverageStep)
.then(postCoverageStep)
.commit();
