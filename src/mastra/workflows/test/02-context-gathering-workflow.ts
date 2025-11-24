import { createStep, createWorkflow } from "@mastra/core";
import { mastra } from "../..";
import z from "zod";
import { cliToolMetrics } from "../../tools/cli-tool";
import { exec } from "child_process";
import { writeFileSync, unlinkSync, mkdtempSync } from "fs";
import path from "path";
import os from "os";
import { notifyStepStatus } from "../../tools/alert-notifier";
import {
    getErrorMessage,
    extractJsonFromText,
    attemptJsonRecovery,
    RepositoryStructureSchema,
    CodebaseAnalysisSchema,
    BuildAndDeploymentSchema,
    RepoContextSchema,
    type PackageType,
    type CodeCommentsLevel,
    type RepositoryType,
} from "../../types";

const ALERTS_ONLY = (process.env.ALERTS_ONLY === 'true') || (process.env.LOG_MODE === 'alerts_only') || (process.env.MASTRA_LOG_MODE === 'alerts_only');

// =============================================================================
// STEP INPUT/OUTPUT SCHEMAS
// =============================================================================

// Input schema - what we start with (includes optional repoPath from previous workflow)
const WorkflowInputSchema = z.object({
    containerId: z.string(),
    repoPath: z.string().optional(),
    projectId: z.string().describe("Project ID associated with this workflow run"),
});

type WorkflowInput = z.infer<typeof WorkflowInputSchema>;

// Step output schemas
const AnalyzeRepositoryOutputSchema = z.object({
    containerId: z.string(),
    repository: RepositoryStructureSchema,
    projectId: z.string(),
});

const AnalyzeCodebaseOutputSchema = z.object({
    containerId: z.string(),
    codebase: CodebaseAnalysisSchema,
    projectId: z.string(),
});

const AnalyzeBuildDeploymentOutputSchema = z.object({
    containerId: z.string(),
    buildDeploy: BuildAndDeploymentSchema,
    projectId: z.string(),
});

const SynthesizeContextOutputSchema = RepoContextSchema.extend({
    containerId: z.string(),
    projectId: z.string(),
});

const SaveContextOutputSchema = z.object({
    containerId: z.string(),
    contextPath: z.string(),
    repoContext: RepoContextSchema,
    projectId: z.string(),
});

const ValidateOutputSchema = z.object({
    result: z.string(),
    success: z.boolean(),
    toolCallCount: z.number(),
    contextPath: z.string(),
    repoContext: RepoContextSchema,
    projectId: z.string(),
});

// Parallel analysis input schema
const ParallelAnalysisInputSchema = z.object({
    "analyzeRepositoryStep": AnalyzeRepositoryOutputSchema,
    "analyzeCodebaseStep": AnalyzeCodebaseOutputSchema,
    "analyzeBuildDeploymentStep": AnalyzeBuildDeploymentOutputSchema,
});

// =============================================================================
// LOGGER TYPE
// =============================================================================

interface Logger {
    info?: (message: string, meta?: Record<string, unknown>) => void;
    debug?: (message: string, meta?: Record<string, unknown>) => void;
    warn?: (message: string, meta?: Record<string, unknown>) => void;
    error?: (message: string, meta?: Record<string, unknown>) => void;
}

// =============================================================================
// NORMALIZATION HELPERS
// =============================================================================

interface DocumentationInput {
    hasReadme?: unknown;
    hasApiDocs?: unknown;
    codeComments?: unknown;
}

interface PackageInput {
    path?: unknown;
    name?: unknown;
    type?: unknown;
    language?: unknown;
}

interface RepositoryInput {
    type?: unknown;
    structure?: {
        packages?: PackageInput[];
    };
    gitStatus?: unknown;
}

interface NormalizableInput {
    codeQuality?: {
        documentation?: DocumentationInput;
    };
    codebase?: {
        codeQuality?: {
            documentation?: DocumentationInput;
        };
    };
    repository?: RepositoryInput;
    gitStatus?: unknown;
    structure?: {
        packages?: PackageInput[];
    };
}

const allowedComments = new Set<CodeCommentsLevel>(["extensive", "moderate", "minimal", "none"]);
const allowedRepoTypes = new Set<RepositoryType>(["monorepo", "single-package", "multi-project"]);
const allowedPackageTypes = new Set<PackageType>(["app", "library", "tool", "config", "unknown"]);

function normalizeDoc(doc: DocumentationInput): void {
    if (!doc || typeof doc !== "object") return;
    const hasReadmeVal = doc.hasReadme;
    const hasApiDocsVal = doc.hasApiDocs;
    doc.hasReadme = hasReadmeVal === null || hasReadmeVal === undefined ? false : Boolean(hasReadmeVal);
    doc.hasApiDocs = hasApiDocsVal === null || hasApiDocsVal === undefined ? false : Boolean(hasApiDocsVal);

    const commentsVal = typeof doc.codeComments === "string" ? doc.codeComments.trim().toLowerCase() : undefined;
    doc.codeComments = commentsVal && allowedComments.has(commentsVal as CodeCommentsLevel) ? commentsVal : "none";
}

function normalizeRepoType(value: unknown): RepositoryType {
    if (typeof value !== "string") return "single-package";
    const v = value.trim().toLowerCase().replace(/\s+/g, "-");
    if (allowedRepoTypes.has(v as RepositoryType)) return v as RepositoryType;
    if (v.includes("mono")) return "monorepo";
    if (v.includes("multi")) return "multi-project";
    return "single-package";
}

function normalizePackageType(value: unknown): PackageType {
    if (typeof value !== "string") return "unknown";
    const v = value.trim().toLowerCase();
    if (allowedPackageTypes.has(v as PackageType)) return v as PackageType;
    if (v.includes("lib")) return "library";
    if (v.includes("app")) return "app";
    if (v.includes("tool")) return "tool";
    if (v.includes("config") || v.includes("cfg")) return "config";
    return "unknown";
}

function normalizeRepositoryShape(repo: RepositoryInput): void {
    if (!repo || typeof repo !== "object") return;
    if (repo.type !== undefined) {
        repo.type = normalizeRepoType(repo.type);
    }
    if (repo.structure && Array.isArray(repo.structure.packages)) {
        repo.structure.packages = repo.structure.packages.map((pkg: PackageInput) => ({
            path: typeof pkg.path === "string" ? pkg.path : String(pkg.path || "."),
            name: typeof pkg.name === "string" ? pkg.name : (pkg.name == null ? null : String(pkg.name)),
            type: normalizePackageType(pkg.type),
            language: typeof pkg.language === "string" ? pkg.language : (pkg.language == null ? null : String(pkg.language)),
        }));
    }
}

function normalizeAgentJsonForSchemas<T>(input: T): T {
    try {
        const data = input as NormalizableInput;
        
        // Direct CodebaseAnalysis shape
        if (data && data.codeQuality && data.codeQuality.documentation) {
            normalizeDoc(data.codeQuality.documentation);
        }

        // RepoContext shape with nested CodebaseAnalysis
        if (data && data.codebase && data.codebase.codeQuality && data.codebase.codeQuality.documentation) {
            normalizeDoc(data.codebase.codeQuality.documentation);
        }

        // Direct RepositoryStructure shape
        if (data && data.gitStatus && data.structure) {
            normalizeRepositoryShape(data as unknown as RepositoryInput);
        }

        // RepoContext shape with nested RepositoryStructure
        if (data && data.repository) {
            normalizeRepositoryShape(data.repository);
        }
    } catch {
        // best-effort normalization; ignore errors
    }
    return input;
}

// =============================================================================
// AGENT HELPER FUNCTIONS
// =============================================================================

async function callContextAgentForAnalysis<T>(
    prompt: string, 
    schema: z.ZodType<T>, 
    maxSteps: number = 50,
    runId?: string,
    logger?: Logger | null
): Promise<T> {
    const agent = mastra?.getAgent("contextAgent");
    if (!agent) throw new Error("Context agent not found");
    
    logger?.debug?.("🤖 Invoking context agent", {
        promptLength: prompt.length,
        maxSteps,
        type: "AGENT_CALL",
        runId: runId,
    });

    const startTime = Date.now();
    const result = await agent.generate(prompt, { 
        maxSteps, 
        maxRetries: 3,
    });
    const duration = Date.now() - startTime;
    
    // Extract text from agent result - it may be in different forms depending on Mastra version
    const resultObj = result as { text?: string };
    const text = (resultObj?.text || "{}").toString();
    
    logger?.debug?.("📤 Agent response received", {
        responseLength: text.length,
        duration: `${duration}ms`,
        type: "AGENT_RESPONSE",
        runId: runId,
    });
    
    // Extract JSON from response
    let jsonText = extractJsonFromText(text);
    
    logger?.debug?.("📋 JSON extraction complete", {
        originalLength: text.length,
        extractedLength: jsonText.length,
        type: "JSON_EXTRACTION",
        runId: runId,
    });
    
    try {
        const parsed = JSON.parse(jsonText);
        const normalized = normalizeAgentJsonForSchemas(parsed);
        const validated = schema.parse(normalized);
        
        logger?.debug?.("✅ JSON parsing and validation successful", {
            jsonLength: jsonText.length,
            validatedKeys: typeof validated === 'object' && validated !== null ? Object.keys(validated as object).length : 0,
            type: "JSON_VALIDATION",
            runId: runId,
        });
        
        return validated;
    } catch (error) {
        // Try recovery
        logger?.warn?.("⚠️ JSON parsing failed, attempting recovery", {
            error: getErrorMessage(error),
            type: "JSON_ERROR",
            runId: runId,
        });
        
        try {
            const recoveredJson = attemptJsonRecovery(jsonText);
            const parsed = JSON.parse(recoveredJson);
            const normalized = normalizeAgentJsonForSchemas(parsed);
            return schema.parse(normalized);
        } catch (recoveryError) {
            logger?.error?.("❌ JSON parsing and recovery both failed", {
                error: getErrorMessage(error),
                jsonText: jsonText.substring(0, 500),
                type: "JSON_ERROR",
                runId: runId,
            });
            
            throw new Error(`JSON parsing failed: ${getErrorMessage(error)}`);
        }
    }
}

// Retry wrapper with alerts
async function withRetryAndAlerts<T>(options: {
    stepId: string;
    containerId: string;
    runId?: string;
    titleOnRetry?: string;
    maxAttempts?: number;
    logger?: Logger | null;
    attempt: () => Promise<T>;
}): Promise<T> {
    const { stepId, containerId, runId, titleOnRetry, maxAttempts = 3, logger, attempt } = options;
    let lastError: unknown = undefined;
    for (let attemptIndex = 1; attemptIndex <= maxAttempts; attemptIndex++) {
        try {
            const result = await attempt();
            if (attemptIndex > 1) {
                logger?.info?.("🔁 Step succeeded after retry", {
                    stepId,
                    attempt: attemptIndex,
                    type: "RETRY_SUCCESS",
                    runId: runId,
                });
            }
            return result;
        } catch (error) {
            lastError = error;
            logger?.warn?.("⚠️ Attempt failed", {
                stepId,
                attempt: attemptIndex,
                error: getErrorMessage(error),
                type: "RETRY_WARN",
                runId: runId,
            });
            if (attemptIndex < maxAttempts) {
                await notifyStepStatus({
                    stepId,
                    status: "in_progress",
                    runId,
                    containerId,
                    title: titleOnRetry || "Retrying after error",
                    subtitle: getErrorMessage(error),
                    level: 'warning',
                    toolCallCount: cliToolMetrics.callCount,
                    metadata: { attempt: attemptIndex, maxAttempts },
                });
                continue;
            }
            throw error instanceof Error ? error : new Error(getErrorMessage(error));
        }
    }
    // Unreachable; satisfies TypeScript
    throw lastError instanceof Error ? lastError : new Error(getErrorMessage(lastError));
}

// =============================================================================
// STEP 1: ANALYZE REPOSITORY
// =============================================================================

export const analyzeRepositoryStep = createStep({
    id: "analyzeRepositoryStep",
    inputSchema: WorkflowInputSchema,
    outputSchema: AnalyzeRepositoryOutputSchema,
    execute: async ({ inputData, mastra, runId }) => {
        const { containerId } = inputData;
        const repoPath = inputData.repoPath || '';
        const logger = ALERTS_ONLY ? null : mastra?.getLogger() as Logger | undefined;
        await notifyStepStatus({
            stepId: "analyzeRepositoryStep",
            status: "starting",
            runId,
            containerId,
            title: "Analyze repository",
            subtitle: "Quick repository scan starting",
        });
        
        logger?.info?.("🔍 Starting quick repository scan", {
            step: "1/6", 
            stepName: "Repository Quick Scan",
            containerId,
            approach: "focused and efficient",
            startTime: new Date().toISOString(),
            type: "WORKFLOW",
            runId: runId,
        });

        const prompt = `CRITICAL: Navigate to repository and analyze efficiently. Use docker_exec with containerId='${containerId}'.

MANDATORY WORKFLOW (Execute in exact order):
1. List /app: docker_exec ls -la /app/
2. Resolve repo: docker_exec REPO_DIR=$( if [ -n '${repoPath}' ] && [ -d '${repoPath}/.git' ]; then echo '${repoPath}'; else for d in /app/*; do if [ -d "$d/.git" ]; then echo "$d"; break; fi; done; fi ); echo \${REPO_DIR:-/app}
3. Git status: docker_exec REPO_DIR=$( if [ -n '${repoPath}' ] && [ -d '${repoPath}/.git' ]; then echo '${repoPath}'; else for d in /app/*; do if [ -d "$d/.git" ]; then echo "$d"; break; fi; done; fi ); cd "\${REPO_DIR:-/app}"; if [ -d .git ]; then git status --porcelain && git branch && git remote -v; else echo "NO_GIT"; fi
4. Quick scan: docker_exec REPO_DIR=$( if [ -n '${repoPath}' ] && [ -d '${repoPath}/.git' ]; then echo '${repoPath}'; else for d in /app/*; do if [ -d "$d/.git" ]; then echo "$d"; break; fi; done; fi ); cd "\${REPO_DIR:-/app}"; ls -la
5. Source check: docker_exec REPO_DIR=$( if [ -n '${repoPath}' ] && [ -d '${repoPath}/.git' ]; then echo '${repoPath}'; else for d in /app/*; do if [ -d "$d/.git" ]; then echo "$d"; break; fi; done; fi ); cd "\${REPO_DIR:-/app}"; if [ -d src ]; then find src -name "*.ts" -o -name "*.js" | head -10; else echo "NO_SRC"; fi
6. Package type: docker_exec REPO_DIR=$( if [ -n '${repoPath}' ] && [ -d '${repoPath}/.git' ]; then echo '${repoPath}'; else for d in /app/*; do if [ -d "$d/.git" ]; then echo "$d"; break; fi; done; fi ); cd "\${REPO_DIR:-/app}"; if [ -f package.json ]; then echo "SINGLE_PACKAGE"; else echo "OTHER"; fi

STRICT JSON ENUM RULES:
- Field type must be one of: "monorepo" | "single-package" | "multi-project". If unsure, choose the closest; never output any other value.
- Field structure.packages[].type must be one of: "app" | "library" | "tool" | "config" | "unknown". If unsure, use "unknown".
- Do not use values like "other", "directory", "single" or uppercase variants. Use lowercase with hyphens exactly as shown.

FAST ANALYSIS - Return JSON immediately:
{
  "type": "single-package",
  "rootPath": "/app",
  "gitStatus": {
    "isGitRepo": true,
    "defaultBranch": "main",
    "lastCommit": "recent",
    "hasRemote": true,
    "isDirty": false
  },
  "structure": {
    "packages": [{"path": ".", "name": "dynamic", "type": "app", "language": "typescript"}],
    "keyDirectories": ["src"],
    "ignoredPaths": ["node_modules", ".git", "build", "dist"]
  },
  "languages": [{"language": "typescript", "percentage": 90, "fileCount": 20, "mainFiles": ["src/mastra/index.ts"]}]
}`;
        
        try {
            logger?.info?.("🤖 Quick repository assessment call", {
                step: "1/6",
                action: "agent-call",
                agentType: "contextAgent",
                type: "WORKFLOW",
                runId: runId,
            });

            const result = await withRetryAndAlerts({
                stepId: "analyzeRepositoryStep",
                containerId,
                runId,
                logger,
                maxAttempts: 3,
                titleOnRetry: "Analyze repository retry",
                attempt: () => callContextAgentForAnalysis(prompt, RepositoryStructureSchema, 8, runId, logger),
            });
            
            logger?.info?.("✅ Repository scan completed quickly", {
                step: "1/6",
                stepName: "Repository Analysis",
                duration: "completed",
                repositoryType: result.type,
                isGitRepo: result.gitStatus.isGitRepo,
                languageCount: result.languages.length,
                packageCount: result.structure.packages.length,
                type: "WORKFLOW",
                runId: runId,
            });

            await notifyStepStatus({
                stepId: "analyzeRepositoryStep",
                status: "completed",
                runId,
                containerId,
                title: "Analyze repository completed",
                subtitle: `Type: ${result.type}`,
                toolCallCount: cliToolMetrics.callCount,
                metadata: { packages: result.structure.packages.length },
            });

            return {
                containerId,
                repository: result,
                projectId: inputData.projectId,
            };
        } catch (error) {
            logger?.error?.("❌ Repository analysis failed", {
                step: "1/6",
                stepName: "Repository Analysis",
                error: getErrorMessage(error),
                containerId,
                type: "WORKFLOW",
                runId: runId,
            });

            await notifyStepStatus({
                stepId: "analyzeRepositoryStep",
                status: "failed",
                runId,
                containerId,
                title: "Analyze repository failed",
                subtitle: getErrorMessage(error),
                level: 'error',
                toolCallCount: cliToolMetrics.callCount,
            });

            logger?.warn?.("🔄 Using fallback repository structure", {
                step: "1/6",
                action: "fallback",
                type: "WORKFLOW",
                runId: runId,
            });

            // Return minimal fallback structure
            return {
                containerId,
                repository: {
                    type: "single-package" as const,
                    rootPath: "/app",
                    gitStatus: {
                        isGitRepo: false,
                        defaultBranch: null,
                        lastCommit: null,
                        hasRemote: false,
                        isDirty: false,
                    },
                    structure: {
                        packages: [],
                        keyDirectories: [],
                        ignoredPaths: ["node_modules", ".git", "build", "dist", ".next", ".venv", "target"],
                    },
                    languages: [],
                },
                projectId: inputData.projectId,
            };
        }
    },
});

// =============================================================================
// STEP 2: ANALYZE CODEBASE
// =============================================================================

export const analyzeCodebaseStep = createStep({
    id: "analyzeCodebaseStep",
    inputSchema: WorkflowInputSchema,
    outputSchema: AnalyzeCodebaseOutputSchema,
    execute: async ({ inputData, mastra, runId }) => {
        const { containerId } = inputData;
        const repoPath = inputData.repoPath || '';
        const logger = ALERTS_ONLY ? null : mastra?.getLogger() as Logger | undefined;
        await notifyStepStatus({
            stepId: "analyzeCodebaseStep",
            status: "starting",
            runId,
            containerId,
            title: "Analyze codebase",
            subtitle: "Focused codebase scan starting",
        });
        
        logger?.info?.("📊 Starting focused codebase scan", {
            step: "2/6",
            stepName: "Codebase Analysis",
            containerId,
            startTime: new Date().toISOString(),
            type: "WORKFLOW",
            runId: runId,
        });

        const prompt = `FAST codebase scan using docker_exec with containerId='${containerId}'. Focus on speed over completeness.

RAPID WORKFLOW (6 commands max):
1. Dependencies: docker_exec REPO_DIR=$( if [ -n '${repoPath}' ] && [ -d '${repoPath}/.git' ]; then echo '${repoPath}'; else for d in /app/*; do if [ -d "$d/.git" ]; then echo "$d"; break; fi; done; fi ); cd "\${REPO_DIR:-/app}"; if [ -f package.json ]; then grep -E '"(@mastra|vitest|jest)"' package.json || true; else echo "NO_PACKAGE_JSON"; fi
2. Source scan: docker_exec REPO_DIR=$( if [ -n '${repoPath}' ] && [ -d '${repoPath}/.git' ]; then echo '${repoPath}'; else for d in /app/*; do if [ -d "$d/.git" ]; then echo "$d"; break; fi; done; fi ); cd "\${REPO_DIR:-/app}"; if [ -d src ]; then ls -la src/; else echo "NO_SRC"; fi
3. Main modules: docker_exec REPO_DIR=$( if [ -n '${repoPath}' ] && [ -d '${repoPath}/.git' ]; then echo '${repoPath}'; else for d in /app/*; do if [ -d "$d/.git" ]; then echo "$d"; break; fi; done; fi ); cd "\${REPO_DIR:-/app}"; if [ -d src ]; then find src -type d -maxdepth 2; else echo "NO_SRC"; fi
4. Test check: docker_exec REPO_DIR=$( if [ -n '${repoPath}' ] && [ -d '${repoPath}/.git' ]; then echo '${repoPath}'; else for d in /app/*; do if [ -d "$d/.git" ]; then echo "$d"; break; fi; done; fi ); cd "\${REPO_DIR:-/app}"; ls *test* *spec* 2>/dev/null || echo "NO_TESTS"
5. Config files: docker_exec REPO_DIR=$( if [ -n '${repoPath}' ] && [ -d '${repoPath}/.git' ]; then echo '${repoPath}'; else for d in /app/*; do if [ -d "$d/.git" ]; then echo "$d"; break; fi; done; fi ); cd "\${REPO_DIR:-/app}"; ls *.json *.config.* 2>/dev/null || echo "NO_CONFIG"
6. TypeScript: docker_exec REPO_DIR=$( if [ -n '${repoPath}' ] && [ -d '${repoPath}/.git' ]; then echo '${repoPath}'; else for d in /app/*; do if [ -d "$d/.git" ]; then echo "$d"; break; fi; done; fi ); cd "\${REPO_DIR:-/app}"; if [ -d src ]; then find src -name "*.ts" | wc -l; else echo 0; fi

IMMEDIATE JSON RESPONSE:
{
  "architecture": {
    "pattern": "modular",
    "entryPoints": ["src/mastra/index.ts"],
    "mainModules": [{"path": "src/mastra", "purpose": "mastra framework code"}],
    "dependencies": {
      "internal": [],
      "external": {"@mastra/core": "latest"},
      "keyLibraries": [{"name": "@mastra/core", "purpose": "AI workflow framework", "version": "latest"}]
    }
  },
  "codeQuality": {
    "hasTests": false,
    "testCoverage": null,
    "linting": ["typescript"],
    "formatting": [],
    "documentation": {"hasReadme": true, "hasApiDocs": false, "codeComments": "minimal"}
  },
  "frameworks": [{"name": "Mastra", "version": "latest", "purpose": "AI workflow framework", "configFiles": ["tsconfig.json"]}]
}`;
        
        try {
            logger?.info?.("🔬 Quick dependency and framework scan", {
                step: "2/6",
                action: "agent-call",
                agentType: "contextAgent",
                focus: "architecture and dependencies",
                type: "WORKFLOW",
                runId: runId,
            });

            const result = await withRetryAndAlerts({
                stepId: "analyzeCodebaseStep",
                containerId,
                runId,
                logger,
                maxAttempts: 3,
                titleOnRetry: "Analyze codebase retry",
                attempt: () => callContextAgentForAnalysis(prompt, CodebaseAnalysisSchema, 6, runId, logger),
            });
            
            logger?.info?.("✅ Codebase scan completed efficiently", {
                step: "2/6",
                stepName: "Codebase Analysis",
                duration: "completed",
                architecturePattern: result.architecture.pattern,
                entryPointsFound: result.architecture.entryPoints.length,
                frameworksDetected: result.frameworks.length,
                hasTests: result.codeQuality.hasTests,
                keyLibrariesCount: result.architecture.dependencies.keyLibraries.length,
                type: "WORKFLOW",
                runId: runId,
            });

            await notifyStepStatus({
                stepId: "analyzeCodebaseStep",
                status: "completed",
                runId,
                containerId,
                title: "Analyze codebase completed",
                subtitle: `Frameworks: ${result.frameworks.length}`,
                toolCallCount: cliToolMetrics.callCount,
            });

            return {
                containerId,
                codebase: result,
                projectId: inputData.projectId,
            };
        } catch (error) {
            logger?.error?.("❌ Codebase analysis failed", {
                step: "2/6",
                stepName: "Codebase Analysis",
                error: getErrorMessage(error),
                containerId,
                type: "WORKFLOW",
                runId: runId,
            });

            await notifyStepStatus({
                stepId: "analyzeCodebaseStep",
                status: "failed",
                runId,
                containerId,
                title: "Analyze codebase failed",
                subtitle: getErrorMessage(error),
                level: 'error',
                toolCallCount: cliToolMetrics.callCount,
            });

            logger?.warn?.("🔄 Using fallback codebase structure", {
                step: "2/6",
                action: "fallback",
                type: "WORKFLOW",
                runId: runId,
            });

            return {
                containerId,
                codebase: {
                    architecture: {
                        pattern: "unknown",
                        entryPoints: [],
                        mainModules: [],
                        dependencies: {
                            internal: [],
                            external: {},
                            keyLibraries: [],
                        },
                    },
                    codeQuality: {
                        hasTests: false,
                        testCoverage: null,
                        linting: [],
                        formatting: [],
                        documentation: {
                            hasReadme: false,
                            hasApiDocs: false,
                            codeComments: "none" as const,
                        },
                    },
                    frameworks: [],
                },
                projectId: inputData.projectId,
            };
        }
    },
});

// =============================================================================
// STEP 3: ANALYZE BUILD & DEPLOYMENT
// =============================================================================

export const analyzeBuildDeploymentStep = createStep({
    id: "analyzeBuildDeploymentStep",
    inputSchema: WorkflowInputSchema,
    outputSchema: AnalyzeBuildDeploymentOutputSchema,
    execute: async ({ inputData, mastra, runId }) => {
        const { containerId } = inputData;
        const repoPath = inputData.repoPath || '';
        const logger = ALERTS_ONLY ? null : mastra?.getLogger() as Logger | undefined;
        await notifyStepStatus({
            stepId: "analyzeBuildDeploymentStep",
            status: "starting",
            runId,
            containerId,
            title: "Analyze build & deployment",
            subtitle: "DevOps scan starting",
        });
        
        logger?.info?.("🏗️ Starting fast build system scan", {
            step: "3/6",
            stepName: "Build & Deployment Analysis",
            containerId,
            startTime: new Date().toISOString(),
            type: "WORKFLOW",
            runId: runId,
        });

        const prompt = `LIGHTNING DevOps scan using docker_exec with containerId='${containerId}'. Maximum 4 commands.

SPEED WORKFLOW:
1. Package manager: docker_exec REPO_DIR=$( if [ -n '${repoPath}' ] && [ -d '${repoPath}/.git' ]; then echo '${repoPath}'; else for d in /app/*; do if [ -d "$d/.git" ]; then echo "$d"; break; fi; done; fi ); cd "\${REPO_DIR:-/app}"; ls package-lock.json yarn.lock pnpm-lock.yaml 2>/dev/null || echo "NONE"
2. Scripts: docker_exec REPO_DIR=$( if [ -n '${repoPath}' ] && [ -d '${repoPath}/.git' ]; then echo '${repoPath}'; else for d in /app/*; do if [ -d "$d/.git" ]; then echo "$d"; break; fi; done; fi ); cd "\${REPO_DIR:-/app}"; if [ -f package.json ]; then grep -A3 '"scripts"' package.json || true; else echo "NO_PACKAGE_JSON"; fi
3. CI/CD: docker_exec REPO_DIR=$( if [ -n '${repoPath}' ] && [ -d '${repoPath}/.git' ]; then echo '${repoPath}'; else for d in /app/*; do if [ -d "$d/.git" ]; then echo "$d"; break; fi; done; fi ); cd "\${REPO_DIR:-/app}"; ls .github/workflows/ 2>/dev/null || echo "NO_CI"
4. Docker: docker_exec REPO_DIR=$( if [ -n '${repoPath}' ] && [ -d '${repoPath}/.git' ]; then echo '${repoPath}'; else for d in /app/*; do if [ -d "$d/.git" ]; then echo "$d"; break; fi; done; fi ); cd "\${REPO_DIR:-/app}"; ls Dockerfile* docker-compose* 2>/dev/null || echo "NO_DOCKER"

INSTANT JSON:
{
  "buildSystem": {
    "type": "npm",
    "configFiles": ["package.json"],
    "buildCommands": ["npm run build"],
    "buildAttempts": []
  },
  "packageManagement": {
    "managers": ["npm"],
    "lockFiles": ["package-lock.json"],
    "workspaceConfig": null
  },
  "testing": {
    "frameworks": ["vitest"],
    "testDirs": ["tests"],
    "testCommands": ["npm test"],
    "testAttempts": []
  },
  "deployment": {
    "cicd": [],
    "dockerfiles": [],
    "deploymentConfigs": [],
    "environmentConfig": {"envFiles": [], "requiredVars": []}
  }
}`;
        
        try {
            logger?.info?.("🚀 Quick build and deployment check", {
                step: "3/6",
                action: "agent-call",
                agentType: "contextAgent",
                focus: "DevOps and deployment",
                type: "WORKFLOW",
                runId: runId,
            });

            const result = await withRetryAndAlerts({
                stepId: "analyzeBuildDeploymentStep",
                containerId,
                runId,
                logger,
                maxAttempts: 3,
                titleOnRetry: "Analyze build & deployment retry",
                attempt: () => callContextAgentForAnalysis(prompt, BuildAndDeploymentSchema, 4, runId, logger),
            });
            
            logger?.info?.("✅ Build system scan completed rapidly", {
                step: "3/6",
                stepName: "Build & Deployment Analysis",
                duration: "completed",
                buildSystemType: result.buildSystem.type,
                packageManagers: result.packageManagement.managers,
                testFrameworks: result.testing.frameworks,
                cicdProviders: result.deployment.cicd,
                buildCommandsCount: result.buildSystem.buildCommands.length,
                buildAttempts: result.buildSystem.buildAttempts.length,
                type: "WORKFLOW",
                runId: runId,
            });

            await notifyStepStatus({
                stepId: "analyzeBuildDeploymentStep",
                status: "completed",
                runId,
                containerId,
                title: "Analyze build & deployment completed",
                subtitle: `Build system: ${result.buildSystem.type || 'unknown'}`,
                toolCallCount: cliToolMetrics.callCount,
            });

            return {
                containerId,
                buildDeploy: result,
                projectId: inputData.projectId,
            };
        } catch (error) {
            logger?.error?.("❌ Build and deployment analysis failed", {
                step: "3/6",
                stepName: "Build & Deployment Analysis",
                error: getErrorMessage(error),
                containerId,
                type: "WORKFLOW",
                runId: runId,
            });

            await notifyStepStatus({
                stepId: "analyzeBuildDeploymentStep",
                status: "failed",
                runId,
                containerId,
                title: "Analyze build & deployment failed",
                subtitle: getErrorMessage(error),
                level: 'error',
                toolCallCount: cliToolMetrics.callCount,
            });

            logger?.warn?.("🔄 Using fallback build deployment structure", {
                step: "3/6",
                action: "fallback",
                type: "WORKFLOW",
                runId: runId,
            });

            return {
                containerId,
                buildDeploy: {
                    buildSystem: {
                        type: "unknown" as const,
                        configFiles: [],
                        buildCommands: [],
                        buildAttempts: [],
                    },
                    packageManagement: {
                        managers: [],
                        lockFiles: [],
                        workspaceConfig: null,
                    },
                    testing: {
                        frameworks: [],
                        testDirs: [],
                        testCommands: [],
                        testAttempts: [],
                    },
                    deployment: {
                        cicd: [],
                        dockerfiles: [],
                        deploymentConfigs: [],
                        environmentConfig: {
                            envFiles: [],
                            requiredVars: [],
                        },
                    },
                },
                projectId: inputData.projectId,
            };
        }
    },
});

// =============================================================================
// STEP 4: SYNTHESIZE CONTEXT
// =============================================================================

export const synthesizeContextStep = createStep({
    id: "synthesizeContextStep",
    inputSchema: ParallelAnalysisInputSchema,
    outputSchema: SynthesizeContextOutputSchema,
    execute: async ({ inputData, mastra, runId }) => {
        // Extract results from parallel execution
        const repository = inputData["analyzeRepositoryStep"].repository;
        const codebase = inputData["analyzeCodebaseStep"].codebase;
        const buildDeploy = inputData["analyzeBuildDeploymentStep"].buildDeploy;
        const containerId = inputData["analyzeRepositoryStep"].containerId;
        const logger = ALERTS_ONLY ? null : mastra?.getLogger() as Logger | undefined;
        await notifyStepStatus({
            stepId: "synthesizeContextStep",
            status: "starting",
            runId,
            containerId,
            title: "Synthesize context",
            subtitle: "Generating insights and executive summary",
        });
        
        logger?.info?.("🧠 Starting context synthesis and insights generation", {
            step: "4/6",
            stepName: "Context Synthesis",
            repositoryType: repository.type,
            architecturePattern: codebase.architecture.pattern,
            buildSystemType: buildDeploy.buildSystem.type,
            totalDataPoints: {
                packages: repository.structure.packages.length,
                frameworks: codebase.frameworks.length,
                buildCommands: buildDeploy.buildSystem.buildCommands.length,
                testFrameworks: buildDeploy.testing.frameworks.length,
            },
            startTime: new Date().toISOString(),
            type: "WORKFLOW",
            runId: runId,
        });
        
        const prompt = `You are a senior technical lead providing an executive summary and insights about a codebase.

Repository Analysis:
${JSON.stringify(repository, null, 2)}

Codebase Analysis:
${JSON.stringify(codebase, null, 2)}

Build & Deployment Analysis:
${JSON.stringify(buildDeploy, null, 2)}

TASK: Synthesize insights and provide executive summary as a senior engineer would.

Instructions:
1. Assess complexity based on architecture, dependencies, and codebase size
2. Determine maturity level based on testing, documentation, and tooling
3. Evaluate maintainability based on code quality, structure, and practices
4. Provide actionable recommendations
5. Identify potential issues and technical debt
6. Highlight strengths and weaknesses
7. Write a professional executive summary (2-3 paragraphs)
8. Assign confidence scores (0-1) for each analysis area

Return strictly JSON matching this schema:
{
  "repository": <repository_data>,
  "codebase": <codebase_data>,
  "buildDeploy": <buildDeploy_data>,
  "insights": {
    "complexity": "simple|moderate|complex|very-complex",
    "maturity": "prototype|development|production|mature",
    "maintainability": "excellent|good|fair|poor",
    "recommendations": ["Add comprehensive tests", "Improve documentation"],
    "potentialIssues": ["Missing error handling", "No type safety"],
    "strengthsWeaknesses": {
      "strengths": ["Modern tech stack", "Good project structure"],
      "weaknesses": ["Limited testing", "No CI/CD pipeline"]
    }
  },
  "confidence": {
    "repository": 0.9,
    "codebase": 0.8,
    "buildDeploy": 0.7,
    "overall": 0.8
  },
  "executiveSummary": "This is a well-structured TypeScript project..."
}`;
        
        try {
            logger?.info?.("💡 Generating insights and executive summary", {
                step: "4/6",
                action: "agent-call",
                agentType: "contextAgent",
                focus: "technical leadership insights",
                type: "WORKFLOW",
                runId: runId,
            });

            const result = await callContextAgentForAnalysis(prompt, RepoContextSchema, 10, runId, logger);
            
            logger?.info?.("✅ Context synthesis completed successfully", {
                step: "4/6",
                stepName: "Context Synthesis",
                duration: "completed",
                insights: {
                    complexity: result.insights.complexity,
                    maturity: result.insights.maturity,
                    maintainability: result.insights.maintainability,
                    recommendationsCount: result.insights.recommendations.length,
                    potentialIssuesCount: result.insights.potentialIssues.length,
                    strengthsCount: result.insights.strengthsWeaknesses.strengths.length,
                    weaknessesCount: result.insights.strengthsWeaknesses.weaknesses.length,
                },
                confidence: result.confidence,
                type: "WORKFLOW",
                runId: runId,
            });

            await notifyStepStatus({
                stepId: "synthesizeContextStep",
                status: "completed",
                runId,
                containerId,
                title: "Synthesize context completed",
                subtitle: `Summary length: ${result.executiveSummary.length}`,
                toolCallCount: cliToolMetrics.callCount,
            });

            return { ...result, containerId, projectId: inputData["analyzeRepositoryStep"].projectId };
        } catch (error) {
            logger?.error?.("❌ Context synthesis failed", {
                step: "4/6",
                stepName: "Context Synthesis",
                error: getErrorMessage(error),
                type: "WORKFLOW",
                runId: runId,
            });

            await notifyStepStatus({
                stepId: "synthesizeContextStep",
                status: "failed",
                runId,
                containerId,
                title: "Synthesize context failed",
                subtitle: getErrorMessage(error),
                level: 'error',
                toolCallCount: cliToolMetrics.callCount,
            });

            logger?.warn?.("🔄 Using fallback insights and summary", {
                step: "4/6",
                action: "fallback",
                type: "WORKFLOW",
                runId: runId,
            });

            return {
                containerId,
                repository,
                codebase,
                buildDeploy,
                insights: {
                    complexity: "moderate" as const,
                    maturity: "development" as const,
                    maintainability: "fair" as const,
                    recommendations: ["Complete the codebase analysis", "Implement proper error handling"],
                    potentialIssues: ["Incomplete analysis due to technical issues"],
                    strengthsWeaknesses: {
                        strengths: ["Project structure is present"],
                        weaknesses: ["Analysis was incomplete due to technical issues"],
                    },
                },
                confidence: {
                    repository: 0.3,
                    codebase: 0.2,
                    buildDeploy: 0.2,
                    overall: 0.2,
                },
                executiveSummary: "Analysis was incomplete due to technical issues during the codebase examination. The repository structure was partially analyzed, but a more thorough investigation would be needed to provide accurate insights and recommendations.",
                projectId: inputData["analyzeRepositoryStep"].projectId,
            };
        }
    },
});

// =============================================================================
// STEP 5: SAVE CONTEXT
// =============================================================================

export const saveContextStep = createStep({
    id: "saveContextStep",
    inputSchema: SynthesizeContextOutputSchema,
    outputSchema: SaveContextOutputSchema,
    execute: async ({ inputData, mastra, runId }) => {
        const logger = ALERTS_ONLY ? null : mastra?.getLogger() as Logger | undefined;
        await notifyStepStatus({
            stepId: "saveContextStep",
            status: "starting",
            runId,
            containerId: inputData.containerId,
            title: "Save unit test context",
            subtitle: "Writing agent.context.json",
        });
        
        logger?.info?.("💾 Saving context for unit test generation", {
            step: "5/6",
            stepName: "Save Unit Test Context",
            startTime: new Date().toISOString(),
            type: "WORKFLOW",
            runId: runId,
        });

        const { containerId, projectId, ...repoContextData } = inputData;
        const parsed = RepoContextSchema.parse(repoContextData);

        // Enhanced context specifically for unit testing
        const unitTestContext = {
            // Core repository information
            metadata: {
                projectName: parsed.repository.structure.packages[0]?.name || "unknown",
                projectType: parsed.repository.type,
                primaryLanguage: parsed.repository.languages[0]?.language || "typescript",
                rootPath: parsed.repository.rootPath,
                isGitRepo: parsed.repository.gitStatus.isGitRepo,
                generatedAt: new Date().toISOString(),
                confidence: parsed.confidence.overall,
            },

            // File structure for test generation
            structure: {
                sourceDirectories: parsed.repository.structure.keyDirectories,
                packages: parsed.repository.structure.packages,
                testingFramework: parsed.buildDeploy.testing.frameworks[0] || "jest",
                entryPoints: parsed.codebase.architecture.entryPoints,
                mainModules: parsed.codebase.architecture.mainModules,
            },

            // Dependencies and frameworks that affect testing
            dependencies: {
                keyLibraries: parsed.codebase.architecture.dependencies.keyLibraries,
                external: parsed.codebase.architecture.dependencies.external,
                frameworks: parsed.codebase.frameworks,
                packageManager: parsed.buildDeploy.packageManagement.managers[0] || "npm",
            },

            // Testing strategy based on architecture
            testingStrategy: {
                architecturePattern: parsed.codebase.architecture.pattern,
                complexity: parsed.insights.complexity,
                hasExistingTests: parsed.codebase.codeQuality.hasTests,
                testCommands: parsed.buildDeploy.testing.testCommands,
                recommendedApproach: parsed.insights.complexity === "simple" ? "unit-focused" : "integration-included",
            },

            // Code quality indicators that affect test design
            codeQuality: {
                hasTypeScript: parsed.repository.languages.some(l => l.language === "typescript"),
                hasLinting: parsed.codebase.codeQuality.linting.length > 0,
                codeComments: parsed.codebase.codeQuality.documentation.codeComments,
                maintainability: parsed.insights.maintainability,
            },

            // Recommendations specific to testing
            testingRecommendations: parsed.insights.recommendations.filter(rec => 
                rec.toLowerCase().includes('test') || 
                rec.toLowerCase().includes('ci') || 
                rec.toLowerCase().includes('error')
            ),

            // Full context for reference
            fullAnalysis: parsed,
        };

        const contextJson = JSON.stringify(unitTestContext, null, 2);
        const contextPath = "/app/agent.context.json";

        try {
            // Write context JSON to a temp file and copy into the Docker container for reliability
            return await new Promise<z.infer<typeof SaveContextOutputSchema>>((resolve, reject) => {
                let tempFilePath: string | null = null;

                try {
                    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'docker-context-'));
                    tempFilePath = path.join(tempDir, 'agent.context.json');
                    writeFileSync(tempFilePath, contextJson, 'utf8');

                    logger?.info?.("🐳 Copying context file into Docker container", {
                        step: "5/6",
                        action: "docker-cp",
                        path: contextPath,
                        sizeBytes: contextJson.length,
                        type: "WORKFLOW",
                        runId: runId,
                    });

                    const copyCmd = `docker cp "${tempFilePath}" ${containerId}:${contextPath}`;
                    exec(copyCmd, (copyError, _copyStdout, copyStderr) => {
                        // Always try to cleanup temp file
                        if (tempFilePath) {
                            try { unlinkSync(tempFilePath); } catch { /* ignore */ }
                        }

                        if (copyError) {
                            logger?.error?.("❌ Failed to copy context file to container", {
                                error: copyStderr || copyError.message,
                                type: "WORKFLOW",
                                runId: runId,
                            });
                            reject(new Error(copyStderr || copyError.message));
                            return;
                        }

                        const verifyCmd = `docker exec ${containerId} bash -lc "test -f ${contextPath} && wc -c ${contextPath}"`;
                        exec(verifyCmd, (verifyError, verifyStdout, verifyStderr) => {
                            if (verifyError) {
                                logger?.error?.("❌ Context file verification failed", {
                                    error: verifyStderr || verifyError.message,
                                    type: "WORKFLOW",
                                    runId: runId,
                                });
                                reject(new Error(verifyStderr || verifyError.message));
                                return;
                            }

                            const fileSize = verifyStdout.trim().split(' ')[0] || '0';
                            logger?.info?.("✅ Context file saved to container", {
                                step: "5/6",
                                contextPath,
                                fileSize: `${parseInt(fileSize)} bytes`,
                                contextSize: `${Math.round(contextJson.length / 1024)}KB`,
                                testingFocus: {
                                    primaryLanguage: unitTestContext.metadata.primaryLanguage,
                                    testingFramework: unitTestContext.structure.testingFramework,
                                    architecturePattern: unitTestContext.testingStrategy.architecturePattern,
                                    recommendedApproach: unitTestContext.testingStrategy.recommendedApproach,
                                },
                                type: "WORKFLOW",
                                runId: runId,
                            });

                            notifyStepStatus({
                                stepId: "saveContextStep",
                                status: "completed",
                                runId,
                                containerId,
                                contextPath,
                                title: "Saved unit test context",
                                subtitle: `Path: ${contextPath}`,
                                toolCallCount: cliToolMetrics.callCount,
                            });

                            resolve({
                                containerId,
                                contextPath,
                                repoContext: parsed,
                                projectId,
                            });
                        });
                    });
                } catch (tempError) {
                    // Cleanup temp file if present
                    if (tempFilePath) {
                        try { unlinkSync(tempFilePath); } catch { /* ignore */ }
                    }
                    reject(tempError instanceof Error ? tempError : new Error('Unknown temp file error'));
                }
            });
        } catch (error) {
            logger?.error?.("❌ Failed to save context file", {
                step: "5/6",
                stepName: "Save Unit Test Context",
                error: getErrorMessage(error),
                contextPath,
                type: "WORKFLOW",
                runId: runId,
            });

            logger?.warn?.("🔄 Continuing without saved context file", {
                step: "5/6",
                action: "continue-without-file",
                type: "WORKFLOW",
                runId: runId,
            });

            await notifyStepStatus({
                stepId: "saveContextStep",
                status: "failed",
                runId,
                containerId: inputData.containerId,
                contextPath,
                title: "Save unit test context failed",
                subtitle: getErrorMessage(error),
                level: 'error',
                toolCallCount: cliToolMetrics.callCount,
            });

            return {
                containerId,
                contextPath: "not-saved",
                repoContext: parsed,
                projectId,
            };
        }
    },
});

// =============================================================================
// STEP 6: VALIDATE AND RETURN
// =============================================================================

export const validateContextStep = createStep({
    id: "validateContextStep",
    inputSchema: SaveContextOutputSchema,
    outputSchema: ValidateOutputSchema,
    execute: async ({ inputData, mastra, runId }) => {
        const logger = ALERTS_ONLY ? null : mastra?.getLogger() as Logger | undefined;
        await notifyStepStatus({
            stepId: "validateContextStep",
            status: "starting",
            runId,
            containerId: inputData.containerId,
            title: "Validate and summarize",
            subtitle: "Final validation starting",
        });
        
        logger?.info?.("🔍 Starting final validation and summary", {
            step: "6/6",
            stepName: "Validation & Summary",
            startTime: new Date().toISOString(),
            type: "WORKFLOW",
            runId: runId,
        });

        try {
            const { containerId, contextPath, repoContext } = inputData;
            const parsed = RepoContextSchema.parse(repoContext);
            
            logger?.info?.("📋 Workflow execution summary", {
                step: "6/6",
                stepName: "Validation & Summary",
                totalToolCalls: cliToolMetrics.callCount,
                contextSaved: contextPath !== "not-saved",
                contextPath,
                analysis: {
                    repositoryType: parsed.repository.type,
                    gitRepository: parsed.repository.gitStatus.isGitRepo,
                    languagesDetected: parsed.repository.languages.length,
                    packagesFound: parsed.repository.structure.packages.length,
                    architecturePattern: parsed.codebase.architecture.pattern,
                    frameworksDetected: parsed.codebase.frameworks.length,
                    hasTests: parsed.codebase.codeQuality.hasTests,
                    buildSystemType: parsed.buildDeploy.buildSystem.type,
                    cicdProviders: parsed.buildDeploy.deployment.cicd.length,
                    complexity: parsed.insights.complexity,
                    maturity: parsed.insights.maturity,
                    maintainability: parsed.insights.maintainability,
                    recommendationsCount: parsed.insights.recommendations.length,
                    overallConfidence: parsed.confidence.overall,
                },
                type: "WORKFLOW",
                runId: runId,
            });

            logger?.info?.("✅ Repository context analysis completed successfully", {
                step: "6/6",
                stepName: "Validation & Summary",
                duration: "completed",
                success: true,
                executiveSummaryLength: parsed.executiveSummary.length,
                readyForUnitTests: true,
                type: "WORKFLOW",
                runId: runId,
            });

            await notifyStepStatus({
                stepId: "validateContextStep",
                status: "completed",
                runId,
                containerId: inputData.containerId,
                title: "Validation completed",
                subtitle: "Context ready for unit tests",
                toolCallCount: cliToolMetrics.callCount,
            });

            return {
                result: "Repository context analysis complete and saved for unit testing",
                success: true,
                toolCallCount: cliToolMetrics.callCount,
                contextPath,
                repoContext: parsed,
                projectId: inputData.projectId,
            };
        } catch (error) {
            logger?.error?.("❌ Final validation failed", {
                step: "6/6",
                stepName: "Validation & Summary",
                error: getErrorMessage(error),
                type: "WORKFLOW",
                runId: runId,
            });

            await notifyStepStatus({
                stepId: "validateContextStep",
                status: "failed",
                runId,
                containerId: inputData.containerId,
                title: "Validation failed",
                subtitle: getErrorMessage(error),
                level: 'error',
                toolCallCount: cliToolMetrics.callCount,
            });

            throw new Error(`Validation failed: ${getErrorMessage(error)}`);
        }
    }
});

// =============================================================================
// WORKFLOW START STEP
// =============================================================================

export const contextGatheringStartStep = createStep({
    id: "contextGatheringStartStep", 
    inputSchema: WorkflowInputSchema,
    outputSchema: WorkflowInputSchema,
    execute: async ({ inputData, mastra, runId }) => {
        const logger = ALERTS_ONLY ? null : mastra?.getLogger() as Logger | undefined;
        await notifyStepStatus({
            stepId: "contextGatheringStartStep",
            status: "starting",
            runId,
            containerId: inputData.containerId,
            title: "Gather workflow start",
            subtitle: "Planning and setup",
        });
        
        logger?.info?.("🚀 Starting fast repository context workflow", {
            workflowId: "contextGatheringWorkflow",
            workflowName: "Fast Repository Context Analysis",
            containerId: inputData.containerId,
            totalSteps: 6,
            optimized: "for speed and unit test generation",
            startTime: new Date().toISOString(),
            type: "WORKFLOW_START",
            runId: runId,
        });

        logger?.info?.("📋 Fast workflow execution plan", {
            steps: [
                "1/6: Workflow Start - Log execution plan & setup",
                "2/6: Parallel Analysis - Repository, Codebase & Build scans (concurrent)",
                "3/6: Context Synthesis - Insights and executive summary",
                "4/6: Save Unit Test Context - Write context to agent.context.json",
                "5/6: Validation & Summary - Final validation and results"
            ],
            approach: "parallel execution for 3x speed improvement, optimized for unit test generation",
            estimatedDuration: "15-45 seconds",
            parallelSteps: ["Repository Scan", "Codebase Scan", "Build System Scan"],
            type: "WORKFLOW_PLAN",
            runId: runId,
        });

        await notifyStepStatus({
            stepId: "contextGatheringStartStep",
            status: "completed",
            runId,
            containerId: inputData.containerId,
            title: "Gather workflow initialized",
            subtitle: "Plan logged",
            toolCallCount: cliToolMetrics.callCount,
        });

        return inputData;
    },
});

// =============================================================================
// WORKFLOW DEFINITION
// =============================================================================

export const contextGatheringWorkflow = createWorkflow({
    id: "contextGatheringWorkflow",
    description: "Ultra-fast parallel repository analysis optimized for unit test generation with context saved to agent.context.json",
    inputSchema: WorkflowInputSchema,
    outputSchema: ValidateOutputSchema,
})
.then(contextGatheringStartStep)
.parallel([analyzeRepositoryStep, analyzeCodebaseStep, analyzeBuildDeploymentStep])
.then(synthesizeContextStep)
.then(saveContextStep)
.then(validateContextStep)
.commit();
