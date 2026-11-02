import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getProposalOptions,
  recordSuggestion,
  reviewSuggestions,
} from "../src/modules/newCollections.ts";

const PREFIX = "extensions.zotero.zoteroaicollection";
const LIBRARY = 1;

class FakeCollection {
  id = 0;
  libraryID: number;
  name: string;
  parentID?: number;
  children: FakeCollection[] = [];

  constructor(params: { libraryID: number; name: string; parentID?: number }) {
    this.libraryID = params.libraryID;
    this.name = params.name;
    this.parentID = params.parentID;
  }

  getChildCollections() {
    return this.children;
  }

  async saveTx() {
    this.id = world.saved.length + 1;
    world.saved.push(this);
    world.saved.find((c) => c.id === this.parentID)?.children.push(this);
  }
}

class FakeItem {
  static nextID = 1;
  id = FakeItem.nextID++;
  deleted = false;
  collections: number[] = [];

  constructor(public key: string, public title: string) {}

  getCollections() {
    return this.collections;
  }

  getField() {
    return this.title;
  }

  addToCollection(id: number) {
    this.collections.push(id);
  }

  removeFromCollection(id: number) {
    this.collections = this.collections.filter((c) => c !== id);
  }

  async saveTx() {}
}

interface World {
  saved: FakeCollection[];
  items: Map<string, FakeItem>;
  prefs: Record<string, unknown>;
  dialogs: string[];
  alerts: string[];
  choice: number;
}

let world: World;

function pref(name: string): unknown {
  return world.prefs[`${PREFIX}.${name}`];
}

async function addCollections(...paths: string[]) {
  for (const path of paths) {
    const segments = path.split("/");
    const parent = world.saved.find(
      (c) => c.name === segments[segments.length - 2]
    );
    const collection = new FakeCollection({
      libraryID: LIBRARY,
      name: segments[segments.length - 1],
      parentID: parent?.id,
    });
    await collection.saveTx();
  }
}

function addItems(count: number): FakeItem[] {
  return Array.from({ length: count }, (_, i) => {
    const item = new FakeItem(`K${world.items.size}`, `Paper ${i}`);
    world.items.set(item.key, item);
    return item;
  });
}

function suggest(
  items: FakeItem[],
  suggestion = { parentID: 1, name: "Walks" }
) {
  for (const item of items) {
    recordSuggestion(item as any, {
      collectionIDs: [],
      collections: [],
      newCollection: suggestion,
    });
  }
}

beforeEach(async () => {
  FakeItem.nextID = 1;
  world = {
    saved: [],
    items: new Map(),
    prefs: {
      [`${PREFIX}.proposeNewCollections`]: true,
      [`${PREFIX}.proposalMinItems`]: 3,
      [`${PREFIX}.maxDepth`]: 2,
      [`${PREFIX}.allowNewTopLevel`]: false,
      [`${PREFIX}.pendingProposals`]: "{}",
    },
    dialogs: [],
    alerts: [],
    choice: 0,
  };
  const g = globalThis as any;
  g.addon = {
    data: {
      locale: { stringBundle: { GetStringFromName: (key: string) => key } },
    },
  };
  g.Zotero = {
    Prefs: {
      get: (key: string) => world.prefs[key],
      set: (key: string, value: unknown) => (world.prefs[key] = value),
    },
    Collection: FakeCollection,
    Collections: {
      getByLibrary: () => world.saved.filter((c) => !c.parentID),
    },
    Items: {
      getByLibraryAndKey: (_lib: number, key: string) =>
        world.items.get(key) ?? false,
    },
    getMainWindow: () => ({ alert: (m: string) => world.alerts.push(m) }),
  };
  g.Services = {
    prompt: {
      BUTTON_TITLE_IS_STRING: 127,
      BUTTON_POS_0: 1,
      BUTTON_POS_1: 256,
      BUTTON_POS_2: 65536,
      confirmEx: (_w: unknown, _t: string, message: string) => {
        world.dialogs.push(message);
        return world.choice;
      },
    },
  };
  await addCollections("Algorithms", "Algorithms/Core");
});

test("does nothing when suggestions are turned off", async () => {
  world.prefs[`${PREFIX}.proposeNewCollections`] = false;
  const items = addItems(3);
  suggest(items);

  await reviewSuggestions(LIBRARY, items as any);

  assert.equal(pref("pendingProposals"), "{}");
  assert.deepEqual(world.dialogs, []);
  assert.equal(getProposalOptions(LIBRARY), undefined);
});

test("stores suggestions for unfiled items and skips filed ones", async () => {
  const items = addItems(3);
  items[2].collections = [2];
  suggest(items);

  await reviewSuggestions(LIBRARY, items as any);

  const store = JSON.parse(pref("pendingProposals") as string);
  assert.deepEqual(Object.keys(store), ["Algorithms/Walks"]);
  assert.deepEqual(Object.keys(store["Algorithms/Walks"].items), ["K0", "K1"]);
  assert.deepEqual(world.dialogs, []);
});

test("ignores suggestions that break the rules", async () => {
  const items = addItems(2);
  suggest(items, { parentID: 2, name: "TooDeep" });
  await reviewSuggestions(LIBRARY, items as any);
  assert.equal(pref("pendingProposals"), "{}");

  suggest(items, { parentID: null as any, name: "TopLevel" });
  await reviewSuggestions(LIBRARY, items as any);
  assert.equal(pref("pendingProposals"), "{}");
});

test("asks once enough items share a suggestion, then creates it and moves them", async () => {
  const items = addItems(3);
  suggest(items);

  await reviewSuggestions(LIBRARY, items as any);

  assert.equal(world.dialogs.length, 1);
  assert.match(world.dialogs[0], /Algorithms\/Walks/);
  assert.match(world.dialogs[0], /Paper 0/);
  const walks = world.saved.find((c) => c.name === "Walks")!;
  assert.equal(walks.parentID, 1);
  assert.ok(items.every((item) => item.collections.includes(walks.id)));
  assert.equal(pref("pendingProposals"), "{}");
  assert.match(world.alerts[0], /Algorithms\/Walks/);
  assert.match(world.alerts[0], /3/);
});

test("skips deleted items when moving", async () => {
  const items = addItems(3);
  suggest(items);
  items[1].deleted = true;

  await reviewSuggestions(LIBRARY, items as any);

  const walks = world.saved.find((c) => c.name === "Walks")!;
  assert.deepEqual(
    items.map((i) => i.collections.includes(walks.id)),
    [true, false, true]
  );
});

test("'Not now' keeps the suggestion and asks again only after it grows", async () => {
  world.choice = 1;
  const items = addItems(3);
  suggest(items);
  await reviewSuggestions(LIBRARY, items as any);
  assert.equal(world.dialogs.length, 1);
  assert.equal(
    world.saved.some((c) => c.name === "Walks"),
    false
  );

  await reviewSuggestions(LIBRARY, items as any);
  assert.equal(world.dialogs.length, 1);

  const more = addItems(1);
  suggest(more);
  await reviewSuggestions(LIBRARY, more as any);
  assert.equal(world.dialogs.length, 2);
});

test("'Don't suggest again' stops the suggestion for good", async () => {
  world.choice = 2;
  const items = addItems(3);
  suggest(items);
  await reviewSuggestions(LIBRARY, items as any);

  const more = addItems(2);
  suggest(more);
  await reviewSuggestions(LIBRARY, more as any);

  assert.equal(world.dialogs.length, 1);
  assert.equal(
    world.saved.some((c) => c.name === "Walks"),
    false
  );
  assert.deepEqual(getProposalOptions(LIBRARY)!.openPaths, []);
});

test("does not create a collection that appeared in the meantime", async () => {
  world.choice = 1;
  const items = addItems(3);
  suggest(items);
  await reviewSuggestions(LIBRARY, items as any);

  await addCollections("Algorithms/Walks");
  world.choice = 0;
  const more = addItems(1);
  suggest(more, { parentID: 1, name: "Walks" });
  await reviewSuggestions(LIBRARY, more as any);

  assert.equal(world.saved.filter((c) => c.name === "Walks").length, 1);
});

test("items filed by hand leave the suggestion", async () => {
  const items = addItems(2);
  suggest(items);
  await reviewSuggestions(LIBRARY, items as any);

  items[0].collections = [2];
  await reviewSuggestions(LIBRARY, items as any);

  const store = JSON.parse(pref("pendingProposals") as string);
  assert.deepEqual(Object.keys(store["Algorithms/Walks"].items), ["K1"]);
});

test("offers parents within the depth limit and the open suggestions", async () => {
  const items = addItems(1);
  suggest(items);
  await reviewSuggestions(LIBRARY, items as any);

  const options = getProposalOptions(LIBRARY)!;

  assert.deepEqual(options.parents, [{ id: 1, path: "Algorithms" }]);
  assert.deepEqual(options.openPaths, ["Algorithms/Walks"]);
  assert.equal(options.maxDepth, 2);
  assert.equal(options.allowTopLevel, false);
});
