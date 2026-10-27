import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import type { AIClassificationResult, ProposalOptions } from "./api";
import {
  createMissingCollections,
  getCollectionsByPath,
} from "./collectionWriter";
import {
  addToStore,
  checkProposal,
  depthOf,
  dismiss,
  markPrompted,
  openPaths,
  parseStore,
  readyProposals,
  removeItems,
  removeProposal,
  type CollectionRef,
  type NewCollectionProposal,
  type PendingProposal,
  type ProposalLimits,
  type ProposalStore,
} from "./proposals";

const DEFAULT_MIN_ITEMS = 10;
const TITLES_SHOWN = 5;

// Suggestions made during the current run, by item ID
const suggestions = new Map<number, NewCollectionProposal>();

function isEnabled(): boolean {
  return getPref("proposeNewCollections") === true;
}

function readLimits(): ProposalLimits {
  return {
    maxDepth: Number(getPref("maxDepth")) || 0,
    allowTopLevel: getPref("allowNewTopLevel") === true,
  };
}

function readStore(): ProposalStore {
  return parseStore(getPref("pendingProposals") as string | undefined);
}

function writeStore(store: ProposalStore): void {
  setPref("pendingProposals", JSON.stringify(store));
}

function listCollections(libraryID: number): CollectionRef[] {
  return Array.from(getCollectionsByPath(libraryID), ([path, collection]) => ({
    id: collection.id,
    path,
  }));
}

/**
 * Get what the AI needs to suggest a new collection
 * @param libraryID - The library ID
 * @returns The options, or undefined when suggestions are turned off
 */
export function getProposalOptions(
  libraryID: number
): ProposalOptions | undefined {
  if (!isEnabled()) {
    return undefined;
  }
  const limits = readLimits();
  return {
    parents: listCollections(libraryID).filter(
      ({ path }) => limits.maxDepth === 0 || depthOf(path) < limits.maxDepth
    ),
    ...limits,
    openPaths: openPaths(readStore()),
  };
}

/**
 * Remember a new collection the AI suggested for an item
 * @param item - The item that was classified
 * @param result - The AI's answer
 */
export function recordSuggestion(
  item: Zotero.Item,
  result: AIClassificationResult
): void {
  if (isEnabled() && result.newCollection) {
    suggestions.set(item.id, result.newCollection);
  }
}

/**
 * Collect suggestions for items that stayed unfiled, then ask the user about
 * every suggestion that now has enough items.
 * @param libraryID - The library ID
 * @param items - The items that were just classified
 */
export async function reviewSuggestions(
  libraryID: number,
  items: Zotero.Item[]
): Promise<void> {
  if (!isEnabled()) {
    return;
  }
  const collections = listCollections(libraryID);
  const limits = readLimits();
  const isFiled = (item: Zotero.Item) => item.getCollections().length > 0;

  let store = removeItems(
    readStore(),
    items.filter(isFiled).map((item) => item.key)
  );
  for (const item of items) {
    const suggestion = suggestions.get(item.id);
    if (!suggestion || isFiled(item)) {
      continue;
    }
    const check = checkProposal(suggestion, collections, limits);
    if (check.ok) {
      store = addToStore(
        store,
        check.path,
        { parentID: check.parentID, name: suggestion.name },
        item.key,
        item.getField("title") as string
      );
    }
  }
  suggestions.clear();
  writeStore(store);

  const minItems = Number(getPref("proposalMinItems")) || DEFAULT_MIN_ITEMS;
  for (const path of readyProposals(store, minItems)) {
    await askAboutProposal(libraryID, path);
  }
}

/**
 * Ask whether to create a suggested collection and move its items into it
 * @param libraryID - The library ID
 * @param path - The path of the suggested collection
 */
async function askAboutProposal(
  libraryID: number,
  path: string
): Promise<void> {
  const proposal = readStore()[path];
  const titles = Object.values(proposal.items);
  const message = [
    path,
    `${getString("proposal.items")} ${titles.length}`,
    "",
    ...titles.slice(0, TITLES_SHOWN).map((title) => `• ${title}`),
    titles.length > TITLES_SHOWN ? "…" : "",
  ].join("\n");

  const prompts = Services.prompt;
  const flags =
    prompts.BUTTON_TITLE_IS_STRING *
    (prompts.BUTTON_POS_0 + prompts.BUTTON_POS_1 + prompts.BUTTON_POS_2);
  const choice = prompts.confirmEx(
    Zotero.getMainWindow(),
    getString("proposal.title"),
    message,
    flags,
    getString("proposal.create"),
    getString("proposal.later"),
    getString("proposal.never"),
    null,
    {}
  );

  if (choice === 0) {
    await createAndFile(libraryID, path, proposal);
  } else if (choice === 1) {
    writeStore(markPrompted(readStore(), path));
  } else {
    writeStore(dismiss(readStore(), path));
  }
}

/**
 * Create a suggested collection and move its items into it
 * @param libraryID - The library ID
 * @param path - The path of the suggested collection
 * @param proposal - The suggestion with its items
 */
async function createAndFile(
  libraryID: number,
  path: string,
  proposal: PendingProposal
): Promise<void> {
  const check = checkProposal(
    { parentID: proposal.parentID, name: proposal.name },
    listCollections(libraryID),
    readLimits()
  );
  if (!check.ok) {
    Zotero.getMainWindow().alert(`${path}: ${check.reason}`);
    writeStore(removeProposal(readStore(), path));
    return;
  }

  await createMissingCollections(libraryID, [path]);
  const collection = getCollectionsByPath(libraryID).get(path)!;
  let moved = 0;
  for (const key of Object.keys(proposal.items)) {
    const item = Zotero.Items.getByLibraryAndKey(libraryID, key) as
      | Zotero.Item
      | false;
    if (item && !item.deleted) {
      item.addToCollection(collection.id);
      await item.saveTx();
      moved++;
    }
  }
  writeStore(removeProposal(readStore(), path));
  Zotero.getMainWindow().alert(
    `${getString("proposal.created")} ${path}\n${getString(
      "proposal.moved"
    )} ${moved}`
  );
}
