import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { classifyItems } from "./classifier";

const DEBOUNCE_MS = 10000;
const DEFAULT_THRESHOLD = 5;

let observerID: string | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
// Items already offered for classification this session, so rejected ones don't re-trigger.
const offered = new Set<number>();

/**
 * Get regular items that are not in any collection
 * @param libraryID - The library ID (defaults to the user library)
 * @returns The unfiled items
 */
export async function getUnfiledItems(
  libraryID: number = Zotero.Libraries.userLibraryID
): Promise<Zotero.Item[]> {
  const search = new Zotero.Search();
  search.addCondition("libraryID", "is", String(libraryID));
  search.addCondition("unfiled", "true");
  search.addCondition("noChildren", "true");
  const ids = await search.search();
  const items = await Zotero.Items.getAsync(ids);
  return items.filter((item) => item.isRegularItem() && !item.deleted);
}

/**
 * Menu action: classify every unfiled item.
 */
export async function classifyUnfiled(): Promise<void> {
  const items = await getUnfiledItems();
  if (items.length === 0) {
    Zotero.getMainWindow().alert(
      getString("error.nounfiled") || "No unfiled items found"
    );
    return;
  }
  await classifyItems(items);
}

async function autoClassify(): Promise<void> {
  if (running || !getPref("autoClassifyUnfiled")) {
    return;
  }
  const threshold =
    Number(getPref("autoClassifyThreshold")) || DEFAULT_THRESHOLD;
  const fresh = (await getUnfiledItems()).filter((i) => !offered.has(i.id));
  if (fresh.length <= threshold) {
    return;
  }
  running = true;
  try {
    fresh.forEach((i) => offered.add(i.id));
    await classifyItems(fresh);
  } catch (e) {
    ztoolkit.log("Auto-classify failed:", e);
  } finally {
    running = false;
  }
}

/**
 * Watch for new items and auto-classify once more than the threshold are unfiled.
 */
export function registerUnfiledObserver(): void {
  observerID = Zotero.Notifier.registerObserver(
    {
      notify: (event: string) => {
        if (event !== "add") {
          return;
        }
        clearTimeout(timer);
        timer = setTimeout(autoClassify, DEBOUNCE_MS);
      },
    },
    ["item"],
    `${config.addonRef}-unfiled`
  );
}

export function unregisterUnfiledObserver(): void {
  clearTimeout(timer);
  if (observerID) {
    Zotero.Notifier.unregisterObserver(observerID);
    observerID = undefined;
  }
}
