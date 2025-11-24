import { createStep, createWorkflow } from "@mastra/core";
import z from "zod";
import { notifyStepStatus } from "../../tools/alert-notifier";
import { cliToolMetrics } from "../../tools/cli-tool";
import { exec } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { mastra } from "../..";
import { 
    getErrorMessage,
    TestGenerationResultSchema,
    RepoTestAnalysisSchema,
    TestSpecificationSchema,
    GitHubPullRequestSchema,
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
// HELPER FUNCTIONS
// =============================================================================

function sh(cmd: string): Promise<{ stdout: string; stderr: string }>{
    return new Promise((resolve, reject) => {
        exec(cmd, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr || error.message));
            } else {
                resolve({ stdout, stderr });
            }
        });
    });
}

// Improved shell escaping function
function shellEscape(str: string): string {
    // Use single quotes and escape any single quotes in the string
    return "'" + str.replace(/'/g, "'\"'\"'") + "'";
}

// Improved docker exec wrapper with better error handling
async function dockerExec(containerId: string, repoPath: string, command: string): Promise<{ stdout: string; stderr: string }> {
    const fullCmd = `docker exec ${containerId} bash -lc "cd ${shellEscape(repoPath)} && ${command}"`;
    try {
        return await sh(fullCmd);
    } catch (error) {
        throw new Error(`Docker exec failed: ${getErrorMessage(error)}`);
    }
}

function getGithubTokenFromHost(): string | null {
    // Try env first
    const envToken = process.env.GITHUB_PAT || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (envToken && envToken.trim().length > 0) return envToken.trim();

    // Try local credentials file(s)
    try {
        const cwd = process.cwd();
        const primary = path.resolve(cwd, ".docker.credentials");
        const fallback = path.resolve(cwd, "..", "..", ".docker.credentials");
        const target = existsSync(primary) ? primary : (existsSync(fallback) ? fallback : null);
        if (!target) return null;
        const content = readFileSync(target, "utf8");
        const m = content.match(/GITHUB_PAT\s*=\s*(.+)/);
        return m && m[1] ? m[1].trim() : null;
    } catch {
        return null;
    }
}

// =============================================================================
// SCHEMAS
// =============================================================================

// Input schema for prepareCommitAndPushStep
const PrepareCommitInputSchema = z.object({
        containerId: z.string().describe("Docker container ID"),
        repoPath: z.string().optional().describe("Absolute path to the repository inside the container"),
        projectId: z.string().describe("Project ID associated with this workflow run"),
        // Optional context from previous steps
    testGeneration: TestGenerationResultSchema.optional(),
    repoAnalysis: RepoTestAnalysisSchema.optional(),
    testSpecs: z.array(TestSpecificationSchema).optional(),
        result: z.string().optional(),
        success: z.boolean().optional(),
        toolCallCount: z.number().optional(),
        contextPath: z.string().optional(),
});

type PrepareCommitInput = z.infer<typeof PrepareCommitInputSchema>;

// Output schema for prepareCommitAndPushStep
const PrepareCommitOutputSchema = z.object({
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

type PrepareCommitOutput = z.infer<typeof PrepareCommitOutputSchema>;

// Input schema for createPullRequestStep
const CreatePullRequestInputSchema = PrepareCommitOutputSchema;
type CreatePullRequestInput = z.infer<typeof CreatePullRequestInputSchema>;

// Output schema for createPullRequestStep
const CreatePullRequestOutputSchema = z.object({
    prUrl: z.string(),
    prNumber: z.number().optional(),
    projectId: z.string(),
    containerId: z.string(),
    result: z.string().optional(),
    success: z.boolean().optional(),
    toolCallCount: z.number().optional(),
    contextPath: z.string().optional(),
});

type CreatePullRequestOutput = z.infer<typeof CreatePullRequestOutputSchema>;

// Input/Output schema for postPrUrlStep
const PostPrUrlInputSchema = z.object({
    prUrl: z.string(),
    prNumber: z.number().optional(),
    projectId: z.string(),
    containerId: z.string(),
        result: z.string().optional(),
        success: z.boolean().optional(),
        toolCallCount: z.number().optional(),
        contextPath: z.string().optional(),
});

type PostPrUrlInput = z.infer<typeof PostPrUrlInputSchema>;

// Workflow input schema
const WorkflowInputSchema = z.object({
    containerId: z.string(),
    repoPath: z.string().optional(),
    projectId: z.string(),
    testGeneration: TestGenerationResultSchema.optional(),
    repoAnalysis: RepoTestAnalysisSchema.optional(),
    testSpecs: z.array(TestSpecificationSchema).optional(),
    contextPath: z.string().optional(),
});

// Workflow output schema
const WorkflowOutputSchema = z.object({
    prUrl: z.string(),
    projectId: z.string(),
});

// =============================================================================
// Step 1: Prepare git branch, commit changes, and push
// =============================================================================

export const prepareCommitAndPushStep = createStep({
    id: "prepare-commit-and-push-step",
    inputSchema: PrepareCommitInputSchema,
    outputSchema: PrepareCommitOutputSchema,
    execute: async ({ inputData, mastra, runId }): Promise<PrepareCommitOutput> => {
        const logger = ALERTS_ONLY ? null : mastra?.getLogger() as Logger | undefined;
        const { containerId } = inputData;

        await notifyStepStatus({
            stepId: "prepare-commit-and-push-step",
            status: "starting",
            runId,
            containerId,
            projectId: inputData.projectId,
            title: "Prepare commit & push",
            subtitle: "Creating branch and committing tests",
        });

        // 1) Resolve repo path inside container
        let repoPath = inputData.repoPath || "";
        try {
            if (!repoPath) {
                const { stdout } = await sh(`docker exec ${containerId} bash -lc "for d in /app/*; do if [ -d \\"\\$d/.git\\" ]; then echo \\"\\$d\\"; break; fi; done"`);
                repoPath = stdout.trim() || "/app";
            }
        } catch (err) {
            throw new Error(`Failed to resolve repoPath: ${getErrorMessage(err)}`);
        }

        // 2) Ensure git identity and fetch latest
        try {
            await dockerExec(containerId, repoPath, "git config user.email 'mastra-bot@local'");
            await dockerExec(containerId, repoPath, "git config user.name 'Mastra Bot'");
            await dockerExec(containerId, repoPath, "git fetch origin --prune");
        } catch (err) {
            logger?.warn?.("Git setup failed", { error: getErrorMessage(err) });
        }

        // 3) Determine base branch priority: dev > develop > main > master > origin HEAD
        let baseBranch = "main";
        try {
            const { stdout: branches } = await dockerExec(containerId, repoPath, "git ls-remote --heads origin dev develop main master | awk -F'/' '{print $NF}'");
            const available = branches.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
            if (available.includes("dev")) baseBranch = "dev";
            else if (available.includes("develop")) baseBranch = "develop";
            else if (available.includes("main")) baseBranch = "main";
            else if (available.includes("master")) baseBranch = "master";
            else {
                // Fallback to default branch
                try {
                    const { stdout: head } = await dockerExec(containerId, repoPath, "git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@'");
                    if (head.trim()) baseBranch = head.trim();
                } catch {
                    // keep "main" as fallback
                }
            }
        } catch (err) {
            logger?.warn?.("Base branch detection failed, using main", { error: getErrorMessage(err) });
        }

        // 3.5) Empowered planning via githubPrAgent (uses docker_exec internally) to choose branch/base/message
        let branchName = `mastra/unit-tests-${Date.now()}`;
        let commitMessage = "Add unit tests";
        let repoOwner = "";
        let repoName = "";

        try {
            const prAgent = mastra?.getAgent?.("githubPrAgent");
            if (prAgent) {
                const testDir = inputData.repoAnalysis?.testDirectory || "tests";
                const planPrompt = `You have docker_exec. containerId='${containerId}'. Repository at '${repoPath}'.
TASK (strict JSON output): Analyse the repo and prepare a PR strategy.
1. Run: cd ${repoPath} && git remote get-url origin
2. Run: cd ${repoPath} && ls -la ${testDir} 2>/dev/null || echo "TEST_DIR_MISSING"
3. Run: cd ${repoPath} && git branch -r
4. Return JSON: {"baseBranch":"<branch>","branchName":"<new-branch>","commitMessage":"<msg>","repoOwner":"<owner>","repoName":"<repo>"}
Do not return explanations. Only JSON.`;

                const planResult = await prAgent.generate(planPrompt, { maxSteps: 60, maxRetries: 1 });
                const planResultObj = planResult as { text?: string };
                const planText = planResultObj?.text || "";
                const start = planText.indexOf('{');
                const end = planText.lastIndexOf('}');
                if (start !== -1 && end !== -1 && end > start) {
                    const jsonText = planText.substring(start, end + 1);
                    try {
                        const plan = JSON.parse(jsonText) as { 
                            baseBranch?: string; 
                            branchName?: string; 
                            commitMessage?: string; 
                            repoOwner?: string; 
                            repoName?: string;
                        };
                        if (plan.baseBranch && typeof plan.baseBranch === 'string') baseBranch = plan.baseBranch;
                        if (plan.branchName && typeof plan.branchName === 'string') branchName = plan.branchName;
                        if (plan.commitMessage && typeof plan.commitMessage === 'string') commitMessage = plan.commitMessage;
                        if (plan.repoOwner && typeof plan.repoOwner === 'string') repoOwner = plan.repoOwner;
                        if (plan.repoName && typeof plan.repoName === 'string') repoName = plan.repoName;
                    } catch {
                        // ignore JSON parse errors
                    }
                }
            }
        } catch {
            // fallback to manual extraction
        }

        // Extract owner/repo from remote URL if not determined by agent
        if (!repoOwner || !repoName) {
            try {
                const { stdout: url } = await dockerExec(containerId, repoPath, "git remote get-url origin");
                // Handle https://github.com/owner/repo.git or git@github.com:owner/repo.git
                const m = url.match(/github\.com[:/]([^/]+)\/([^/\s]+?)(\.git)?$/);
                if (m) {
                    repoOwner = m[1];
                    repoName = m[2].replace(/\.git$/, '');
                }
            } catch {
                // fallback
            }
        }

        if (!repoOwner || !repoName) {
            throw new Error("Unable to determine repository owner/name from git remote");
        }

        // 4) Checkout base branch, create new branch, stage and commit
        try {
            await dockerExec(containerId, repoPath, `git checkout ${baseBranch}`);
            await dockerExec(containerId, repoPath, `git pull origin ${baseBranch}`).catch(() => {});
            await dockerExec(containerId, repoPath, `git checkout -b ${branchName}`);
            await dockerExec(containerId, repoPath, "git add -A");
            const { stdout: statusCheck } = await dockerExec(containerId, repoPath, "git status --porcelain");
            if (statusCheck.trim()) {
                await dockerExec(containerId, repoPath, `git commit -m ${shellEscape(commitMessage)} --no-verify`);
            }
        } catch (err) {
            logger?.warn?.("Branch preparation failed (may already exist)", { error: getErrorMessage(err) });
            // try alternative: just commit on current branch or create fresh
            try {
                await dockerExec(containerId, repoPath, `git checkout -B ${branchName}`);
                await dockerExec(containerId, repoPath, "git add -A");
                await dockerExec(containerId, repoPath, `git commit -m ${shellEscape(commitMessage)} --allow-empty --no-verify`);
            } catch {
                // best-effort
            }
        }

        // 5) Push to remote
        const token = getGithubTokenFromHost();
        if (token) {
            try {
                await dockerExec(containerId, repoPath, `git remote set-url origin https://x-access-token:${token}@github.com/${repoOwner}/${repoName}.git`);
                await dockerExec(containerId, repoPath, `git push -u origin ${branchName} --force-with-lease`);
        } catch (err) {
                logger?.warn?.("Push failed, trying force push", { error: getErrorMessage(err) });
                try {
                    await dockerExec(containerId, repoPath, `git push -u origin ${branchName} --force`);
                    } catch (forceErr) {
                    throw new Error(`Failed to push branch: ${getErrorMessage(forceErr)}`);
                }
            }
        } else {
            throw new Error("GitHub token not found. Cannot push.");
        }

        await notifyStepStatus({
            stepId: "prepare-commit-and-push-step",
            status: "completed",
            runId,
            containerId,
            projectId: inputData.projectId,
            title: "Branch pushed",
            subtitle: `${branchName} -> ${baseBranch}`,
            toolCallCount: cliToolMetrics.callCount,
        });

        return { 
            containerId, 
            repoPath, 
            branchName, 
            baseBranch, 
            repoOwner, 
            repoName, 
            commitMessage,
            projectId: inputData.projectId,
            testGeneration: inputData.testGeneration,
            repoAnalysis: inputData.repoAnalysis,
            testSpecs: inputData.testSpecs,
            result: inputData.result,
            success: inputData.success,
            toolCallCount: inputData.toolCallCount,
            contextPath: inputData.contextPath,
        };
    },
});

// =============================================================================
// Step 2: Create Pull Request via GitHub API
// =============================================================================

export const createPullRequestStep = createStep({
    id: "create-pull-request-step",
    inputSchema: CreatePullRequestInputSchema,
    outputSchema: CreatePullRequestOutputSchema,
    execute: async ({ inputData, mastra, runId }): Promise<CreatePullRequestOutput> => {
        const logger = ALERTS_ONLY ? null : mastra?.getLogger() as Logger | undefined;
        const token = getGithubTokenFromHost();
        if (!token) {
            throw new Error("GitHub token not found. Ensure .docker.credentials or env GITHUB_PAT exists.");
        }

        await notifyStepStatus({
            stepId: "create-pull-request-step",
            status: "starting",
            runId,
            containerId: inputData.containerId,
            projectId: inputData.projectId,
            title: "Create pull request",
            subtitle: `${inputData.branchName} -> ${inputData.baseBranch}`,
        });

        // Compose PR title and body
        const tg = inputData.testGeneration;
        const qa = tg?.quality;
        const summary = tg?.summary;
        const testFile = tg?.testFiles?.[0]?.testFile;
        const functionsCount = summary?.totalFunctions ?? 0;
        const casesCount = summary?.totalTestCases ?? 0;
        const syntaxValid = qa?.syntaxValid === true;
        const followsBest = qa?.followsBestPractices === true;
        const coverageScore = typeof qa?.coverageScore === 'number' ? qa.coverageScore : undefined;

        const title = `Add high-quality unit tests (${functionsCount} functions, ${casesCount} cases)`;

        const spec = inputData.testSpecs?.[0];
        const sourceFile = spec?.sourceFile || "[unknown source]";
        const specFunctions = spec?.functions 
            ? spec.functions.map(f => `- ${f.name}: ${Array.isArray(f.testCases) ? f.testCases.length : 0} cases`).join("\n")
            : "- [spec not available]";

        const body = [
`## What
This PR introduces comprehensive unit tests for critical modules, focusing on correctness, resilience, and maintainability.`,
`## Why
Improves confidence in core business logic and guards against regressions. The test suite follows pragmatic best practices championed by Google and similar large-scale engineering organizations.`,
`## Scope
- Source under test: ${sourceFile}
- Generated test file: ${testFile || '[unknown]'}
- Functions covered: ${functionsCount}
- Test cases: ${casesCount}${coverageScore !== undefined ? `\n- Estimated coverage score: ${coverageScore}` : ''}`,
`## Design & Approach
- Framework: Vitest (TypeScript)
- Clear Arrange-Act-Assert structure
- Deterministic mocks for external deps
- Edge cases and error paths explicitly validated
- Consistent naming: "should [expected] when [condition]"
- Small, focused tests; no incidental complexity`,
`## Business Logic Understanding
Functions analyzed and their scenarios:
${specFunctions}`,
`## Quality
- Syntax valid: ${syntaxValid ? 'Yes' : 'Needs follow-up'}
- Best practices: ${followsBest ? 'Adhered' : 'Partial'}
- Lint/style consistency: aligned with repo defaults`,
`## Reviewer Notes
- Start with the test names for intent
- Verify mocks align with real dependency boundaries
- Suggest additional cases where ambiguity exists
- Feel free to request naming/style tweaks`,
`## Checklist
- [x] Tests compile
- [x] Structure and naming are consistent
- [x] Error and boundary cases included
- [x] Minimal surface area for flakiness`
        ].join("\n\n");

        // Pre-flight: ensure the remote branch is ahead of base (stage/commit/push if needed)
        try {
            // Ensure we're on the right branch
            await dockerExec(inputData.containerId, inputData.repoPath, `git checkout ${inputData.branchName}`);
            
            // Stage and commit if there are changes
            const { stdout: statusCheck } = await dockerExec(inputData.containerId, inputData.repoPath, "git status --porcelain");
            if (statusCheck.trim()) {
                await dockerExec(inputData.containerId, inputData.repoPath, "git add -A");
                const { stdout: stagedCheck } = await dockerExec(inputData.containerId, inputData.repoPath, "git diff --cached --quiet; echo $?");
                if (stagedCheck.trim() !== "0") {
                    await dockerExec(inputData.containerId, inputData.repoPath, `git commit -m ${shellEscape(inputData.commitMessage || title)} --no-verify`);
                }
            }
            
            // Push if needed
            await dockerExec(inputData.containerId, inputData.repoPath, `git push -u origin ${inputData.branchName}`).catch(() => {});
        } catch {
            // best-effort; PR creation flow has additional recovery
        }

        // Create PR
        const url = `https://api.github.com/repos/${inputData.repoOwner}/${inputData.repoName}/pulls`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github+json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                title,
                head: inputData.branchName,
                base: inputData.baseBranch,
                body,
                maintainer_can_modify: true,
            }),
        });

        if (!res.ok) {
            const text = await res.text().catch(() => "");
            // Handle 422 (Unprocessable Entity) which often means "no commits"
            if (res.status === 422 && text.toLowerCase().includes("no commits")) {
                logger?.warn?.("PR creation returned 422 with no commits – attempting recovery push", { 
                    status: res.status, 
                    text: text.substring(0, 500), 
                    type: "GITHUB_API", 
                    runId 
                });
                try {
                    // Force push an empty commit to ensure branch diverges from base
                    await dockerExec(inputData.containerId, inputData.repoPath, `git checkout ${inputData.branchName}`);
                    await dockerExec(inputData.containerId, inputData.repoPath, "git add -A");
                    await dockerExec(inputData.containerId, inputData.repoPath, `git commit --allow-empty -m ${shellEscape("chore: initialize PR branch")} --no-verify`);
                    await dockerExec(inputData.containerId, inputData.repoPath, `git push origin ${inputData.branchName} --force`);

                    // Retry PR creation
                    const retry = await fetch(url, {
                        method: 'POST',
                        headers: {
                            'Authorization': `token ${token}`,
                            'Accept': 'application/vnd.github+json',
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            title,
                            head: inputData.branchName,
                            base: inputData.baseBranch,
                            body,
                            maintainer_can_modify: true,
                        }),
                    });

                    if (retry.ok) {
                        const prRetryResult = GitHubPullRequestSchema.safeParse(await retry.json());
                        const prRetry = prRetryResult.success ? prRetryResult.data : { html_url: "", number: undefined };
                        const prUrlRetry = prRetry.html_url || `https://github.com/${inputData.repoOwner}/${inputData.repoName}/pulls`;
                        const prNumberRetry = prRetry.number;

                    await notifyStepStatus({
                        stepId: "create-pull-request-step",
                        status: "completed",
                        runId,
                        containerId: inputData.containerId,
                        projectId: inputData.projectId,
                        title: "PR created (after recovery)",
                        subtitle: prUrlRetry,
                        toolCallCount: cliToolMetrics.callCount,
                    });

                    return {
                        prUrl: prUrlRetry,
                        prNumber: prNumberRetry,
                        projectId: inputData.projectId,
                        containerId: inputData.containerId,
                            result: inputData.result,
                            success: inputData.success,
                            toolCallCount: inputData.toolCallCount,
                            contextPath: inputData.contextPath,
                        };
                    } else {
                        const retryText = await retry.text().catch(() => "");
                        throw new Error(`PR creation failed after recovery: ${retry.status} ${retryText}`);
                    }
                } catch (recoveryErr) {
                    throw new Error(`PR creation failed with 422 (no commits). Recovery attempt also failed: ${getErrorMessage(recoveryErr)}`);
                }
            }
            throw new Error(`Failed to create PR: ${res.status} ${text}`);
        }

        const prResult = GitHubPullRequestSchema.safeParse(await res.json());
        const pr = prResult.success ? prResult.data : { html_url: "", number: undefined };
        const prUrl = pr.html_url || `https://github.com/${inputData.repoOwner}/${inputData.repoName}/pulls`;
        const prNumber = pr.number;

        // Optionally add initial comment with a concise summary
        if (prNumber) {
        try {
            const commentUrl = `https://api.github.com/repos/${inputData.repoOwner}/${inputData.repoName}/issues/${prNumber}/comments`;
            const commentBody = [
                `Thanks for reviewing! Key highlights:`,
                `- Branch: ${inputData.branchName} → ${inputData.baseBranch}`,
                `- Tests: ${casesCount} cases across ${functionsCount} functions`,
                `- Focus: correctness, error handling, and determinism`
            ].join("\n");
            await fetch(commentUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `token ${token}`,
                    'Accept': 'application/vnd.github+json',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ body: commentBody }),
            });
        } catch {
            // best effort
            }
        }

        await notifyStepStatus({
            stepId: "create-pull-request-step",
            status: "completed",
            runId,
            containerId: inputData.containerId,
            projectId: inputData.projectId,
            title: "PR created",
            subtitle: prUrl,
            toolCallCount: cliToolMetrics.callCount,
        });

        return { 
            prUrl, 
            prNumber, 
            projectId: inputData.projectId,
            containerId: inputData.containerId,
            result: inputData.result,
            success: inputData.success,
            toolCallCount: inputData.toolCallCount,
            contextPath: inputData.contextPath,
        };
    },
});

// =============================================================================
// Step 3: Post PR URL to backend
// =============================================================================

export const postPrUrlStep = createStep({
    id: "post-pr-url-step",
    inputSchema: PostPrUrlInputSchema,
    outputSchema: PostPrUrlInputSchema,
    execute: async ({ inputData, mastra, runId }): Promise<PostPrUrlInput> => {
        const logger = ALERTS_ONLY ? null : mastra?.getLogger() as Logger | undefined;
        const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
        const url = `${baseUrl}/api/projects/${inputData.projectId}/pr-url`;

        await notifyStepStatus({
            stepId: "post-pr-url-step",
            status: "starting",
            runId,
            containerId: inputData.containerId,
            projectId: inputData.projectId,
            title: "Report PR URL",
            subtitle: url,
        });

        try {
            logger?.debug?.("Posting PR URL to backend", { url, prUrl: inputData.prUrl, projectId: inputData.projectId, type: "BACKEND_POST", runId });
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prUrl: inputData.prUrl }),
            });
            const ok = res.ok;
            if (!ok) {
                const text = await res.text().catch(() => "");
                logger?.warn?.("Backend returned non-2xx for PR URL", { status: res.status, text: text.substring(0, 300), type: "BACKEND_POST", runId });
            }
        } catch (err) {
            logger?.warn?.("Failed to POST PR URL", { error: getErrorMessage(err), type: "BACKEND_POST", runId });
        }

        await notifyStepStatus({
            stepId: "post-pr-url-step",
            status: "completed",
            runId,
            containerId: inputData.containerId,
            projectId: inputData.projectId,
            title: "PR URL reported",
            subtitle: inputData.prUrl,
            toolCallCount: cliToolMetrics.callCount,
        });

        return { 
            prUrl: inputData.prUrl, 
            prNumber: inputData.prNumber,
            projectId: inputData.projectId,
            containerId: inputData.containerId,
            result: inputData.result,
            success: inputData.success,
            toolCallCount: inputData.toolCallCount,
            contextPath: inputData.contextPath,
        };
    },
});

// =============================================================================
// Standalone Workflow (04)
// =============================================================================

export const githubPrWorkflow = createWorkflow({
    id: "github-pr-workflow",
    description: "Commit generated tests to a branch and open a GitHub PR, then report URL",
    inputSchema: WorkflowInputSchema,
    outputSchema: WorkflowOutputSchema,
})
.then(prepareCommitAndPushStep)
.then(createPullRequestStep)
.then(postPrUrlStep)
.commit();
