import { createWorkflow, createStep } from "@mastra/core";
import { dockerSetupStep, githubCloneStep, postProjectDescriptionStep, postProjectStackStep, dockerSaveContextStep } from "./test/01-docker-setup-workflow";
import { contextGatheringStartStep, analyzeRepositoryStep, analyzeCodebaseStep, analyzeBuildDeploymentStep, synthesizeContextStep, saveContextStep } from "./test/02-context-gathering-workflow";
import { checkSavedPlanStep, loadContextAndPlanStep, generateTestCodeStep, finalizeTestsStep } from "./test/03-test-generation-workflow";
import { prepareCommitStep, createPullRequestStep, postPrUrlStep } from "./test/04-github-pr-workflow";
import { runCoverageStep, postCoverageStep } from "./test/05-coverage-analysis-workflow";
import { 
    PipelineInputSchema,
    PipelineOutputSchema,
    type PipelineOutput,
    PostTestCoverageStepOutputSchema,
} from "../types/pipeline-schemas";

// =============================================================================
// FULL PIPELINE WORKFLOW
// =============================================================================

export const fullPipelineWorkflow = createWorkflow({
    id: "fullPipelineWorkflow",
    description: "End-to-end pipeline: Docker setup → Context gather → Unit test generation → GitHub PR → Coverage",
    inputSchema: PipelineInputSchema,
    outputSchema: PipelineOutputSchema,
})
    // Phase 1: Docker setup
    .then(dockerSetupStep)
    .then(githubCloneStep)
    .parallel([postProjectDescriptionStep, postProjectStackStep])
    .then(dockerSaveContextStep)
    // Phase 2: Context gathering
    // @ts-expect-error - Mastra schema identity mismatch: contextGatheringStartStep expects minimal input but receives full dockerSaveContextStep output
    .then(contextGatheringStartStep)
    .parallel([analyzeRepositoryStep, analyzeCodebaseStep, analyzeBuildDeploymentStep])
    .then(synthesizeContextStep)
    .then(saveContextStep)
    // Phase 3: Unit test generation
    // @ts-expect-error - Mastra schema identity mismatch: checkSavedPlanStep expects minimal input but receives full saveContextStep output
    .then(checkSavedPlanStep)
    .then(loadContextAndPlanStep)
    .then(generateTestCodeStep)
    .then(finalizeTestsStep)
    // Phase 4: GitHub PR
    // @ts-expect-error - Mastra schema identity mismatch: prepareCommitStep expects different fields than finalizeTestsStep output
    .then(prepareCommitStep)
    .then(createPullRequestStep)
    .then(postPrUrlStep)
    // Phase 5: Coverage
    // @ts-expect-error - Mastra schema identity mismatch: runCoverageStep expects different fields than postPrUrlStep output
    .then(runCoverageStep)
    .then(postCoverageStep)
    // Final: Normalize output to pipeline schema
    .then(createStep({
        id: "full-pipeline-output-normalizer",
        inputSchema: PostTestCoverageStepOutputSchema,
        outputSchema: PipelineOutputSchema,
        execute: async ({ inputData }): Promise<PipelineOutput> => {
            return {
                result: inputData.result || "Pipeline completed",
                success: inputData.success ?? true,
                toolCallCount: inputData.toolCallCount ?? 0,
                containerId: inputData.containerId || "",
                contextPath: inputData.contextPath,
                projectId: inputData.projectId || "",
                prUrl: inputData.prUrl || "",
            };
        },
    }))
    .commit();
