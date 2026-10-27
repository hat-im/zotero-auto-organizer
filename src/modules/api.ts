import { z } from "zod";
import { getPref } from "../utils/prefs";
import { exposeWebGlobals } from "../utils/webGlobals";
import { DEFAULT_PROMPT } from "../utils/constants";
import type { ProviderKind } from "./llm";
import { parseCollectionSelection } from "./selection";

export interface AICollectionCandidate {
  id: number;
  path: string;
}

interface AIClassificationResult {
  collectionIDs: number[];
  collections: string[];
  chineseTitle?: string;
}

const responseSchema = z.object({
  collectionIDs: z.array(z.union([z.number(), z.string()])),
  chineseTitle: z.string().optional(),
});

// Hidden format instruction - not editable by user
const FORMAT_INSTRUCTION = `规则：可用分类每行格式为 [分类ID] 分类路径。只能选择列表中已存在的分类ID，在 collectionIDs 字段中返回数字ID数组，不要返回分类路径。无合适分类时返回空数组。`;

// Hidden translation instruction - appended when translation is enabled
const TRANSLATION_INSTRUCTION = `另外，请将文献标题翻译成中文，填入 chineseTitle 字段。`;

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
 * @returns Object with recommended collection paths and optional Chinese title
 */
export async function callAI(
  title: string,
  abstract: string,
  collectionCandidates: AICollectionCandidate[],
  includeTranslation = false
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
  ]
    .filter(Boolean)
    .join("\n");

  const userPrompt = `标题: ${title}
摘要: ${abstract}

可用分类:
${collectionListStr}`;

  const { generateJSON, toBaseURL } = await loadLLM();
  const result = await generateJSON(
    { provider, baseURL: toBaseURL(apiUrl), apiKey, model },
    systemPrompt,
    userPrompt,
    responseSchema
  );

  return {
    ...parseCollectionSelection(result.collectionIDs),
    chineseTitle: result.chineseTitle,
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
