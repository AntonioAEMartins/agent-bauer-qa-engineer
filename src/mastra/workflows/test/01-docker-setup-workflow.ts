import { createStep, createWorkflow } from "@mastra/core";
import { mastra } from "../..";
import z from "zod";
import { cliToolMetrics } from "../../tools/cli-tool";
import { exec } from "child_process";
import { existsSync, writeFileSync, unlinkSync, mkdtempSync, readFileSync } from "fs";
import path from "path";
import os from "os";
import { notifyStepStatus } from "../../tools/alert-notifier";
import { 
    ContextDataSchema, 
    type ContextData,
    getErrorMessage,
} from "../../types";

const ALERTS_ONLY = (process.env.ALERTS_ONLY === 'true') || (process.env.LOG_MODE === 'alerts_only') || (process.env.MASTRA_LOG_MODE === 'alerts_only');

// =============================================================================
// STEP INPUT/OUTPUT SCHEMAS
// =============================================================================

const TestDockerStepInputSchema = z.object({
    contextData: ContextDataSchema.optional().describe("Optional context data to pass through"),
    repositoryUrl: z.string().optional().describe("Optional repository URL or owner/repo format (e.g., 'owner/repo' or 'https://github.com/owner/repo')"),
    projectId: z.string().describe("Project ID associated with this workflow run"),
});

const TestDockerStepOutputSchema = z.object({
    result: z.string().describe("The result of the Docker operation"),
    success: z.boolean().describe("Whether the operation was successful"),
    toolCallCount: z.number().describe("Total number of tool calls made during execution"),
    containerId: z.string().describe("The ID of the created Docker container"),
    contextData: ContextDataSchema.optional().describe("Context data passed through"),
    repositoryUrl: z.string().optional().describe("Repository URL passed through"),
    projectId: z.string().describe("Project ID passed through"),
});

const TestDockerGithubCloneStepOutputSchema = TestDockerStepOutputSchema.extend({
    repoPath: z.string().describe("Absolute path to the cloned repository inside the container"),
});

const PostProjectStepInputSchema = TestDockerGithubCloneStepOutputSchema;
const PostProjectStepOutputSchema = TestDockerGithubCloneStepOutputSchema;

const ParallelPostProjectOutputSchema = z.object({
    "postProjectDescriptionStep": PostProjectStepOutputSchema,
    "postProjectStackStep": PostProjectStepOutputSchema,
});

const DockerSaveContextStepOutputSchema = z.object({
    result: z.string().describe("The result of the Docker operation"),
    success: z.boolean().describe("Whether the operation was successful"),
    toolCallCount: z.number().describe("Total number of tool calls made during execution"),
    containerId: z.string().describe("The ID of the created Docker container"),
    contextPath: z.string().describe("Path where context was saved in the container"),
    repoPath: z.string().describe("Absolute path to the cloned repository inside the container"),
    projectId: z.string().describe("Project ID passed through"),
});

// Type aliases for convenience
type TestDockerStepInput = z.infer<typeof TestDockerStepInputSchema>;
type TestDockerStepOutput = z.infer<typeof TestDockerStepOutputSchema>;
type TestDockerGithubCloneStepOutput = z.infer<typeof TestDockerGithubCloneStepOutputSchema>;
type PostProjectStepInput = z.infer<typeof PostProjectStepInputSchema>;
type PostProjectStepOutput = z.infer<typeof PostProjectStepOutputSchema>;
type ParallelPostProjectOutput = z.infer<typeof ParallelPostProjectOutputSchema>;
type DockerSaveContextStepOutput = z.infer<typeof DockerSaveContextStepOutputSchema>;

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function sh(cmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr || error.message));
            } else {
                resolve(stdout);
            }
        });
    });
}

function extractRepoCoordinates(
    repositoryUrl: string | undefined,
    contextData: ContextData | undefined
): { owner: string | undefined; repo: string | undefined; resolvedRepoPath: string } {
    let repoOwner: string | undefined;
    let repoName: string | undefined;
    let resolvedRepoPath: string;

    if (repositoryUrl) {
        const repoUrl = repositoryUrl.trim();
        
        if (repoUrl.includes('github.com/')) {
            const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/\.]+)/);
            if (match) {
                repoOwner = match[1];
                repoName = match[2];
                resolvedRepoPath = `${repoOwner}/${repoName}`;
            } else {
                throw new Error(`Invalid GitHub URL format: ${repoUrl}`);
            }
        } else if (repoUrl.includes('/') && !repoUrl.includes(' ')) {
            const [ownerPart, repoPart] = repoUrl.split('/');
            if (ownerPart && repoPart) {
                repoOwner = ownerPart;
                repoName = repoPart;
                resolvedRepoPath = repoUrl;
            } else {
                throw new Error(`Invalid repository format: ${repoUrl}. Expected format: "owner/repo"`);
            }
        } else {
            throw new Error(`Invalid repository format: ${repoUrl}. Expected format: "owner/repo" or GitHub URL`);
        }
    } else {
        // Fall back to contextData extraction
        const context = contextData || {};
        repoOwner = typeof context.owner === 'string' ? context.owner : undefined;
        repoName = typeof context.repo === 'string' ? context.repo : undefined;
        const fullName = typeof context.fullName === 'string' ? context.fullName : (typeof context.full_name === 'string' ? context.full_name : undefined);
        if ((!repoOwner || !repoName) && fullName && fullName.includes('/')) {
            const [ownerPart, repoPart] = fullName.split('/');
            repoOwner = repoOwner || ownerPart;
            repoName = repoName || repoPart;
        }
        resolvedRepoPath = (repoOwner && repoName) ? `${repoOwner}/${repoName}` : 'AntonioAEMartins/yc-24h-hackathon-agent';
    }

    return { owner: repoOwner, repo: repoName, resolvedRepoPath };
}

function getCredToken(): string | undefined {
    try {
        const cwd = process.cwd();
        const primaryPath = path.resolve(cwd, '.docker.credentials');
        const fallbackPath = path.resolve(cwd, '..', '..', '.docker.credentials');
        const credPath = existsSync(primaryPath) ? primaryPath : (existsSync(fallbackPath) ? fallbackPath : undefined);
        if (!credPath) return undefined;
        const raw = readFileSync(credPath, 'utf8');
        const m = raw.match(/GITHUB_PAT\s*=\s*(.+)/);
        return m ? m[1].trim() : undefined;
    } catch {
        return undefined;
    }
}

// =============================================================================
// STEP 1: TEST DOCKER STEP
// =============================================================================

export const dockerSetupStep = createStep({
    id: "dockerSetupStep",
    inputSchema: TestDockerStepInputSchema,
    outputSchema: TestDockerStepOutputSchema,
    execute: async ({ inputData, runId }): Promise<TestDockerStepOutput> => {
        await notifyStepStatus({
            stepId: "dockerSetupStep",
            status: "starting",
            runId,
            title: "Docker setup",
            subtitle: "Building image and starting container",
            metadata: { contextDataPresent: !!inputData.contextData }
        });

        const logger = ALERTS_ONLY ? null : mastra?.getLogger();

        try {
            // Build minimal image
            const buildCmd = `docker build -t yc-ubuntu:22.04 -<<'EOF'
FROM ubuntu:22.04
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
CMD ["bash"]
EOF`;
            logger?.info("🐳 Building Docker image yc-ubuntu:22.04", { type: "DOCKER", runId });
            await sh(buildCmd);

            // Remove any existing container to avoid conflicts
            await sh("docker rm -f yc-ubuntu-test || true");

            // Run container detached
            logger?.info("🚀 Starting container yc-ubuntu-test", { type: "DOCKER", runId });
            await sh("docker run -d --name yc-ubuntu-test yc-ubuntu:22.04 tail -f /dev/null");

            // Get container ID
            const inspectOut = await sh("docker inspect -f '{{.Id}}' yc-ubuntu-test");
            const containerId = (inspectOut || "").trim();

            await notifyStepStatus({
                stepId: "dockerSetupStep",
                status: "completed",
                runId,
                containerId,
                title: "Docker setup completed",
                subtitle: `Container ready (${containerId.substring(0,12)})`,
                toolCallCount: cliToolMetrics.callCount,
            });

            return {
                result: inspectOut || "Operation completed",
                success: true,
                toolCallCount: cliToolMetrics.callCount,
                containerId,
                contextData: inputData.contextData,
                repositoryUrl: inputData.repositoryUrl,
                projectId: inputData.projectId,
            };
        } catch (error) {
            await notifyStepStatus({
                stepId: "dockerSetupStep",
                status: "failed",
                runId,
                title: "Docker setup failed",
                subtitle: getErrorMessage(error),
                level: 'error',
            });
            throw error;
        }
    }
});

// =============================================================================
// STEP 2: TEST DOCKER GITHUB CLONE STEP
// =============================================================================

export const githubCloneStep = createStep({
    id: "githubCloneStep",
    inputSchema: TestDockerStepOutputSchema,
    outputSchema: TestDockerGithubCloneStepOutputSchema,
    execute: async ({ inputData, runId }): Promise<TestDockerGithubCloneStepOutput> => {
        await notifyStepStatus({
            stepId: "githubCloneStep",
            status: "starting",
            runId,
            containerId: inputData.containerId,
            title: "Cloning repository",
            subtitle: "Preparing to clone repo into container",
        });

        return await new Promise((resolve, reject) => {
            // Copy PAT into container and use it to clone the repo, then remove the file
            const cwd = process.cwd();
            let credentialsPath = path.resolve(cwd, ".docker.credentials");
            const fallbackPath = path.resolve(cwd, "..", "..", ".docker.credentials");
            if (!existsSync(credentialsPath) && existsSync(fallbackPath)) {
                credentialsPath = fallbackPath;
            }
            if (!existsSync(credentialsPath)) {
                reject(new Error(`.docker.credentials not found. Checked: ${credentialsPath}`));
                return;
            }

            // Extract repository coordinates
            const { repo: repoName, resolvedRepoPath } = extractRepoCoordinates(
                inputData.repositoryUrl,
                inputData.contextData
            );

            // Get default branch from contextData
            const context = inputData.contextData || {};
            const defaultBranch = typeof context.defaultBranch === 'string' 
                ? context.defaultBranch 
                : (typeof context.default_branch === 'string' ? context.default_branch : undefined);
            const branchArg = defaultBranch ? ` --branch ${defaultBranch} ` : ' ';

            // Compute expected repo path in the container
            const inferredRepoName = (repoName && typeof repoName === 'string')
                ? repoName.replace(/\.git$/, '')
                : 'yc-24h-hackathon-agent';
            const inferredRepoPath = `/app/${inferredRepoName}`;

            // First, copy the credentials file to the container
            const copyCmd = `docker cp "${credentialsPath}" ${inputData.containerId}:/root/.docker.credentials`;
            
            exec(copyCmd, (copyError, _copyStdout, copyStderr) => {
                if (copyError) {
                    reject(new Error(`Failed to copy credentials file: ${copyStderr || copyError.message}`));
                    return;
                }

                // Verify the file was copied successfully
                const verifyCmd = `docker exec ${inputData.containerId} test -f /root/.docker.credentials`;
                
                exec(verifyCmd, (verifyError, _verifyStdout, verifyStderr) => {
                    if (verifyError) {
                        reject(new Error(`Credentials file not found in container after copy: ${verifyStderr || verifyError.message}`));
                        return;
                    }

                    // Now execute the git clone command with dynamic repo and optional branch
                    const execCmd = `docker exec ${inputData.containerId} bash -c "set -e; TOKEN=\\$(grep GITHUB_PAT /root/.docker.credentials | cut -d'=' -f2 | tr -d '[:space:]'); if ( [ -z \"\\\$TOKEN\" ] ); then echo 'Error: GITHUB_PAT not found or empty in credentials file'; exit 1; fi; cd /app; git clone${branchArg}https://x-access-token:\\$TOKEN@github.com/${resolvedRepoPath}.git; rm -f /root/.docker.credentials; echo 'Repository cloned successfully'"`;
                    
                    exec(execCmd, (execError, execStdout, execStderr) => {
                        if (execError) {
                            reject(new Error(`Git clone failed: ${execStderr || execError.message}`));
                        } else {
                            notifyStepStatus({
                                stepId: "githubCloneStep",
                                status: "completed",
                                runId,
                                containerId: inputData.containerId,
                                title: "Repository cloned",
                                subtitle: "Repository cloned successfully",
                                toolCallCount: cliToolMetrics.callCount,
                            });
                            resolve({
                                result: execStdout,
                                success: true,
                                toolCallCount: cliToolMetrics.callCount,
                                containerId: inputData.containerId,
                                contextData: inputData.contextData,
                                repositoryUrl: inputData.repositoryUrl,
                                projectId: inputData.projectId,
                                repoPath: inferredRepoPath,
                            });
                        }
                    });
                });
            });
        });
    }
});

// =============================================================================
// STEP 3: POST PROJECT DESCRIPTION STEP
// =============================================================================

export const postProjectDescriptionStep = createStep({
    id: "postProjectDescriptionStep",
    inputSchema: PostProjectStepInputSchema,
    outputSchema: PostProjectStepOutputSchema,
    execute: async ({ inputData, mastra, runId }): Promise<PostProjectStepOutput> => {
        const logger = ALERTS_ONLY ? null : mastra?.getLogger();
        await notifyStepStatus({
            stepId: "postProjectDescriptionStep",
            status: "starting",
            runId,
            containerId: inputData.containerId,
            title: "Post project description",
            subtitle: "Posting description to backend",
        });

        const context = inputData.contextData || {};
        const projectId = inputData.projectId;
        const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
        const descriptionUrl = `${baseUrl}/api/projects/${projectId}/description`;
        const containerId = inputData.containerId;
        const repoPath = inputData.repoPath || "/app";

        const dockerSh = (cmd: string): Promise<string> => {
            return new Promise((resolve, reject) => {
                exec(`docker exec ${containerId} bash -lc ${JSON.stringify(cmd)}`, (error, stdout, stderr) => {
                    if (error) reject(new Error(stderr || error.message));
                    else resolve(stdout);
                });
            });
        };

        const parseOwnerRepo = (): { owner?: string; repo?: string } => {
            const { owner, repo } = extractRepoCoordinates(inputData.repositoryUrl, inputData.contextData);
            return { owner, repo };
        };

        const fetchGithubAbout = async (): Promise<{ about?: string; topics?: string[] }> => {
            try {
                const { owner, repo } = parseOwnerRepo();
                if (!owner || !repo) return {};
                const token = getCredToken();
                const headers: Record<string, string> = { 'Accept': 'application/vnd.github+json' };
                if (token) headers['Authorization'] = `Bearer ${token}`;
                const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
                if (!res.ok) return {};
                const json = await res.json() as { description?: string; topics?: string[] };
                const topics = Array.isArray(json?.topics) ? json.topics : undefined;
                return { about: typeof json?.description === 'string' ? json.description : undefined, topics };
            } catch { return {}; }
        };

        const tryReadme = async (): Promise<string | undefined> => {
            try {
                const findCmd = `cd ${JSON.stringify(repoPath)} && for f in README README.md README.rst README.txt readme.md Readme.md; do if [ -f "$f" ]; then echo "$f"; break; fi; done`;
                const p = (await dockerSh(findCmd)).trim();
                if (!p) return undefined;
                const filePath = `${repoPath}/${p}`;
                const content = await dockerSh(`sed -n '1,200p' ${JSON.stringify(filePath)}`);
                return content.trim();
            } catch { return undefined; }
        };

        const tryPackageJson = async (): Promise<{ name?: string; description?: string; keywords?: string[] } | undefined> => {
            try {
                const pjPath = `${repoPath}/package.json`;
                const exists = (await dockerSh(`test -f ${JSON.stringify(pjPath)} && echo EXISTS || echo MISSING`)).trim();
                if (exists !== 'EXISTS') return undefined;
                const raw = await dockerSh(`cat ${JSON.stringify(pjPath)}`);
                const json = JSON.parse(raw) as { name?: string; description?: string; keywords?: string[] };
                return { name: json?.name, description: json?.description, keywords: Array.isArray(json?.keywords) ? json.keywords : undefined };
            } catch { return undefined; }
        };

        const analyzeStructure = async (): Promise<{ languages: string[]; features: string[] }> => {
            const features: string[] = [];
            const languages: string[] = [];
            try {
                const filesOut = await dockerSh(`cd ${JSON.stringify(repoPath)} && (git ls-files || find . -type f)`);
                const lines = filesOut.split('\n').map(l => l.trim()).filter(Boolean);
                const counts: Record<string, number> = {};
                for (const lf of lines) {
                    const name = lf.toLowerCase();
                    if (name.includes('node_modules')) continue;
                    const m = name.match(/\.([a-z0-9]+)$/);
                    const ext = m ? m[1] : '';
                    const langMap: Record<string, string> = {
                        'ts': 'TypeScript', 'tsx': 'TypeScript', 'js': 'JavaScript', 'jsx': 'JavaScript',
                        'py': 'Python', 'rb': 'Ruby', 'go': 'Go', 'rs': 'Rust', 'java': 'Java', 'kt': 'Kotlin',
                        'c': 'C', 'cpp': 'C++', 'cc': 'C++', 'cxx': 'C++', 'hpp': 'C++', 'mm': 'Objective-C',
                        'php': 'PHP', 'swift': 'Swift', 'm': 'Objective-C', 'scala': 'Scala',
                        'html': 'HTML', 'css': 'CSS', 'scss': 'SCSS', 'sass': 'Sass', 'md': 'Markdown', 'sh': 'Shell'
                    };
                    const lang = langMap[ext];
                    if (lang) counts[lang] = (counts[lang] || 0) + 1;
                }
                const sorted = Object.entries(counts).sort((a,b) => b[1]-a[1]).map(([k]) => k);
                languages.push(...sorted.slice(0, 5));

                const configs: Array<{ path: string; feat: string }> = [
                    { path: `${repoPath}/Dockerfile`, feat: 'Dockerized' },
                    { path: `${repoPath}/docker-compose.yml`, feat: 'Docker Compose' },
                    { path: `${repoPath}/next.config.js`, feat: 'Next.js' },
                    { path: `${repoPath}/tailwind.config.js`, feat: 'Tailwind CSS' },
                    { path: `${repoPath}/vite.config.ts`, feat: 'Vite' },
                    { path: `${repoPath}/jest.config.js`, feat: 'Jest' },
                    { path: `${repoPath}/vitest.config.ts`, feat: 'Vitest' },
                    { path: `${repoPath}/prisma/schema.prisma`, feat: 'Prisma' },
                ];
                for (const c of configs) {
                    const ex = (await dockerSh(`test -e ${JSON.stringify(c.path)} && echo EXISTS || echo MISSING`)).trim();
                    if (ex === 'EXISTS') features.push(c.feat);
                }
            } catch { /* ignore */ }
            return { languages, features };
        };

        // 1) Try agent-driven description
        let finalDescription: string | undefined;
        try {
            const aboutInfo = await fetchGithubAbout();
            const agent = mastra?.getAgent?.("codebaseDescriptionAgent");
            if (agent) {
                const ownerRepo = parseOwnerRepo();
                const hints = {
                    owner: ownerRepo.owner || null,
                    repo: ownerRepo.repo || null,
                    githubAbout: aboutInfo.about || null,
                    githubTopics: aboutInfo.topics || [],
                };
                const prompt = `You have access to docker_exec. containerId='${containerId}'. Repo path hint='${repoPath}'.
Your task: produce a crisp 1-3 sentence description for this repository.
Start by checking obvious sources (README, package manifests). Then, if needed, sample a few representative source files.
Do not read more than 8 content files total. Keep outputs small using head and grep. Use only standard shell tools.
Hints: ${JSON.stringify(hints)}.

When done, return STRICT JSON only: {"description": string, "sources": string[], "confidence": number, "notes": string}.`;
                const res = await agent.generate(prompt, { maxSteps: 12, maxRetries: 2 });
                const text: string = (res?.text || "").toString();
                let jsonText = text;
                const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/```\s*([\s\S]*?)\s*```/);
                if (jsonMatch) {
                    jsonText = jsonMatch[1];
                } else {
                    const s = text.indexOf('{');
                    const e = text.lastIndexOf('}');
                    if (s !== -1 && e !== -1 && e > s) jsonText = text.substring(s, e + 1);
                }
                try {
                    const parsed = JSON.parse(jsonText) as { description?: string; confidence?: number; sources?: unknown[] };
                    if (parsed && typeof parsed.description === 'string' && parsed.description.trim().length > 0) {
                        finalDescription = String(parsed.description).replace(/\s+/g, ' ').trim();
                        logger?.info("🧠 Description agent success", {
                            preview: finalDescription.substring(0, 140),
                            confidence: parsed.confidence,
                            sourcesCount: Array.isArray(parsed.sources) ? parsed.sources.length : 0,
                            type: "AGENT_DESCRIPTION",
                            runId,
                        });
                    }
                } catch (e) {
                    logger?.warn("⚠️ Agent JSON parse failed; will use fallback", { error: getErrorMessage(e), type: "AGENT_DESCRIPTION", runId });
                }
            }
        } catch (e) {
            logger?.warn("⚠️ Agent invocation failed; will use fallback", { error: getErrorMessage(e), type: "AGENT_DESCRIPTION", runId });
        }

        // 2) Fallback to static heuristics if needed
        if (!finalDescription) {
            const repoName = context.repo || context.name || (String(repoPath).split('/').pop() || 'repository');
            const [aboutInfo, readmeContent, pkgInfo, structure] = await Promise.all([
                fetchGithubAbout(),
                tryReadme(),
                tryPackageJson(),
                analyzeStructure(),
            ]);

            const primary = aboutInfo.about || pkgInfo?.description || undefined;
            let synthesized: string;
            if (primary) {
                synthesized = primary.trim();
            } else if (readmeContent) {
                const cleaned = readmeContent
                    .split('\n')
                    .filter(line => !/\!\[[^\]]*\]\([^)]*\)/.test(line))
                    .join('\n');
                const paras = cleaned.split(/\n\s*\n/).map(s => s.replace(/^#+\s*/,'').trim()).filter(Boolean);
                synthesized = (paras[1] || paras[0] || `Repository ${repoName}`).slice(0, 600);
            } else {
                const langStr = (structure.languages || []).slice(0,3).join(', ');
                const featStr = (structure.features || []).slice(0,3).join(', ');
                const first = langStr ? `A ${langStr} codebase.` : `A software project.`;
                const secondParts: string[] = [];
                if (featStr) secondParts.push(`Includes ${featStr}.`);
                if (aboutInfo.topics && aboutInfo.topics.length) secondParts.push(`Topics: ${aboutInfo.topics.slice(0,3).join(', ')}.`);
                synthesized = `${first} ${secondParts.join(' ')}`.trim();
            }
            finalDescription = synthesized.replace(/\s+/g, ' ').trim();
        }

        const payload = { description: finalDescription };

        logger?.info("📨 Preparing to post project description", {
            step: "post-project-description",
            url: descriptionUrl,
            projectId,
            hasContextData: !!inputData.contextData,
            contextKeys: Object.keys(context || {}),
            descriptionPreview: (finalDescription || '').substring(0, 120),
            type: "BACKEND_POST",
            runId,
        });

        try {
            const res = await fetch(descriptionUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            const success = res.ok;
            logger?.info("📥 Backend responded for project description", {
                status: res.status,
                ok: res.ok,
                url: descriptionUrl,
                projectId,
                type: "BACKEND_RESPONSE",
                runId,
            });
            if (!success) {
                const text = await res.text().catch(() => '');
                logger?.warn("⚠️  Backend responded non-2xx for description", { 
                    url: descriptionUrl, 
                    status: res.status, 
                    payload,
                    responseText: text.substring(0, 500), 
                    type: "BACKEND_POST", 
                    runId 
                });
            }

            await notifyStepStatus({
                stepId: "postProjectDescriptionStep",
                status: success ? "completed" : "failed",
                runId,
                containerId: inputData.containerId,
                title: success ? "Description posted" : "Description post failed",
                subtitle: success ? `Posted to project ${projectId}` : "Failed to post description",
            });

        } catch (err) {
            logger?.warn("⚠️  Failed to POST description", { 
                url: descriptionUrl,
                error: getErrorMessage(err),
                stack: err instanceof Error ? err.stack : undefined,
                type: "BACKEND_POST",
                runId 
            });

            await notifyStepStatus({
                stepId: "postProjectDescriptionStep",
                status: "failed",
                runId,
                containerId: inputData.containerId,
                title: "Description post failed",
                subtitle: "Network error",
            });
        }

        return {
            ...inputData,
            repositoryUrl: inputData.repositoryUrl,
            projectId: inputData.projectId,
        };
    },
});

// =============================================================================
// STEP 4: POST PROJECT STACK STEP
// =============================================================================

export const postProjectStackStep = createStep({
    id: "postProjectStackStep",
    inputSchema: PostProjectStepInputSchema,
    outputSchema: PostProjectStepOutputSchema,
    execute: async ({ inputData, mastra, runId }): Promise<PostProjectStepOutput> => {
        const logger = ALERTS_ONLY ? null : mastra?.getLogger();
        await notifyStepStatus({
            stepId: "postProjectStackStep",
            status: "starting",
            runId,
            containerId: inputData.containerId,
            title: "Post project stack",
            subtitle: "Posting tech stack to backend",
        });

        const context = inputData.contextData || {};
        const projectId = inputData.projectId;
        const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
        const stackUrl = `${baseUrl}/api/projects/${projectId}/stack`;
        const containerId = inputData.containerId;
        const repoPath = inputData.repoPath;

        // Normalize name helper
        const normalizeName = (name: string): string => name.toLowerCase().replace(/@/g, '').replace(/[^a-z0-9+\-.]/g, '');

        const stackMap: Record<string, { icon: string; title: string; description: string }> = {
            // Languages
            'typescript': { icon: 'ts', title: 'TypeScript', description: 'Typed superset of JavaScript that compiles to plain JS.' },
            'javascript': { icon: 'js', title: 'JavaScript', description: 'High-level, dynamic language for the web and Node.js.' },
            'python': { icon: 'py', title: 'Python', description: 'Versatile language for scripting, data, and backend services.' },
            'go': { icon: 'go', title: 'Go', description: 'Compiled language for fast, concurrent services by Google.' },
            'rust': { icon: 'rust', title: 'Rust', description: 'Memory-safe systems programming language.' },
            'java': { icon: 'java', title: 'Java', description: 'General-purpose language for enterprise applications.' },
            // Frameworks
            'next': { icon: 'nextjs', title: 'Next.js', description: 'React framework for hybrid rendering (SSR/SSG) and routing by Vercel.' },
            'nextjs': { icon: 'nextjs', title: 'Next.js', description: 'React framework for hybrid rendering (SSR/SSG) and routing by Vercel.' },
            'react': { icon: 'react', title: 'React', description: 'Component-based UI library for building interactive interfaces.' },
            'vue': { icon: 'vue', title: 'Vue.js', description: 'Progressive framework for building user interfaces.' },
            'vite': { icon: 'vite', title: 'Vite', description: 'Next-gen frontend tooling with fast dev server and build.' },
            'vitest': { icon: 'vitest', title: 'Vitest', description: 'Vite-native unit test framework with Jest-compatible API.' },
            'jest': { icon: 'jest', title: 'Jest', description: 'Delightful JavaScript testing framework.' },
            'tailwind': { icon: 'tailwind', title: 'Tailwind CSS', description: 'Utility-first CSS framework for rapid UI development.' },
            'prisma': { icon: 'prisma', title: 'Prisma', description: 'Type-safe ORM for Node.js and TypeScript.' },
            'docker': { icon: 'docker', title: 'Docker', description: 'Containerization platform.' },
            'postgres': { icon: 'postgres', title: 'PostgreSQL', description: 'Advanced open source relational database.' },
        };

        const mapToStackItem = (name: string): { title: string; description: string; icon: string } | null => {
            const n = normalizeName(name);
            const direct = stackMap[n];
            if (direct) return { title: direct.title, description: direct.description, icon: direct.icon };
            if (/^next(\.|$)/.test(n)) return { title: 'Next.js', description: stackMap['next'].description, icon: 'nextjs' };
            if (/^react(\.|$)/.test(n)) return { title: 'React', description: stackMap['react'].description, icon: 'react' };
            if (n.includes('typescript') || n === 'ts') return { title: 'TypeScript', description: stackMap['typescript'].description, icon: 'ts' };
            if (n.includes('javascript') || n === 'js') return { title: 'JavaScript', description: stackMap['javascript'].description, icon: 'js' };
            if (n.includes('node')) return { title: 'Node.js', description: 'V8-based JavaScript runtime for server-side applications.', icon: 'nodejs' };
            return null;
        };

        const parseOwnerRepo = (): { owner?: string; repo?: string } => {
            const { owner, repo } = extractRepoCoordinates(inputData.repositoryUrl, inputData.contextData);
            return { owner, repo };
        };

        const fetchGithubLanguages = async (): Promise<Array<{ title: string; icon: string; description: string }>> => {
            try {
                const { owner, repo } = parseOwnerRepo();
                if (!owner || !repo) return [];
                const token = getCredToken();
                const headers: Record<string, string> = { 'Accept': 'application/vnd.github+json' };
                if (token) headers['Authorization'] = `Bearer ${token}`;
                const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/languages`, { headers });
                if (!res.ok) return [];
                const json = await res.json() as Record<string, number>;
                const sorted = Object.entries(json).sort((a,b) => b[1]-a[1]).map(([k]) => k);
                const mapped: Array<{ title: string; icon: string; description: string }> = [];
                for (const lang of sorted.slice(0, 8)) {
                    const item = mapToStackItem(lang.toLowerCase());
                    if (item) mapped.push(item);
                    else {
                        const lower = lang.toLowerCase();
                        const fallback = stackMap[lower];
                        if (fallback) mapped.push({ title: fallback.title, description: fallback.description, icon: fallback.icon });
                    }
                }
                return mapped;
            } catch { return []; }
        };

        const dockerSh = (cmd: string): Promise<string> => new Promise((resolve, reject) => {
            exec(`docker exec ${containerId} bash -lc ${JSON.stringify(cmd)}`, (error, stdout, stderr) => {
                if (error) reject(new Error(stderr || error.message)); else resolve(stdout);
            });
        });

        const analyzeLocal = async (): Promise<Array<{ title: string; icon: string; description: string }>> => {
            const items: Array<{ title: string; icon: string; description: string }> = [];
            // Languages via extensions
            try {
                const filesOut = await dockerSh(`cd ${JSON.stringify(repoPath)} && (git ls-files || find . -type f)`);
                const lines = filesOut.split('\n').map(l => l.trim()).filter(Boolean);
                const counts: Record<string, number> = {};
                for (const lf of lines) {
                    const name = lf.toLowerCase();
                    if (name.includes('node_modules')) continue;
                    const m = name.match(/\.([a-z0-9]+)$/);
                    const ext = m ? m[1] : '';
                    const langMap: Record<string, string> = {
                        'ts': 'typescript', 'tsx': 'typescript', 'js': 'javascript', 'jsx': 'javascript',
                        'py': 'python', 'rb': 'ruby', 'go': 'go', 'rs': 'rust', 'java': 'java', 'kt': 'kotlin',
                        'c': 'c', 'cpp': 'c++', 'cc': 'c++', 'cxx': 'c++', 'hpp': 'c++',
                        'php': 'php', 'swift': 'swift', 'scala': 'scala', 'sh': 'shell', 'css': 'css', 'scss': 'scss', 'html': 'html'
                    };
                    const lang = langMap[ext]; if (lang) counts[lang] = (counts[lang] || 0) + 1;
                }
                const langs = Object.entries(counts).sort((a,b) => b[1]-a[1]).map(([k]) => k).slice(0, 5);
                for (const l of langs) { const it = mapToStackItem(l); if (it) items.push(it); }
            } catch { /* ignore */ }
            // JS libraries via package.json
            try {
                const pjPath = `${repoPath}/package.json`;
                const exists = (await dockerSh(`test -f ${JSON.stringify(pjPath)} && echo EXISTS || echo MISSING`)).trim();
                if (exists === 'EXISTS') {
                    const raw = await dockerSh(`cat ${JSON.stringify(pjPath)}`);
                    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
                    const deps = Object.keys({ ...(pkg.dependencies||{}), ...(pkg.devDependencies||{}) });
                    const candidates = deps.map((d: string) => normalizeName(d));
                    for (const c of candidates) { const it = mapToStackItem(c); if (it) items.push(it); }
                }
            } catch { /* ignore */ }
            // Docker presence
            try {
                const dockerfile = (await dockerSh(`test -f ${JSON.stringify(repoPath + '/Dockerfile')} && echo EXISTS || echo MISSING`)).trim();
                if (dockerfile === 'EXISTS') items.push(stackMap['docker']);
            } catch { /* ignore */ }
            return items;
        };

        const fromGithub = await fetchGithubLanguages();
        const fromLocal = await analyzeLocal();

        const seen = new Set<string>();
        const techStack = [...fromGithub, ...fromLocal].filter(it => {
            const key = it.title.toLowerCase();
            if (seen.has(key)) return false; seen.add(key); return true;
        }).slice(0, 20);

        logger?.info("📨 Preparing to post project stack", {
            step: "post-project-stack",
            url: stackUrl,
            projectId,
            candidateCount: fromGithub.length + fromLocal.length,
            techStackCount: techStack.length,
            techStackSample: techStack.slice(0, 5),
            type: "BACKEND_POST",
            runId,
        });

        try {
            let successCount = 0;
            let lastError: string | undefined;

            // Send each tech stack item individually
            for (const item of techStack) {
                const stackPayload = {
                    title: item.title,
                    description: item.description,
                    icon: item.icon || null,
                };

                const res = await fetch(stackUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(stackPayload),
                });

                if (res.ok) {
                    successCount++;
                } else {
                    const text = await res.text().catch(() => '');
                    lastError = `${item.title}: ${res.status} ${text}`;
                    logger?.warn("⚠️  Backend responded non-2xx for stack item", { 
                        item: item.title,
                        url: stackUrl, 
                        status: res.status, 
                        text: text.substring(0, 500), 
                        type: "BACKEND_POST", 
                        runId 
                    });
                }
            }

            const success = successCount > 0;
            await notifyStepStatus({
                stepId: "postProjectStackStep",
                status: success ? "completed" : "failed",
                runId,
                containerId: inputData.containerId,
                title: success ? "Stack posted" : "Stack post failed",
                subtitle: success ? `Posted ${successCount}/${techStack.length} technologies` : `Failed to post stack${lastError ? `: ${lastError}` : ''}`,
            });

        } catch (err) {
            logger?.warn("⚠️  Failed to POST stack items", { 
                url: stackUrl,
                error: getErrorMessage(err),
                stack: err instanceof Error ? err.stack : undefined,
                type: "BACKEND_POST",
                runId 
            });

            await notifyStepStatus({
                stepId: "postProjectStackStep",
                status: "failed",
                runId,
                containerId: inputData.containerId,
                title: "Stack post failed",
                subtitle: "Network error during stack posting",
            });
        }

        return {
            ...inputData,
            repositoryUrl: inputData.repositoryUrl,
            projectId: inputData.projectId,
        };
    },
});

// =============================================================================
// STEP 5: DOCKER SAVE CONTEXT STEP
// =============================================================================

export const dockerSaveContextStep = createStep({
    id: "dockerSaveContextStep",
    inputSchema: ParallelPostProjectOutputSchema,
    outputSchema: DockerSaveContextStepOutputSchema,
    execute: async ({ inputData, mastra, runId }): Promise<DockerSaveContextStepOutput> => {
        const desc = inputData["postProjectDescriptionStep"];
        const containerId = desc.containerId;
        const contextData = desc.contextData;
        const repoPath = desc.repoPath || '';
        const projectId = desc.projectId;
        const logger = ALERTS_ONLY ? null : mastra?.getLogger();
        const contextPath = "/app/agent.context.json";

        await notifyStepStatus({
            stepId: "dockerSaveContextStep",
            status: "starting",
            runId,
            containerId,
            title: "Saving context to container",
            subtitle: `Writing ${contextData ? 'provided' : 'no'} context data`,
        });
        
        logger?.info("💾 Starting code-based context save to Docker container", {
            containerId: containerId.substring(0, 12),
            contextPath,
            hasContextData: !!contextData,
            type: "DOCKER_CONTEXT_SAVE",
            runId: runId,
        });

        try {
            // Error if no context data provided - this indicates a workflow issue
            if (!contextData) {
                const error = "No context data provided to saveContextStep - workflow execution error";
                logger?.error("❌ Context data missing", {
                    error,
                    type: "DOCKER_CONTEXT_SAVE",
                    runId: runId,
                });
                throw new Error(error);
            }

            const contextToSave = contextData;
            const contextJson = JSON.stringify(contextToSave, null, 2);
            
            // Write context file to temp location then copy to Docker container
            return await new Promise((resolve, reject) => {
                let tempFilePath: string | null = null;
                
                try {
                    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'docker-context-'));
                    tempFilePath = path.join(tempDir, 'context.json');
                    writeFileSync(tempFilePath, contextJson, 'utf8');

                    const copyCmd = `docker cp "${tempFilePath}" ${containerId}:${contextPath}`;
                    
                    exec(copyCmd, (copyError, _copyStdout, copyStderr) => {
                        // Clean up temp file
                        if (tempFilePath) {
                            try { unlinkSync(tempFilePath); } catch { /* ignore */ }
                        }

                        if (copyError) {
                            logger?.error("❌ Failed to copy context file to container", {
                                error: copyStderr || copyError.message,
                                type: "DOCKER_CONTEXT_SAVE",
                                runId: runId,
                            });
                            reject(new Error(`Failed to copy context file to container: ${copyStderr || copyError.message}`));
                            return;
                        }

                        // Verify file exists
                        const verifyCmd = `docker exec ${containerId} bash -c "test -f ${contextPath} && wc -c ${contextPath}"`;
                        
                        exec(verifyCmd, (verifyError, verifyStdout, verifyStderr) => {
                            if (verifyError) {
                                logger?.error("❌ Context file verification failed", {
                                    error: verifyStderr || verifyError.message,
                                    type: "DOCKER_CONTEXT_SAVE",
                                    runId: runId,
                                });
                                reject(new Error(`Context file verification failed: ${verifyStderr || verifyError.message}`));
                                return;
                            }

                            const fileSize = verifyStdout.trim().split(' ')[0] || '0';
                            logger?.info("✅ Context file successfully saved to Docker container", {
                                containerId: containerId.substring(0, 12),
                                contextPath,
                                fileSize: `${parseInt(fileSize)} bytes`,
                                type: "DOCKER_CONTEXT_SAVE",
                                runId: runId,
                            });

                            notifyStepStatus({
                                stepId: "dockerSaveContextStep",
                                status: "completed",
                                runId,
                                containerId,
                                contextPath,
                                title: "Context saved",
                                subtitle: `Saved to ${contextPath}`,
                                toolCallCount: cliToolMetrics.callCount,
                            });

                            resolve({
                                result: `Context successfully saved to ${contextPath} (${fileSize} bytes)`,
                                success: true,
                                toolCallCount: cliToolMetrics.callCount,
                                containerId,
                                contextPath,
                                repoPath: repoPath || "/app",
                                projectId,
                            });
                        });
                    });
                } catch (tempError) {
                    if (tempFilePath) {
                        try { unlinkSync(tempFilePath); } catch { /* ignore */ }
                    }
                    reject(tempError instanceof Error ? tempError : new Error('Unknown temp file error'));
                }
            });

        } catch (error) {
            logger?.error("❌ Context save operation failed", {
                error: getErrorMessage(error),
                type: "DOCKER_CONTEXT_SAVE",
                runId: runId,
            });

            await notifyStepStatus({
                stepId: "dockerSaveContextStep",
                status: "failed",
                runId,
                containerId,
                contextPath,
                title: "Context save failed",
                subtitle: getErrorMessage(error),
                level: 'error',
                toolCallCount: cliToolMetrics.callCount,
            });

            return {
                result: `Context save failed: ${getErrorMessage(error)}`,
                success: false,
                toolCallCount: cliToolMetrics.callCount,
                containerId,
                contextPath,
                repoPath: repoPath || "/app",
                projectId,
            };
        }
    }
});

// =============================================================================
// WORKFLOW DEFINITION
// =============================================================================

export const dockerSetupWorkflow = createWorkflow({
    id: "dockerSetupWorkflow",
    description: "Build Docker container, clone repository, post project info in parallel, and save context data efficiently using code-based operations",
    inputSchema: TestDockerStepInputSchema,
    outputSchema: DockerSaveContextStepOutputSchema,
}).then(dockerSetupStep)
  .then(githubCloneStep)
  .parallel([postProjectDescriptionStep, postProjectStackStep])
  .then(dockerSaveContextStep)
  .commit();
