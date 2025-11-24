/**
 * Test generation types and schemas.
 * Used by the unit test generation workflow.
 */
import z from "zod";

// =============================================================================
// REPOSITORY TEST ANALYSIS
// =============================================================================

/**
 * Source module information for testing.
 */
export const SourceModuleSchema = z.object({
    modulePath: z.string().describe("Path to the module directory"),
    sourceFiles: z.array(z.string()).describe("Source files in this module"),
    priority: z.enum(["high", "medium", "low"]).describe("Priority level for testing"),
    language: z.string().describe("Programming language"),
});

export type SourceModule = z.infer<typeof SourceModuleSchema>;

/**
 * Repository analysis schema for testing strategy.
 */
export const RepoTestAnalysisSchema = z.object({
    sourceModules: z.array(SourceModuleSchema).describe("List of source modules to test"),
    testingFramework: z.string().describe("Testing framework to use (e.g., jest, vitest)"),
    testDirectory: z.string().describe("Directory where tests should be placed"),
    totalFiles: z.number().describe("Total number of files to test"),
});

export type RepoTestAnalysis = z.infer<typeof RepoTestAnalysisSchema>;

// =============================================================================
// TEST SPECIFICATION
// =============================================================================

/**
 * Function test specification.
 */
export const FunctionTestSpecSchema = z.object({
    name: z.string().describe("Function or method name"),
    testCases: z.array(z.string()).describe("Test cases to implement"),
});

export type FunctionTestSpec = z.infer<typeof FunctionTestSpecSchema>;

/**
 * Test specification schema for individual files.
 */
export const TestSpecificationSchema = z.object({
    sourceFile: z.string().describe("Path to the source file"),
    functions: z.array(FunctionTestSpecSchema).describe("Functions and their test cases"),
});

export type TestSpecification = z.infer<typeof TestSpecificationSchema>;

// =============================================================================
// CODING TASK
// =============================================================================

/**
 * Task assignment for coding agents.
 */
export const CodingTaskSchema = z.object({
    taskId: z.string().describe("Unique task identifier"),
    agentId: z.string().describe("Agent responsible for this task"),
    sourceFile: z.string().describe("Source file to test"),
    testFile: z.string().describe("Test file to generate"),
    testSpec: TestSpecificationSchema.describe("Test specification for this file"),
    priority: z.enum(["high", "medium", "low"]).describe("Task priority"),
    framework: z.string().describe("Testing framework to use"),
});

export type CodingTask = z.infer<typeof CodingTaskSchema>;

// =============================================================================
// TEST GENERATION RESULTS
// =============================================================================

/**
 * Test generation result for individual files.
 */
export const TestFileResultSchema = z.object({
    sourceFile: z.string().describe("Source file that was tested"),
    testFile: z.string().describe("Generated test file path"),
    functionsCount: z.number().describe("Number of functions tested"),
    testCasesCount: z.number().describe("Number of test cases generated"),
    success: z.boolean().describe("Whether generation was successful"),
    error: z.string().optional().describe("Error message if generation failed"),
});

export type TestFileResult = z.infer<typeof TestFileResultSchema>;

/**
 * Quality assessment of generated tests.
 */
export const TestQualitySchema = z.object({
    syntaxValid: z.boolean().describe("Whether generated tests have valid syntax"),
    followsBestPractices: z.boolean().describe("Whether tests follow best practices"),
    coverageScore: z.number().describe("Estimated test coverage score (0-100)"),
});

export type TestQuality = z.infer<typeof TestQualitySchema>;

/**
 * Summary of test generation.
 */
export const TestGenerationSummarySchema = z.object({
    totalSourceFiles: z.number().describe("Total source files processed"),
    totalTestFiles: z.number().describe("Total test files generated"),
    totalFunctions: z.number().describe("Total functions tested"),
    totalTestCases: z.number().describe("Total test cases generated"),
    successfulFiles: z.number().describe("Number of successfully generated test files"),
    failedFiles: z.number().describe("Number of failed test file generations"),
});

export type TestGenerationSummary = z.infer<typeof TestGenerationSummarySchema>;

/**
 * Comprehensive test generation result.
 */
export const TestGenerationResultSchema = z.object({
    testFiles: z.array(TestFileResultSchema).describe("Results for each test file"),
    summary: TestGenerationSummarySchema.describe("Overall generation summary"),
    quality: TestQualitySchema.describe("Quality assessment of generated tests"),
});

export type TestGenerationResult = z.infer<typeof TestGenerationResultSchema>;

// =============================================================================
// UNIT TEST WORKFLOW OUTPUT
// =============================================================================

/**
 * Final workflow output schema for unit test generation.
 */
export const UnitTestResultSchema = z.object({
    result: z.string().describe("Human-readable result message"),
    success: z.boolean().describe("Whether the workflow completed successfully"),
    toolCallCount: z.number().describe("Total number of tool calls made"),
    testGeneration: TestGenerationResultSchema.describe("Detailed test generation results"),
    recommendations: z.array(z.string()).describe("Recommendations for next steps"),
});

export type UnitTestResult = z.infer<typeof UnitTestResultSchema>;

