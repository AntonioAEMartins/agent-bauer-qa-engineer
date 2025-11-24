/**
 * Test coverage types and schemas.
 */
import z from "zod";

// =============================================================================
// COVERAGE STATISTICS
// =============================================================================

/**
 * Single coverage metric (e.g., statements, branches, functions, lines).
 */
export const CoverageMetricSchema = z.object({
    total: z.number().describe("Total count"),
    covered: z.number().describe("Covered count"),
    pct: z.number().describe("Percentage covered (0-100)"),
});

export type CoverageMetric = z.infer<typeof CoverageMetricSchema>;

/**
 * Comprehensive coverage statistics.
 */
export const CoverageStatsSchema = z.object({
    statements: CoverageMetricSchema,
    branches: CoverageMetricSchema,
    functions: CoverageMetricSchema,
    lines: CoverageMetricSchema,
});

export type CoverageStats = z.infer<typeof CoverageStatsSchema>;

// =============================================================================
// COVERAGE RESULTS
// =============================================================================

/**
 * Coverage analysis method used.
 */
export const CoverageMethodSchema = z.enum(["json", "xml", "stdout", "algorithmic"]);

export type CoverageMethod = z.infer<typeof CoverageMethodSchema>;

/**
 * Coverage runner step output.
 */
export const CoverageRunnerOutputSchema = z.object({
    containerId: z.string(),
    projectId: z.string(),
    coverage: z.number().describe("Coverage ratio (0-1)"),
    repoPath: z.string(),
    language: z.string(),
    framework: z.string(),
    method: z.string().describe("Method used: json | xml | stdout | algorithmic"),
    stats: CoverageStatsSchema,
    files: z.number().describe("Number of files analyzed"),
    prUrl: z.string().optional(),
    contextPath: z.string().optional(),
    result: z.string().optional(),
    success: z.boolean(),
    toolCallCount: z.number().optional(),
});

export type CoverageRunnerOutput = z.infer<typeof CoverageRunnerOutputSchema>;

/**
 * Coverage validation result from agent.
 */
export const CoverageValidationResultSchema = z.object({
    isValid: z.boolean(),
    repoPath: z.string(),
    language: z.string(),
    framework: z.string(),
    coverage: z.number(),
    method: z.string(),
    stats: CoverageStatsSchema,
    files: z.number(),
    reason: z.string(),
});

export type CoverageValidationResult = z.infer<typeof CoverageValidationResultSchema>;

// =============================================================================
// COVERAGE WORKFLOW OUTPUT
// =============================================================================

/**
 * Final output of coverage workflow.
 */
export const CoverageWorkflowOutputSchema = z.object({
    coverage: z.number(),
    projectId: z.string(),
    language: z.string(),
    framework: z.string(),
    method: z.string(),
    files: z.number(),
    stats: CoverageStatsSchema,
});

export type CoverageWorkflowOutput = z.infer<typeof CoverageWorkflowOutputSchema>;

