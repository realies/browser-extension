import { getBrowser } from './utils.ts';
import { postLinkFetch } from './actions/links.ts';
import { getCollections, postCollection } from './actions/collections.ts';

/**
 * Shared "save every tab in the current window to Linkwarden" routine,
 * used by both the popup "Save all tabs" button and the background
 * context menu.
 *
 * The old implementation (PR #113) inlined this in the context-menu
 * handler and always wrote to `config.defaultCollection`, which is why
 * users complained that tabs landed in "Unorganized" (issue #458).
 * Callers now pass an explicit collection target so the destination can
 * be chosen per invocation — either an existing collection id or a name
 * (which is resolved to an existing collection, or freshly created,
 * exactly once before the save loop starts).
 */
export type SaveAllTabsTarget =
  | { kind: 'collectionId'; id: number; name?: string }
  | { kind: 'collectionName'; name: string };

export type SaveAllTabsResult = {
  total: number;
  saved: number;
  skipped: number;
  failed: number;
  collectionId: number | undefined;
  collectionName: string;
  createdNewCollection: boolean;
};

// URLs that a normal POST can't usefully archive and that would just
// error out on the server. Kept as a list rather than a single regex for
// readability and easy extension. The subsequent `URL.protocol` check
// covers anything this list misses.
const SKIP_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'edge://',
  'about:',
  'moz-extension://',
  'view-source:',
];

const shouldSkip = (url: string | undefined): boolean => {
  if (!url) return true;
  for (const prefix of SKIP_PREFIXES) {
    if (url.startsWith(prefix)) return true;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return true;
    }
  } catch {
    return true;
  }
  return false;
};

/**
 * Resolve the caller's target into a concrete `{id, name}` pair that
 * every tab save will share. This is important because the server's
 * setCollection helper *always* creates a fresh collection when only a
 * name is supplied (except for the special "Unorganized" sentinel), so
 * passing `{name: 'Reading'}` on 20 tabs would produce 20 duplicate
 * "Reading" collections. Doing find-or-create here once guarantees the
 * batch lands in a single collection.
 */
async function resolveTarget(params: {
  baseUrl: string;
  apiKey: string;
  target: SaveAllTabsTarget;
}): Promise<{ id?: number; name: string; createdNew: boolean }> {
  const { target } = params;
  // Exhaustive switch so a future `SaveAllTabsTarget` variant becomes a
  // compile error here instead of silently falling through to the
  // name-resolution path and crashing on a missing `name` at runtime.
  switch (target.kind) {
    case 'collectionId':
      return {
        id: target.id,
        name: target.name ?? '',
        createdNew: false,
      };
    case 'collectionName': {
      const desired = target.name.trim();
      // "Unorganized" is a server-side sentinel: setCollection
      // finds-or-creates it only on exact-string match, so canonicalise
      // any casing the user typed (e.g. "unorganized", "UNORGANIZED") to
      // the exact sentinel value here. Previously a typed-case variant
      // landed in a new, distinct lowercase collection.
      if (!desired || desired.toLowerCase() === 'unorganized') {
        return {
          id: undefined,
          name: 'Unorganized',
          createdNew: false,
        };
      }

      try {
        const { data } = await getCollections(params.baseUrl, params.apiKey);
        const normalised = desired.toLowerCase();
        // Match either by bare name or by full slash-joined pathname
        // (e.g. "Reading > Books"), and across every depth — gating on
        // `parentId === null` silently created a duplicate top-level
        // collection whenever the user typed the name of a nested
        // collection.
        const match = (data.response ?? []).find(
          (c) =>
            c.name.toLowerCase() === normalised ||
            (c.pathname && c.pathname.toLowerCase() === normalised)
        );
        if (match) {
          return { id: match.id, name: match.name, createdNew: false };
        }
      } catch (error) {
        // If listing fails we don't want to silently create a
        // duplicate; surface the error to the caller instead.
        throw new Error(
          `Could not list collections while resolving the target collection. ${
            error instanceof Error ? error.message : ''
          }`.trim()
        );
      }

      const created = await postCollection(params.baseUrl, params.apiKey, {
        name: desired,
      });
      // Guard against a 2xx response with a malformed body that lacks
      // `id` — without this check every tab in the loop below would
      // fall back to the `name`-only path, and the server would create
      // a fresh "Reading" collection per tab (the very bug this
      // function exists to prevent).
      if (typeof created?.id !== 'number') {
        throw new Error(
          'Collection created but response did not include an id. Retry the import.'
        );
      }
      return { id: created.id, name: created.name, createdNew: true };
    }
    default: {
      const _exhaustive: never = target;
      throw new Error(
        `Unknown SaveAllTabsTarget kind: ${JSON.stringify(_exhaustive)}`
      );
    }
  }
}

export async function saveAllTabsToLinkwarden(params: {
  baseUrl: string;
  apiKey: string;
  target: SaveAllTabsTarget;
  onProgress?: (progress: SaveAllTabsResult) => void;
}): Promise<SaveAllTabsResult> {
  const browser = getBrowser();
  const tabs = await browser.tabs.query({ currentWindow: true });

  const resolved = await resolveTarget(params);

  // Build `result` immutably: every update produces a fresh object and
  // rebinds `result`. Matches the project's immutability contract and
  // keeps `onProgress` listeners from observing partially-updated
  // mid-loop state through shared object references.
  let result: SaveAllTabsResult = {
    total: tabs.length,
    saved: 0,
    skipped: 0,
    failed: 0,
    collectionId: resolved.id,
    collectionName: resolved.name,
    createdNewCollection: resolved.createdNew,
  };

  const emitProgress = () => params.onProgress?.(result);

  // Serial rather than parallel on purpose: the server's /api/v1/links
  // handler can trigger archival work per link, and blasting 50+
  // parallel requests into a self-hosted instance is a good way to get
  // rate-limited or tip it over. A tight loop is plenty fast for a
  // typical window of tabs.
  for (const tab of tabs) {
    const url = tab.url;
    if (!url || shouldSkip(url)) {
      result = { ...result, skipped: result.skipped + 1 };
      emitProgress();
      continue;
    }

    const collectionPayload =
      resolved.id !== undefined
        ? { id: resolved.id, name: resolved.name }
        : { name: resolved.name };

    try {
      await postLinkFetch(
        params.baseUrl,
        {
          url,
          name: tab.title || '',
          description: '',
          collection: collectionPayload,
          tags: [],
        },
        params.apiKey
      );
      result = { ...result, saved: result.saved + 1 };
    } catch (error) {
      result = { ...result, failed: result.failed + 1 };
      // Log host only, not the full URL. Tab URLs can carry session
      // tokens / OAuth codes in query strings; we don't want those in
      // extension DevTools beyond what's needed for debugging.
      let host = 'unknown';
      try {
        host = new URL(url).host;
      } catch {
        // fall through; host stays "unknown"
      }
      console.error(`Failed to save tab (host=${host})`, error);
    }
    emitProgress();
  }

  return result;
}
