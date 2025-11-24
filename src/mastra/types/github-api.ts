/**
 * GitHub API response types.
 */
import z from "zod";

// =============================================================================
// REPOSITORY INFORMATION
// =============================================================================

/**
 * GitHub repository information from the API.
 */
export const GitHubRepoInfoSchema = z.object({
    id: z.number(),
    name: z.string(),
    full_name: z.string(),
    description: z.string().nullable(),
    html_url: z.string(),
    clone_url: z.string(),
    ssh_url: z.string(),
    default_branch: z.string(),
    language: z.string().nullable(),
    topics: z.array(z.string()).optional(),
    private: z.boolean(),
    fork: z.boolean(),
    archived: z.boolean(),
    disabled: z.boolean(),
    owner: z.object({
        login: z.string(),
        id: z.number(),
        avatar_url: z.string(),
        html_url: z.string(),
        type: z.string(),
    }),
});

export type GitHubRepoInfo = z.infer<typeof GitHubRepoInfoSchema>;

/**
 * GitHub repository languages response.
 */
export const GitHubLanguagesSchema = z.record(z.string(), z.number());

export type GitHubLanguages = z.infer<typeof GitHubLanguagesSchema>;

// =============================================================================
// PULL REQUEST
// =============================================================================

/**
 * GitHub pull request creation response.
 */
export const GitHubPullRequestSchema = z.object({
    id: z.number(),
    number: z.number(),
    html_url: z.string(),
    state: z.enum(["open", "closed"]),
    title: z.string(),
    body: z.string().nullable(),
    head: z.object({
        ref: z.string(),
        sha: z.string(),
    }),
    base: z.object({
        ref: z.string(),
        sha: z.string(),
    }),
    user: z.object({
        login: z.string(),
        id: z.number(),
    }),
    created_at: z.string(),
    updated_at: z.string(),
    merged_at: z.string().nullable(),
    draft: z.boolean().optional(),
    mergeable: z.boolean().nullable().optional(),
    mergeable_state: z.string().optional(),
});

export type GitHubPullRequest = z.infer<typeof GitHubPullRequestSchema>;

/**
 * GitHub PR creation request payload.
 */
export const GitHubCreatePRRequestSchema = z.object({
    title: z.string(),
    head: z.string(),
    base: z.string(),
    body: z.string().optional(),
    maintainer_can_modify: z.boolean().optional(),
    draft: z.boolean().optional(),
});

export type GitHubCreatePRRequest = z.infer<typeof GitHubCreatePRRequestSchema>;

// =============================================================================
// COMMENTS
// =============================================================================

/**
 * GitHub issue/PR comment.
 */
export const GitHubCommentSchema = z.object({
    id: z.number(),
    body: z.string(),
    user: z.object({
        login: z.string(),
        id: z.number(),
    }),
    created_at: z.string(),
    updated_at: z.string(),
    html_url: z.string(),
});

export type GitHubComment = z.infer<typeof GitHubCommentSchema>;

// =============================================================================
// API ERROR
// =============================================================================

/**
 * GitHub API error response.
 */
export const GitHubErrorSchema = z.object({
    message: z.string(),
    documentation_url: z.string().optional(),
    errors: z.array(z.object({
        resource: z.string(),
        field: z.string(),
        code: z.string(),
        message: z.string().optional(),
    })).optional(),
});

export type GitHubError = z.infer<typeof GitHubErrorSchema>;

