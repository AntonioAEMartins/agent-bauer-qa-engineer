/**
 * Repository analysis types and schemas.
 * Used by the gather-context workflow.
 */
import z from "zod";

// =============================================================================
// GIT STATUS
// =============================================================================

/**
 * Git repository status information.
 */
export const GitStatusSchema = z.object({
    isGitRepo: z.boolean(),
    defaultBranch: z.string().nullable(),
    lastCommit: z.string().nullable(),
    hasRemote: z.boolean(),
    isDirty: z.boolean(),
});

export type GitStatus = z.infer<typeof GitStatusSchema>;

// =============================================================================
// REPOSITORY STRUCTURE
// =============================================================================

/**
 * Package type within a repository.
 */
export const PackageTypeSchema = z.enum(["app", "library", "tool", "config", "unknown"]);

export type PackageType = z.infer<typeof PackageTypeSchema>;

/**
 * Package information within a repository.
 */
export const PackageInfoSchema = z.object({
    path: z.string(),
    name: z.string().nullable(),
    type: PackageTypeSchema,
    language: z.string().nullable(),
});

export type PackageInfo = z.infer<typeof PackageInfoSchema>;

/**
 * Repository structure information.
 */
export const RepoStructureSchema = z.object({
    packages: z.array(PackageInfoSchema),
    keyDirectories: z.array(z.string()),
    ignoredPaths: z.array(z.string()),
});

export type RepoStructure = z.infer<typeof RepoStructureSchema>;

/**
 * Language usage statistics.
 */
export const LanguageStatsSchema = z.object({
    language: z.string(),
    percentage: z.number(),
    fileCount: z.number(),
    mainFiles: z.array(z.string()),
});

export type LanguageStats = z.infer<typeof LanguageStatsSchema>;

/**
 * Repository type classification.
 */
export const RepositoryTypeSchema = z.enum(["monorepo", "single-package", "multi-project"]);

export type RepositoryType = z.infer<typeof RepositoryTypeSchema>;

/**
 * Complete repository structure analysis.
 */
export const RepositoryStructureSchema = z.object({
    type: RepositoryTypeSchema,
    rootPath: z.string(),
    gitStatus: GitStatusSchema,
    structure: RepoStructureSchema,
    languages: z.array(LanguageStatsSchema),
});

export type RepositoryStructure = z.infer<typeof RepositoryStructureSchema>;

// =============================================================================
// CODEBASE ANALYSIS
// =============================================================================

/**
 * Module information within the codebase.
 */
export const ModuleInfoSchema = z.object({
    path: z.string(),
    purpose: z.string(),
});

export type ModuleInfo = z.infer<typeof ModuleInfoSchema>;

/**
 * Internal dependency information.
 */
export const InternalDependencySchema = z.object({
    from: z.string(),
    to: z.string(),
    type: z.string(),
});

export type InternalDependency = z.infer<typeof InternalDependencySchema>;

/**
 * Key library information.
 */
export const KeyLibrarySchema = z.object({
    name: z.string(),
    purpose: z.string(),
    version: z.string().nullable(),
});

export type KeyLibrary = z.infer<typeof KeyLibrarySchema>;

/**
 * Dependencies analysis.
 */
export const DependenciesAnalysisSchema = z.object({
    internal: z.array(InternalDependencySchema),
    external: z.record(z.string()),
    keyLibraries: z.array(KeyLibrarySchema),
});

export type DependenciesAnalysis = z.infer<typeof DependenciesAnalysisSchema>;

/**
 * Architecture analysis.
 */
export const ArchitectureAnalysisSchema = z.object({
    pattern: z.string().describe("Overall architectural pattern (MVC, microservices, etc.)"),
    entryPoints: z.array(z.string()),
    mainModules: z.array(ModuleInfoSchema),
    dependencies: DependenciesAnalysisSchema,
});

export type ArchitectureAnalysis = z.infer<typeof ArchitectureAnalysisSchema>;

/**
 * Code comments level.
 */
export const CodeCommentsLevelSchema = z.enum(["extensive", "moderate", "minimal", "none"]);

export type CodeCommentsLevel = z.infer<typeof CodeCommentsLevelSchema>;

/**
 * Documentation analysis.
 */
export const DocumentationAnalysisSchema = z.object({
    hasReadme: z.boolean(),
    hasApiDocs: z.boolean(),
    codeComments: CodeCommentsLevelSchema,
});

export type DocumentationAnalysis = z.infer<typeof DocumentationAnalysisSchema>;

/**
 * Code quality analysis.
 */
export const CodeQualityAnalysisSchema = z.object({
    hasTests: z.boolean(),
    testCoverage: z.string().nullable(),
    linting: z.array(z.string()),
    formatting: z.array(z.string()),
    documentation: DocumentationAnalysisSchema,
});

export type CodeQualityAnalysis = z.infer<typeof CodeQualityAnalysisSchema>;

/**
 * Framework information.
 */
export const FrameworkInfoSchema = z.object({
    name: z.string(),
    version: z.string().nullable(),
    purpose: z.string(),
    configFiles: z.array(z.string()),
});

export type FrameworkInfo = z.infer<typeof FrameworkInfoSchema>;

/**
 * Complete codebase analysis.
 */
export const CodebaseAnalysisSchema = z.object({
    architecture: ArchitectureAnalysisSchema,
    codeQuality: CodeQualityAnalysisSchema,
    frameworks: z.array(FrameworkInfoSchema),
});

export type CodebaseAnalysis = z.infer<typeof CodebaseAnalysisSchema>;

// =============================================================================
// BUILD AND DEPLOYMENT
// =============================================================================

/**
 * Build attempt result.
 */
export const BuildAttemptSchema = z.object({
    command: z.string(),
    success: z.boolean(),
    output: z.string(),
    issues: z.array(z.string()),
});

export type BuildAttempt = z.infer<typeof BuildAttemptSchema>;

/**
 * Build system information.
 */
export const BuildSystemSchema = z.object({
    type: z.string().nullable(),
    configFiles: z.array(z.string()),
    buildCommands: z.array(z.string()),
    buildAttempts: z.array(BuildAttemptSchema),
});

export type BuildSystem = z.infer<typeof BuildSystemSchema>;

/**
 * Package management information.
 */
export const PackageManagementSchema = z.object({
    managers: z.array(z.string()),
    lockFiles: z.array(z.string()),
    workspaceConfig: z.string().nullable(),
});

export type PackageManagement = z.infer<typeof PackageManagementSchema>;

/**
 * Test attempt result.
 */
export const TestAttemptSchema = z.object({
    command: z.string(),
    success: z.boolean(),
    output: z.string(),
});

export type TestAttempt = z.infer<typeof TestAttemptSchema>;

/**
 * Testing configuration.
 */
export const TestingConfigSchema = z.object({
    frameworks: z.array(z.string()),
    testDirs: z.array(z.string()),
    testCommands: z.array(z.string()),
    testAttempts: z.array(TestAttemptSchema),
});

export type TestingConfig = z.infer<typeof TestingConfigSchema>;

/**
 * Environment configuration.
 */
export const EnvironmentConfigSchema = z.object({
    envFiles: z.array(z.string()),
    requiredVars: z.array(z.string()),
});

export type EnvironmentConfig = z.infer<typeof EnvironmentConfigSchema>;

/**
 * Deployment configuration.
 */
export const DeploymentConfigSchema = z.object({
    cicd: z.array(z.string()),
    dockerfiles: z.array(z.string()),
    deploymentConfigs: z.array(z.string()),
    environmentConfig: EnvironmentConfigSchema,
});

export type DeploymentConfig = z.infer<typeof DeploymentConfigSchema>;

/**
 * Complete build and deployment analysis.
 */
export const BuildAndDeploymentSchema = z.object({
    buildSystem: BuildSystemSchema,
    packageManagement: PackageManagementSchema,
    testing: TestingConfigSchema,
    deployment: DeploymentConfigSchema,
});

export type BuildAndDeployment = z.infer<typeof BuildAndDeploymentSchema>;

// =============================================================================
// INSIGHTS
// =============================================================================

/**
 * Complexity level.
 */
export const ComplexityLevelSchema = z.enum(["simple", "moderate", "complex", "very-complex"]);

export type ComplexityLevel = z.infer<typeof ComplexityLevelSchema>;

/**
 * Maturity level.
 */
export const MaturityLevelSchema = z.enum(["prototype", "development", "production", "mature"]);

export type MaturityLevel = z.infer<typeof MaturityLevelSchema>;

/**
 * Maintainability level.
 */
export const MaintainabilityLevelSchema = z.enum(["excellent", "good", "fair", "poor"]);

export type MaintainabilityLevel = z.infer<typeof MaintainabilityLevelSchema>;

/**
 * Strengths and weaknesses analysis.
 */
export const StrengthsWeaknessesSchema = z.object({
    strengths: z.array(z.string()),
    weaknesses: z.array(z.string()),
});

export type StrengthsWeaknesses = z.infer<typeof StrengthsWeaknessesSchema>;

/**
 * Repository insights.
 */
export const InsightsSchema = z.object({
    complexity: ComplexityLevelSchema,
    maturity: MaturityLevelSchema,
    maintainability: MaintainabilityLevelSchema,
    recommendations: z.array(z.string()),
    potentialIssues: z.array(z.string()),
    strengthsWeaknesses: StrengthsWeaknessesSchema,
});

export type Insights = z.infer<typeof InsightsSchema>;

/**
 * Confidence scores for analysis sections.
 */
export const ConfidenceScoresSchema = z.object({
    repository: z.number(),
    codebase: z.number(),
    buildDeploy: z.number(),
    overall: z.number(),
});

export type ConfidenceScores = z.infer<typeof ConfidenceScoresSchema>;

// =============================================================================
// COMPLETE REPO CONTEXT
// =============================================================================

/**
 * Complete repository context analysis.
 */
export const RepoContextSchema = z.object({
    repository: RepositoryStructureSchema,
    codebase: CodebaseAnalysisSchema,
    buildDeploy: BuildAndDeploymentSchema,
    insights: InsightsSchema,
    confidence: ConfidenceScoresSchema,
    executiveSummary: z.string().describe("2-3 paragraph summary as a senior engineer would write"),
});

export type RepoContext = z.infer<typeof RepoContextSchema>;

