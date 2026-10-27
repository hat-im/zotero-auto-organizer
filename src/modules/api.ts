import { z } from "zod";
import { getPref } from "../utils/prefs";
import { exposeWebGlobals } from "../utils/webGlobals";
import { DEFAULT_PROMPT } from "../utils/constants";
import type { ProviderKind } from "./llm";
import type { NewCollectionProposal } from "./proposals";
import { parseCollectionSelection } from "./selection";

export interface AICollectionCandidate {
  id: number;
  path: string;
}

export interface AIClassificationResult {
  collectionIDs: number[];
  collections: string[];
  chineseTitle?: string;
  newCollection?: NewCollectionProposal;
}

/** What the AI needs to know to suggest a new collection */
export interface ProposalOptions {
  /** Existing collections a new collection can be placed under */
  parents: AICollectionCandidate[];
  allowTopLevel: boolean;
  /** Deepest level a new collection may have (0 = unlimited) */
  maxDepth: number;
  /** Paths already suggested, to be reused when the topic matches */
  openPaths: string[];
}

const baseSchema = z.object({
  collectionIDs: z.array(z.union([z.number(), z.string()])),
  chineseTitle: z.string().optional(),
});

// Only sent when the AI may suggest a new collection
const proposalSchema = baseSchema.extend({
  newCollection: z
    .object({ parentID: z.number().nullable(), name: z.string() })
    .nullish(),
});

// Hidden format instruction - not editable by user
const FORMAT_INSTRUCTION = `规则：可用分类每行格式为 [分类ID] 分类路径。只能选择列表中已存在的分类ID，在 collectionIDs 字段中返回数字ID数组，不要返回分类路径。无合适分类时返回空数组。`;

// Hidden translation instruction - appended when translation is enabled
const TRANSLATION_INSTRUCTION = `另外，请将文献标题翻译成中文，填入 chineseTitle 字段。`;

/**
 * Build the instruction that lets the AI suggest a new collection
 * @param options - Limits for the suggestion
 * @returns The instruction text
 */
function buildProposalInstruction(options: ProposalOptions): string {
  const top = options.allowTopLevel
    ? "，为 null 表示新建顶级分类"
    : "，不允许新建顶级分类";
  const depth =
    options.maxDepth > 0 ? `新分类的层级不得超过 ${options.maxDepth} 层。` : "";
  return `如果现有分类都不合适，可以在 newCollection 字段中建议新建一个分类：parentID 为父分类ID（只能从“可作为父分类”列表中选择${top}），name 为新分类名称（简短，不含“/”）。仅在确实没有合适分类时才建议，否则不要返回 newCollection。${depth}`;
}

/**
 * Build the part of the user prompt that lists parents and open suggestions
 * @param options - Limits for the suggestion
 * @returns The prompt text
 */
function buildProposalContext(options: ProposalOptions): string {
  const parents = options.parents.map((p) => `[${p.id}] ${p.path}`).join("\n");
  const open = options.openPaths.length
    ? `\n\n已建议的新分类（主题相同请使用完全相同的名称）:\n${options.openPaths.join(
        "\n"
      )}`
    : "";
  return `\n\n可作为父分类:\n${parents}${open}`;
}

/**
 * Load the LLM layer. The AI SDK needs web stream globals that Zotero's plugin
 * sandbox lacks, so it is imported lazily, after they are copied from the main window.
 */
async function loadLLM() {
  exposeWebGlobals(Zotero.getMainWindow());
  return import("./llm");
}

/**
 * Call AI API for classification
 * @param title - Article title
 * @param abstract - Article abstract
 * @param collectionCandidates - Available collection IDs and display paths
 * @param includeTranslation - Whether to include Chinese title translation
 * @param proposals - When set, the AI may suggest one new collection
 * @returns Object with recommended collection paths and optional Chinese title
 */
export async function callAI(
  title: string,
  abstract: string,
  collectionCandidates: AICollectionCandidate[],
  includeTranslation = false,
  proposals?: ProposalOptions
): Promise<AIClassificationResult> {
  const apiUrl = getPref("apiUrl") as string;
  const model = getPref("model") as string;
  const apiKey = getPref("apiKey") as string;
  const provider = (getPref("provider") as ProviderKind) || "openai-compatible";
  const customPrompt = (getPref("customPrompt") as string) || DEFAULT_PROMPT;

  if (!apiUrl || !apiKey) {
    throw new Error("API URL and API Key must be configured in preferences");
  }

  const collectionListStr = collectionCandidates
    .map((candidate, i) => `${i + 1}. [${candidate.id}] ${candidate.path}`)
    .join("\n");

  // Build system prompt with user-editable part and hidden format instruction
  const systemPrompt = [
    customPrompt,
    FORMAT_INSTRUCTION,
    includeTranslation ? TRANSLATION_INSTRUCTION : "",
    proposals ? buildProposalInstruction(proposals) : "",
  ]
    .filter(Boolean)
    .join("\n");

  const userPrompt = `标题: ${title}
摘要: ${abstract}

可用分类:
${collectionListStr}${proposals ? buildProposalContext(proposals) : ""}`;

  const schema: z.ZodType<z.infer<typeof proposalSchema>> = proposals
    ? proposalSchema
    : baseSchema;

  const { generateJSON, toBaseURL } = await loadLLM();
  const result = await generateJSON(
    { provider, baseURL: toBaseURL(apiUrl), apiKey, model },
    systemPrompt,
    userPrompt,
    schema
  );

  return {
    ...parseCollectionSelection(result.collectionIDs),
    chineseTitle: result.chineseTitle,
    newCollection: result.newCollection ?? undefined,
  };
}

/**
 * Test API connection
 * @returns Object with success status and message
 */
export async function testConnection(): Promise<{
  success: boolean;
  message?: string;
}> {
  try {
    const result = await callAI("Test Title", "Test Abstract", [
      { id: 1, path: "Test/Category" },
    ]);
    if (
      Array.isArray(result.collectionIDs) &&
      Array.isArray(result.collections)
    ) {
      return { success: true, message: "API response received successfully" };
    }
    return { success: false, message: "Unexpected response format" };
  } catch (e: any) {
    ztoolkit.log("API connection test failed:", e);
    return { success: false, message: e.message || "Unknown error" };
  }
}
