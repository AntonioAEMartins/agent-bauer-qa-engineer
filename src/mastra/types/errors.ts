/**
 * Error handling utilities for type-safe error handling across the codebase.
 */

/**
 * Extracts a human-readable error message from an unknown error value.
 * Replaces the pattern: `error instanceof Error ? error.message : 'Unknown error'`
 */
export function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === 'string') {
        return error;
    }
    return String(error);
}

/**
 * Extracts error stack if available from an unknown error value.
 */
export function getErrorStack(error: unknown): string | undefined {
    if (error instanceof Error) {
        return error.stack;
    }
    return undefined;
}

/**
 * Type guard to check if a value is an Error instance.
 */
export function isError(value: unknown): value is Error {
    return value instanceof Error;
}

/**
 * Wraps an unknown error in a proper Error object.
 */
export function toError(error: unknown): Error {
    if (error instanceof Error) {
        return error;
    }
    return new Error(getErrorMessage(error));
}

