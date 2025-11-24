/**
 * Pipeline schemas for step I/O alignment.
 * These schemas ensure type safety across the full pipeline workflow.
 */
import z from "zod";
import { ContextDataSchema } from "./workflow-context";
import { 
    RepoTestAnalysisSchema, 
    TestSpecificationSchema, 
    TestGenerationResultSchema,
    UnitTestResultSchema,
} from "./test-generation";
import { CoverageStatsSchema } from "./coverage";
import { RepoContextSchema } from "./repository-analysis";

// =============================================================================
// PIPELINE INPUT
// =============================================================================

/**
 * Input for the full pipeline workflow.
 */
export const PipelineInputSchema = z.object({
    contextData: ContextDataSchema.optional().describe("Optional context data to save to the container during docker setup"),
    repositoryUrl: z.string().optional().describe("Optional repository URL or owner/repo format (e.g., 'owner/repo' or 'https://github.com/owner/repo')"),
    projectId: z.string().describe("Project ID associated with this workflow run"),
});

export type PipelineInput = z.infer<typeof PipelineInputSchema>;

// =============================================================================
// PHASE 1: DOCKER SETUP
// =============================================================================

/**
 * Step 1: testDockerStep output - Container created.
 */
export const TestDockerStepOutputSchema = z.object({
    result: z.string().describe("The result of the Docker operation"),
    success: z.boolean().describe("Whether the operation was successful"),
    toolCallCount: z.number().describe("Total number of tool calls made during execution"),
    containerId: z.string().describe("The ID of the created Docker container"),
    contextData: ContextDataSchema.optional().describe("Context data passed through"),
    repositoryUrl: z.string().optional().describe("Repository URL passed through"),
    projectId: z.string().describe("Project ID passed through"),
});

export type TestDockerStepOutput = z.infer<typeof TestDockerStepOutputSchema>;

/**
 * Step 2: testDockerGithubCloneStep output - Repository cloned.
 */
export const TestDockerGithubCloneStepOutputSchema = TestDockerStepOutputSchema.extend({
    repoPath: z.string().describe("Absolute path to the cloned repository inside the container"),
});

export type TestDockerGithubCloneStepOutput = z.infer<typeof TestDockerGithubCloneStepOutputSchema>;

/**
 * Step 3: postProjectDescriptionStep / postProjectStackStep output (same structure).
 * These run in parallel and return the same structure as their input.
 */
export const PostProjectStepOutputSchema = TestDockerGithubCloneStepOutputSchema;

export type PostProjectStepOutput = z.infer<typeof PostProjectStepOutputSchema>;

/**
 * Parallel output from postProjectDescriptionStep and postProjectStackStep.
 */
export const ParallelPostProjectOutputSchema = z.object({
    "post-project-description-step": PostProjectStepOutputSchema,
    "post-project-stack-step": PostProjectStepOutputSchema,
});

export type ParallelPostProjectOutput = z.infer<typeof ParallelPostProjectOutputSchema>;

/**
 * Step 4: dockerSaveContextStep output - Context saved to container.
 */
export const DockerSaveContextStepOutputSchema = z.object({
    result: z.string().describe("The result of the Docker operation"),
    success: z.boolean().describe("Whether the operation was successful"),
    toolCallCount: z.number().describe("Total number of tool calls made during execution"),
    containerId: z.string().describe("The ID of the created Docker container"),
    contextPath: z.string().describe("Path where context was saved in the container"),
    repoPath: z.string().describe("Absolute path to the cloned repository inside the container"),
    projectId: z.string().describe("Project ID passed through"),
});

export type DockerSaveContextStepOutput = z.infer<typeof DockerSaveContextStepOutputSchema>;

// =============================================================================
// PHASE 2: GATHER CONTEXT
// =============================================================================

/**
 * Gather workflow input (from dockerSaveContextStep).
 */
export const GatherWorkflowInputSchema = z.object({
    containerId: z.string(),
    repoPath: z.string().optional(),
    projectId: z.string().describe("Project ID associated with this workflow run"),
});

export type GatherWorkflowInput = z.infer<typeof GatherWorkflowInputSchema>;

/**
 * analyzeRepositoryStep output.
 */
export const AnalyzeRepositoryStepOutputSchema = z.object({
    containerId: z.string(),
    repository: z.lazy(() => 
        z.object({
            type: z.enum(["monorepo", "single-package", "multi-project"]),
            rootPath: z.string(),
            gitStatus: z.object({
                isGitRepo: z.boolean(),
                defaultBranch: z.string().nullable(),
                lastCommit: z.string().nullable(),
                hasRemote: z.boolean(),
                isDirty: z.boolean(),
            }),
            structure: z.object({
                packages: z.array(z.object({
                    path: z.string(),
                    name: z.string().nullable(),
                    type: z.enum(["app", "library", "tool", "config", "unknown"]),
                    language: z.string().nullable(),
                })),
                keyDirectories: z.array(z.string()),
                ignoredPaths: z.array(z.string()),
            }),
            languages: z.array(z.object({
                language: z.string(),
                percentage: z.number(),
                fileCount: z.number(),
                mainFiles: z.array(z.string()),
            })),
        })
    ),
    projectId: z.string(),
});

export type AnalyzeRepositoryStepOutput = z.infer<typeof AnalyzeRepositoryStepOutputSchema>;

/**
 * analyzeCodebaseStep output.
 */
export const AnalyzeCodebaseStepOutputSchema = z.object({
    containerId: z.string(),
    codebase: z.object({
        architecture: z.object({
            pattern: z.string(),
            entryPoints: z.array(z.string()),
            mainModules: z.array(z.object({ path: z.string(), purpose: z.string() })),
            dependencies: z.object({
                internal: z.array(z.object({ from: z.string(), to: z.string(), type: z.string() })),
                external: z.record(z.string()),
                keyLibraries: z.array(z.object({ name: z.string(), purpose: z.string(), version: z.string().nullable() })),
            }),
        }),
        codeQuality: z.object({
            hasTests: z.boolean(),
            testCoverage: z.string().nullable(),
            linting: z.array(z.string()),
            formatting: z.array(z.string()),
            documentation: z.object({
                hasReadme: z.boolean(),
                hasApiDocs: z.boolean(),
                codeComments: z.enum(["extensive", "moderate", "minimal", "none"]),
            }),
        }),
        frameworks: z.array(z.object({
            name: z.string(),
            version: z.string().nullable(),
            purpose: z.string(),
            configFiles: z.array(z.string()),
        })),
    }),
    projectId: z.string(),
});

export type AnalyzeCodebaseStepOutput = z.infer<typeof AnalyzeCodebaseStepOutputSchema>;

/**
 * analyzeBuildDeploymentStep output.
 */
export const AnalyzeBuildDeploymentStepOutputSchema = z.object({
    containerId: z.string(),
    buildDeploy: z.object({
        buildSystem: z.object({
            type: z.string().nullable(),
            configFiles: z.array(z.string()),
            buildCommands: z.array(z.string()),
            buildAttempts: z.array(z.object({
                command: z.string(),
                success: z.boolean(),
                output: z.string(),
                issues: z.array(z.string()),
            })),
        }),
        packageManagement: z.object({
            managers: z.array(z.string()),
            lockFiles: z.array(z.string()),
            workspaceConfig: z.string().nullable(),
        }),
        testing: z.object({
            frameworks: z.array(z.string()),
            testDirs: z.array(z.string()),
            testCommands: z.array(z.string()),
            testAttempts: z.array(z.object({
                command: z.string(),
                success: z.boolean(),
                output: z.string(),
            })),
        }),
        deployment: z.object({
            cicd: z.array(z.string()),
            dockerfiles: z.array(z.string()),
            deploymentConfigs: z.array(z.string()),
            environmentConfig: z.object({
                envFiles: z.array(z.string()),
                requiredVars: z.array(z.string()),
            }),
        }),
    }),
    projectId: z.string(),
});

export type AnalyzeBuildDeploymentStepOutput = z.infer<typeof AnalyzeBuildDeploymentStepOutputSchema>;

/**
 * Parallel output from analysis steps.
 */
export const ParallelAnalysisOutputSchema = z.object({
    "analyze-repository-step": AnalyzeRepositoryStepOutputSchema,
    "analyze-codebase-step": AnalyzeCodebaseStepOutputSchema,
    "analyze-build-deployment-step": AnalyzeBuildDeploymentStepOutputSchema,
});

export type ParallelAnalysisOutput = z.infer<typeof ParallelAnalysisOutputSchema>;

/**
 * synthesizeContextStep output.
 */
export const SynthesizeContextStepOutputSchema = RepoContextSchema.extend({
    containerId: z.string(),
    projectId: z.string(),
});

export type SynthesizeContextStepOutput = z.infer<typeof SynthesizeContextStepOutputSchema>;

/**
 * gatherSaveContextStep output.
 */
export const GatherSaveContextStepOutputSchema = z.object({
    containerId: z.string(),
    contextPath: z.string(),
    repoContext: RepoContextSchema,
    projectId: z.string(),
});

export type GatherSaveContextStepOutput = z.infer<typeof GatherSaveContextStepOutputSchema>;

// =============================================================================
// PHASE 3: TEST GENERATION
// =============================================================================

/**
 * checkSavedPlanStep output.
 */
export const CheckSavedPlanStepOutputSchema = z.object({
    containerId: z.string(),
    contextPath: z.string(),
    repoAnalysis: RepoTestAnalysisSchema.optional(),
    testSpecs: z.array(TestSpecificationSchema).optional(),
    skipToGeneration: z.boolean(),
    projectId: z.string(),
});

export type CheckSavedPlanStepOutput = z.infer<typeof CheckSavedPlanStepOutputSchema>;

/**
 * loadContextAndPlanStep output.
 */
export const LoadContextAndPlanStepOutputSchema = z.object({
    containerId: z.string(),
    contextPath: z.string(),
    repoAnalysis: RepoTestAnalysisSchema,
    testSpecs: z.array(TestSpecificationSchema),
    projectId: z.string(),
});

export type LoadContextAndPlanStepOutput = z.infer<typeof LoadContextAndPlanStepOutputSchema>;

/**
 * generateTestCodeStep output.
 */
export const GenerateTestCodeStepOutputSchema = z.object({
    containerId: z.string(),
    contextPath: z.string().optional(),
    testGeneration: TestGenerationResultSchema,
    repoAnalysis: RepoTestAnalysisSchema,
    testSpecs: z.array(TestSpecificationSchema),
    projectId: z.string(),
});

export type GenerateTestCodeStepOutput = z.infer<typeof GenerateTestCodeStepOutputSchema>;

/**
 * finalizeStep output.
 */
export const FinalizeStepOutputSchema = UnitTestResultSchema.extend({
    projectId: z.string(),
    containerId: z.string(),
    contextPath: z.string().optional(),
});

export type FinalizeStepOutput = z.infer<typeof FinalizeStepOutputSchema>;

// =============================================================================
// PHASE 4: GITHUB PR
// =============================================================================

/**
 * prepareCommitAndPushStep output.
 */
export const PrepareCommitAndPushStepOutputSchema = z.object({
    containerId: z.string(),
    repoPath: z.string(),
    branchName: z.string(),
    baseBranch: z.string(),
    repoOwner: z.string(),
    repoName: z.string(),
    commitMessage: z.string(),
    projectId: z.string(),
    testGeneration: TestGenerationResultSchema.optional(),
    repoAnalysis: RepoTestAnalysisSchema.optional(),
    testSpecs: z.array(TestSpecificationSchema).optional(),
    result: z.string().optional(),
    success: z.boolean().optional(),
    toolCallCount: z.number().optional(),
    contextPath: z.string().optional(),
});

export type PrepareCommitAndPushStepOutput = z.infer<typeof PrepareCommitAndPushStepOutputSchema>;

/**
 * createPullRequestStep output.
 */
export const CreatePullRequestStepOutputSchema = z.object({
    prUrl: z.string(),
    prNumber: z.number().optional(),
    projectId: z.string(),
    containerId: z.string(),
    result: z.string().optional(),
    success: z.boolean().optional(),
    toolCallCount: z.number().optional(),
    contextPath: z.string().optional(),
});

export type CreatePullRequestStepOutput = z.infer<typeof CreatePullRequestStepOutputSchema>;

/**
 * postPrUrlStep output.
 */
export const PostPrUrlStepOutputSchema = z.object({
    prUrl: z.string(),
    projectId: z.string(),
    containerId: z.string(),
    result: z.string().optional(),
    success: z.boolean().optional(),
    toolCallCount: z.number().optional(),
    contextPath: z.string().optional(),
});

export type PostPrUrlStepOutput = z.infer<typeof PostPrUrlStepOutputSchema>;

// =============================================================================
// PHASE 5: COVERAGE
// =============================================================================

/**
 * runTypescriptVitestCoverageStep output.
 */
export const RunTypescriptVitestCoverageStepOutputSchema = z.object({
    containerId: z.string(),
    projectId: z.string(),
    coverage: z.number(),
    repoPath: z.string(),
    language: z.string(),
    framework: z.string(),
    method: z.string(),
    stats: CoverageStatsSchema,
    files: z.number(),
    prUrl: z.string().optional(),
    contextPath: z.string().optional(),
    result: z.string().optional(),
    success: z.boolean(),
    toolCallCount: z.number().optional(),
});

export type RunTypescriptVitestCoverageStepOutput = z.infer<typeof RunTypescriptVitestCoverageStepOutputSchema>;

/**
 * postTestCoverageStep output (same as input, passes through).
 */
export const PostTestCoverageStepOutputSchema = RunTypescriptVitestCoverageStepOutputSchema;

export type PostTestCoverageStepOutput = z.infer<typeof PostTestCoverageStepOutputSchema>;

// =============================================================================
// PIPELINE OUTPUT
// =============================================================================

/**
 * Final pipeline output.
 */
export const PipelineOutputSchema = z.object({
    result: z.string(),
    success: z.boolean(),
    toolCallCount: z.number(),
    containerId: z.string(),
    contextPath: z.string().optional(),
    projectId: z.string(),
    prUrl: z.string(),
});

export type PipelineOutput = z.infer<typeof PipelineOutputSchema>;

