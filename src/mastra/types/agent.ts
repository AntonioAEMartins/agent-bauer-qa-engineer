/**
 * Agent-related types for type-safe agent interactions.
 */
import z from "zod";

// =============================================================================
// AGENT RESPONSE TYPES
// =============================================================================

/**
 * Tool call information from agent response.
 */
export interface AgentToolCall {
    name: string;
    arguments: Record<string, unknown>;
    result?: unknown;
}

/**
 * Agent generate response structure.
 * Based on Mastra's Agent.generate() return type.
 * Using a loose type to accommodate different Mastra versions.
 */
export interface AgentGenerateResult {
    text: string;
    toolCalls?: Array<{
        type?: string;
        toolCallId?: string;
        toolName?: string;
        name?: string;
        args?: unknown;
        arguments?: Record<string, unknown>;
        result?: unknown;
    }>;
    finishReason?: string;
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
}

// =============================================================================
// AGENT NAMES
// =============================================================================

/**
 * Known agent names for type-safe agent retrieval.
 */
export type AgentName =
    | "unitTestAgent"
    | "testAnalysisAgent"
    | "testSpecificationAgent"
    | "testGenerationAgent"
    | "testValidationAgent"
    | "dockerAgent"
    | "contextAgent"
    | "githubPrAgent"
    | "codebaseDescriptionAgent"
    | "testCoveringAgent"
    | "typescriptVitestCoverageAgent";

// =============================================================================
// JSON PARSING HELPERS
// =============================================================================

/**
 * Options for JSON extraction from agent responses.
 */
export interface JsonExtractionOptions {
    /** Whether to attempt JSON recovery on parse failure */
    attemptRecovery?: boolean;
    /** Logger for debugging */
    logger?: {
        debug?: (message: string, meta?: Record<string, unknown>) => void;
        warn?: (message: string, meta?: Record<string, unknown>) => void;
        error?: (message: string, meta?: Record<string, unknown>) => void;
    };
    /** Run ID for logging context */
    runId?: string;
}

/**
 * Extracts JSON from agent response text.
 * Handles markdown code blocks and JSON boundaries.
 */
export function extractJsonFromText(text: string): string {
    // Try markdown code fences first
    const jsonMarkdownMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMarkdownMatch && jsonMarkdownMatch[1].trim().length > 10) {
        return jsonMarkdownMatch[1].trim();
    }

    // Try finding JSON object boundaries
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
        return text.substring(start, end + 1);
    }

    // Fallback patterns
    const patterns = [
        /(?:Here's the|Here is the|The|Result:|Output:)\s*(?:JSON|json)?\s*[:\-]?\s*(\{[\s\S]*\})/i,
        /(?:```\s*)?(\{[\s\S]*\})(?:\s*```)?/,
        /JSON:\s*(\{[\s\S]*\})/i
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match && match[1] && match[1].trim().length > 10) {
            return match[1].trim();
        }
    }

    return text;
}

/**
 * Attempts to recover malformed JSON.
 */
export function attemptJsonRecovery(jsonText: string): string {
    let recovered = jsonText;

    // Fix trailing commas
    recovered = recovered.replace(/,(\s*[}\]])/g, '$1');

    // Fix incomplete JSON (try to close it)
    const openBraces = (recovered.match(/\{/g) || []).length;
    const closeBraces = (recovered.match(/\}/g) || []).length;
    if (openBraces > closeBraces) {
        recovered += '}'.repeat(openBraces - closeBraces);
    }

    return recovered;
}

/**
 * Parses and validates agent JSON response against a Zod schema.
 */
export function parseAgentJsonResponse<T>(
    text: string,
    schema: z.ZodType<T>,
    options: JsonExtractionOptions = {}
): T {
    const { attemptRecovery = true, logger, runId } = options;

    const jsonText = extractJsonFromText(text);

    if (jsonText.length < 10 || jsonText === "..." || !jsonText.includes('{')) {
        logger?.warn?.("Poor JSON extraction quality", {
            extractedLength: jsonText.length,
            preview: jsonText.substring(0, 100),
            type: "JSON_EXTRACTION",
            runId,
        });
        throw new Error(`Failed to extract valid JSON from agent response. Preview: ${text.substring(0, 500)}...`);
    }

    try {
        const parsed = JSON.parse(jsonText);
        return schema.parse(parsed);
    } catch (parseError) {
        if (!attemptRecovery) {
            throw parseError;
        }

        logger?.warn?.("JSON parsing failed, attempting recovery", {
            parseError: parseError instanceof Error ? parseError.message : 'Unknown error',
            type: "JSON_ERROR",
            runId,
        });

        try {
            const recoveredJson = attemptJsonRecovery(jsonText);
            const parsed = JSON.parse(recoveredJson);
            return schema.parse(parsed);
        } catch (recoveryError) {
            logger?.error?.("JSON parsing and recovery both failed", {
                originalError: parseError instanceof Error ? parseError.message : 'Unknown error',
                recoveryError: recoveryError instanceof Error ? recoveryError.message : 'Unknown error',
                type: "JSON_ERROR",
                runId,
            });

            throw new Error(`JSON parsing failed after recovery attempt. Original: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`);
        }
    }
}

