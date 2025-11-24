/**
 * Core workflow context types and schemas.
 * These define the data structures passed between workflow steps.
 */
import z from "zod";

// =============================================================================
// CONTEXT DATA SCHEMA
// =============================================================================

/**
 * Context data passed through Docker steps from external sources (e.g., GitHub webhooks).
 * Uses passthrough() to allow additional fields from external systems.
 */
export const ContextDataSchema = z.object({
    // Repository identification
    owner: z.string().optional(),
    repo: z.string().optional(),
    fullName: z.string().optional(),
    full_name: z.string().optional(),
    
    // Branch information
    defaultBranch: z.string().optional(),
    default_branch: z.string().optional(),
    
    // Repository metadata
    name: z.string().optional(),
    description: z.string().optional(),
    language: z.string().optional(),
    topics: z.array(z.string()).optional(),
    
    // Clone/access info
    clone_url: z.string().optional(),
    ssh_url: z.string().optional(),
    html_url: z.string().optional(),
}).passthrough(); // Allow additional fields from external systems

export type ContextData = z.infer<typeof ContextDataSchema>;

// =============================================================================
// BASE STEP OUTPUT SCHEMAS
// =============================================================================

/**
 * Base output schema for steps that track tool metrics and success status.
 */
export const BaseStepOutputSchema = z.object({
    result: z.string().describe("Human-readable result message"),
    success: z.boolean().describe("Whether the operation was successful"),
    toolCallCount: z.number().describe("Total number of tool calls made during execution"),
});

export type BaseStepOutput = z.infer<typeof BaseStepOutputSchema>;

/**
 * Docker step output - includes container information.
 */
export const DockerStepOutputSchema = BaseStepOutputSchema.extend({
    containerId: z.string().describe("The ID of the Docker container"),
    contextData: ContextDataSchema.optional().describe("Context data passed through"),
    repositoryUrl: z.string().optional().describe("Repository URL passed through"),
    projectId: z.string().describe("Project ID associated with this workflow run"),
});

export type DockerStepOutput = z.infer<typeof DockerStepOutputSchema>;

/**
 * Docker step output with repository path - after cloning.
 */
export const DockerWithRepoPathSchema = DockerStepOutputSchema.extend({
    repoPath: z.string().describe("Absolute path to the cloned repository inside the container"),
});

export type DockerWithRepoPath = z.infer<typeof DockerWithRepoPathSchema>;

/**
 * Docker step output with context path - after saving context.
 */
export const DockerWithContextPathSchema = z.object({
    result: z.string().describe("The result of the Docker operation"),
    success: z.boolean().describe("Whether the operation was successful"),
    toolCallCount: z.number().describe("Total number of tool calls made during execution"),
    containerId: z.string().describe("The ID of the created Docker container"),
    contextPath: z.string().describe("Path where context was saved in the container"),
    repoPath: z.string().describe("Absolute path to the cloned repository inside the container"),
});

export type DockerWithContextPath = z.infer<typeof DockerWithContextPathSchema>;

// =============================================================================
// WORKFLOW INPUT SCHEMAS
// =============================================================================

/**
 * Standard workflow input with container and project identifiers.
 */
export const WorkflowInputSchema = z.object({
    containerId: z.string().describe("Docker container ID where the repository is mounted"),
    repoPath: z.string().optional().describe("Absolute path to the repository inside the container"),
    projectId: z.string().describe("Project ID associated with this workflow run"),
});

export type WorkflowInput = z.infer<typeof WorkflowInputSchema>;

/**
 * Extended workflow input with context path.
 */
export const WorkflowInputWithContextSchema = WorkflowInputSchema.extend({
    contextPath: z.string().optional().default("/app/agent.context.json").describe("Path to the context file"),
});

export type WorkflowInputWithContext = z.infer<typeof WorkflowInputWithContextSchema>;

// =============================================================================
// PARALLEL STEP OUTPUT SCHEMAS
// =============================================================================

/**
 * Creates a schema for parallel step outputs where each step's output is keyed by step ID.
 */
export function createParallelOutputSchema<T extends z.ZodTypeAny>(
    stepIds: string[],
    stepOutputSchema: T
): z.ZodObject<Record<string, T>> {
    const shape: Record<string, T> = {};
    for (const stepId of stepIds) {
        shape[stepId] = stepOutputSchema;
    }
    return z.object(shape) as z.ZodObject<Record<string, T>>;
}

