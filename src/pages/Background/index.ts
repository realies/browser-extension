import {
  getBrowser,
  getCurrentTabInfo,
  updateBadge,
} from '../../@/lib/utils.ts';
import { getConfig, isConfigured } from '../../@/lib/config.ts';
import { postLinkFetch } from '../../@/lib/actions/links.ts';
import {
  bookmarkMetadata,
  getBookmarksMetadata,
  saveBookmarkMetadata,
} from '../../@/lib/cache.ts';
import { getCollections } from '../../@/lib/actions/collections.ts';
import { saveAllTabsToLinkwarden } from '../../@/lib/saveAllTabs.ts';
import ContextType = chrome.contextMenus.ContextType;
import OnInputEnteredDisposition = chrome.omnibox.OnInputEnteredDisposition;

// Narrow intersection of `chrome.contextMenus.OnClickData` and
// `browser.contextMenus.OnClickData` that covers everything this handler
// actually reads. Avoids a cross-browser-type mismatch on `mediaType`.
type ContextMenuClickInfo = {
  menuItemId: string | number;
};

// Structural type describing the fields `genericOnClick` reads off the
// click-source tab. `chrome.tabs.Tab` and `browser.tabs.Tab` (the
// webextension-polyfill shape) differ on optional fields like `selected`
// and `groupId`, so accepting the shared intersection here lets us pass
// the argument through from either runtime without a hard type assertion.
type ClickSourceTab = {
  id?: number;
  url?: string;
  title?: string;
};

const browser = getBrowser();

// All "Save all tabs to: X" submenu items live under this parent. The parent
// id is also used as a prefix when encoding a chosen collection into the
// child id, so we can parse it back in the click handler without a separate
// mapping table.
const SAVE_ALL_TABS_PARENT_ID = 'save-all-tabs';
const SAVE_ALL_TABS_CHILD_PREFIX = 'save-all-tabs::';
const SAVE_ALL_TABS_DEFAULT_ID = `${SAVE_ALL_TABS_CHILD_PREFIX}__default__`;
const SAVE_ALL_TABS_NEEDS_CONFIG_ID = `${SAVE_ALL_TABS_CHILD_PREFIX}__needs_config__`;
// The Chrome context menu gets visually crowded and slow to render past a
// certain size. We surface the first N collections alphabetically and tell
// users the rest are available via the extension popup.
const MAX_COLLECTION_MENU_ITEMS = 20;

// Minimum gap between two context-menu rebuilds. `storage.onChanged` can
// fire several times in quick succession when settings are saved (the
// options page writes multiple keys, and browsers coalesce change events
// per-key not per-transaction). Rebuilding the whole submenu for each
// change also costs a /api/v1/collections round-trip, so debounce to a
// single rebuild per burst. Stored in `chrome.storage.local` rather than
// a module-level variable because MV3 service workers get torn down and
// restarted at will — an in-memory timestamp would reset to 0 on wake-up
// and defeat the debounce.
const MENU_REBUILD_DEBOUNCE_MS = 1000;
const MENU_REBUILD_STORAGE_KEY = 'linkwarden_last_menu_rebuild_at';

// How long the save-all-tabs status badge stays on the toolbar icon
// before we revert to the normal "is this URL saved?" indicator. Long
// enough to be read, short enough that it doesn't linger past the
// user's next tab interaction.
const SAVE_ALL_BADGE_MS = 3000;

// --------- Menu construction -----------------------------------------------

async function rebuildContextMenus() {
  await new Promise<void>((resolve) =>
    browser.contextMenus.removeAll(() => resolve())
  );

  const contexts: ContextType[] = [
    'page',
    'selection',
    'link',
    'editable',
    'image',
    'video',
    'audio',
  ];
  for (const context of contexts) {
    browser.contextMenus.create({
      title: 'Add link to Linkwarden',
      contexts: [context],
      id: context,
    });
  }

  browser.contextMenus.create({
    id: SAVE_ALL_TABS_PARENT_ID,
    title: 'Save all tabs to Linkwarden…',
    contexts: ['page'],
  });

  const configured = await isConfigured();
  if (!configured) {
    // Can't call the API without credentials; surface a hint instead of
    // silently showing an empty menu.
    browser.contextMenus.create({
      id: SAVE_ALL_TABS_NEEDS_CONFIG_ID,
      parentId: SAVE_ALL_TABS_PARENT_ID,
      title: 'Configure Linkwarden first…',
      contexts: ['page'],
    });
    return;
  }

  // "Default" target — matches the original PR #113 behaviour, writes to the
  // user's configured default collection (usually "Unorganized"). Kept as a
  // quick-win option at the top of the submenu.
  browser.contextMenus.create({
    id: SAVE_ALL_TABS_DEFAULT_ID,
    parentId: SAVE_ALL_TABS_PARENT_ID,
    title: 'Default collection',
    contexts: ['page'],
  });

  browser.contextMenus.create({
    id: `${SAVE_ALL_TABS_PARENT_ID}::__separator__`,
    parentId: SAVE_ALL_TABS_PARENT_ID,
    type: 'separator',
    contexts: ['page'],
  });

  try {
    const config = await getConfig();
    const resp = await getCollections(config.baseUrl, config.apiKey);
    const collections = (resp.data.response ?? [])
      .slice()
      .sort((a, b) =>
        (a.pathname || a.name).localeCompare(b.pathname || b.name)
      );

    const shown = collections.slice(0, MAX_COLLECTION_MENU_ITEMS);
    for (const collection of shown) {
      browser.contextMenus.create({
        id: `${SAVE_ALL_TABS_CHILD_PREFIX}${collection.id}`,
        parentId: SAVE_ALL_TABS_PARENT_ID,
        title: collection.pathname || collection.name,
        contexts: ['page'],
      });
    }

    if (collections.length > shown.length) {
      browser.contextMenus.create({
        id: `${SAVE_ALL_TABS_CHILD_PREFIX}__more__`,
        parentId: SAVE_ALL_TABS_PARENT_ID,
        title: `(${
          collections.length - shown.length
        } more — open the popup to choose)`,
        enabled: false,
        contexts: ['page'],
      });
    }

    browser.contextMenus.create({
      id: `${SAVE_ALL_TABS_PARENT_ID}::__popup_hint_separator__`,
      parentId: SAVE_ALL_TABS_PARENT_ID,
      type: 'separator',
      contexts: ['page'],
    });

    // Context menus can't take free-text input, and the only API that opens
    // the toolbar popup from a service worker — `chrome.action.openPopup()`
    // — is Chrome 127+ only (policy-only on 121-126, matching our manifest's
    // `minimum_chrome_version`). Rather than ship a menu entry that silently
    // falls back to the options page for a range of Chrome users, point the
    // user at the popup (icon-click) where the Create-new flow already lives.
    browser.contextMenus.create({
      id: `${SAVE_ALL_TABS_CHILD_PREFIX}__popup_hint__`,
      parentId: SAVE_ALL_TABS_PARENT_ID,
      title: 'For a new collection, open the extension popup',
      enabled: false,
      contexts: ['page'],
    });
  } catch (error) {
    console.error('Failed to load collections for context menu', error);
  }
}

// Coalesce rebuild bursts using a persisted timestamp. Returns without
// rebuilding if the previous rebuild was less than
// `MENU_REBUILD_DEBOUNCE_MS` ago, otherwise stamps "now" and rebuilds.
// Stamping *before* the rebuild means a failed rebuild doesn't re-trigger
// on the next change — acceptable trade-off since the next settings write
// will re-run it anyway.
async function rebuildContextMenusDebounced(): Promise<void> {
  try {
    const stored = await browser.storage.local.get([MENU_REBUILD_STORAGE_KEY]);
    const last = Number(stored?.[MENU_REBUILD_STORAGE_KEY]);
    const now = Date.now();
    if (Number.isFinite(last) && now - last < MENU_REBUILD_DEBOUNCE_MS) {
      return;
    }
    await browser.storage.local.set({ [MENU_REBUILD_STORAGE_KEY]: now });
  } catch (error) {
    // Storage failure here is not fatal — fall through and rebuild
    // unconditionally so the menu is never *more* stale because the
    // debounce itself broke.
    console.error('Menu-rebuild debounce storage read/write failed', error);
  }
  await rebuildContextMenus();
}

// --------- Save-all-tabs badge feedback ------------------------------------

// Set a one-shot status badge on the active tab's icon, then restore the
// normal "is this URL saved?" indicator after SAVE_ALL_BADGE_MS. Using the
// existing `action.setBadgeText` API means we don't need the `notifications`
// permission just to tell the user their save-all completed. If the tab id
// isn't known (right-click on a page with no id), silently no-op.
async function flashBadge(
  tabId: number | undefined,
  text: string,
  color: string
): Promise<void> {
  if (!tabId) return;
  const action = browser.action ?? browser.browserAction;
  if (!action) return;
  try {
    await action.setBadgeBackgroundColor({ tabId, color });
    await action.setBadgeText({ tabId, text });
  } catch (error) {
    // Badge APIs can throw if the tab has closed between the save and
    // the badge update; not worth surfacing.
    console.error('Failed to set save-all badge', error);
    return;
  }
  setTimeout(() => {
    // updateBadge recomputes from the real "is this URL saved?" state so
    // we don't leave a stale ✓/! sitting on the icon.
    updateBadge(tabId).catch((error) =>
      console.error('Failed to restore badge after save-all', error)
    );
  }, SAVE_ALL_BADGE_MS);
}

// --------- Context-menu click handler --------------------------------------

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  await genericOnClick(info as ContextMenuClickInfo, tab);
});

async function genericOnClick(
  info: ContextMenuClickInfo,
  tab: ClickSourceTab | undefined
) {
  const config = await getConfig();
  const configured = await isConfigured();

  const menuId = String(info.menuItemId);

  if (!configured) {
    if (menuId === SAVE_ALL_TABS_NEEDS_CONFIG_ID) {
      browser.runtime.openOptionsPage();
    }
    return;
  }

  if (menuId.startsWith(SAVE_ALL_TABS_CHILD_PREFIX)) {
    const suffix = menuId.slice(SAVE_ALL_TABS_CHILD_PREFIX.length);
    // Non-actionable entries rendered as hints in the submenu.
    if (suffix === '__more__' || suffix === '__popup_hint__') return;

    const badgeTabId = tab?.id;
    await flashBadge(badgeTabId, '…', '#98c0ff');

    try {
      if (suffix === '__default__') {
        const result = await saveAllTabsToLinkwarden({
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          target: {
            kind: 'collectionName',
            name: config.defaultCollection || 'Unorganized',
          },
        });
        await flashBadge(
          badgeTabId,
          result.failed > 0 ? '!' : '✓',
          result.failed > 0 ? '#e5a05a' : '#98c0ff'
        );
        return;
      }

      const collectionId = Number(suffix);
      if (!Number.isFinite(collectionId)) return;

      const result = await saveAllTabsToLinkwarden({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        target: {
          kind: 'collectionId',
          id: collectionId,
        },
      });
      await flashBadge(
        badgeTabId,
        result.failed > 0 ? '!' : '✓',
        result.failed > 0 ? '#e5a05a' : '#98c0ff'
      );
    } catch (error) {
      console.error('Save-all-tabs failed', error);
      await flashBadge(badgeTabId, '!', '#e5a05a');
    }
    return;
  }

  // Per-context "Add link to Linkwarden" items (page / selection / link / …).
  if (!tab?.url || !tab?.title) return;

  if (config.syncBookmarks) {
    browser.bookmarks.create({
      parentId: '1',
      title: tab.title,
      url: tab.url,
    });
    return;
  }

  try {
    const newLink = await postLinkFetch(
      config.baseUrl,
      {
        url: tab.url,
        collection: {
          name: config.defaultCollection || 'Unorganized',
        },
        tags: [],
        name: tab.title,
        description: tab.title,
      },
      config.apiKey
    );

    const newLinkJson = await newLink.json();
    const newLinkUrl: bookmarkMetadata = newLinkJson.response;
    newLinkUrl.bookmarkId = tab.id?.toString();
    await saveBookmarkMetadata(newLinkUrl);
  } catch (error) {
    console.error(error);
  }
}

// --------- Lifecycle hooks --------------------------------------------------

browser.runtime.onInstalled.addListener(async () => {
  await rebuildContextMenus();
  const { id: tabId } = await getCurrentTabInfo();
  await updateBadge(tabId);
});

// Fired when the browser starts and the profile is loaded. Context menu
// entries created in a previous session survive the restart, but collections
// may have changed on the server since; refresh to stay in sync.
const onStartup = browser.runtime.onStartup;
if (onStartup?.addListener) {
  onStartup.addListener(async () => {
    await rebuildContextMenus();
  });
}

// Rebuild when the user updates their Linkwarden config (new API key, new
// default collection, etc.) so the submenu reflects the current server.
// Goes through the debouncer because options-page saves can fire several
// change events in a single user gesture and each rebuild hits the API.
if (browser.storage?.onChanged?.addListener) {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!changes.linkwarden_config) return;
    rebuildContextMenusDebounced().catch((err) =>
      console.error('Failed to rebuild context menus', err)
    );
  });
}

browser.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    await updateBadge(tabId);
  } catch (error) {
    console.error(`Error checking tab ${tabId} on activation:`, error);
  }
});

browser.tabs.onUpdated.addListener(async (tabId) => {
  try {
    await updateBadge(tabId);
  } catch (error) {
    console.error(`Error checking tab ${tabId} on activation:`, error);
  }
});

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  try {
    if (changeInfo.status === 'complete' && tab?.active) {
      await updateBadge(tabId);
    }
  } catch (error) {
    console.error(`Error checking tab ${tabId} on update:`, error);
  }
});

// On extension startup - check current tab
(async () => {
  try {
    const [tab] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tab?.id) {
      await updateBadge(tab.id);
    }
  } catch (error) {
    console.error(`Error checking tab on startup:`, error);
  }
})();

// --------- Omnibox ----------------------------------------------------------

browser.omnibox.onInputStarted.addListener(async () => {
  const configured = await isConfigured();
  const description = configured
    ? 'Search links in linkwarden'
    : 'Please configure the extension first';

  browser.omnibox.setDefaultSuggestion({
    description: description,
  });
});

browser.omnibox.onInputChanged.addListener(
  async (
    text: string,
    suggest: (arg0: { content: string; description: string }[]) => void
  ) => {
    const configured = await isConfigured();
    if (!configured) return;

    const currentBookmarks = await getBookmarksMetadata();

    const searchedBookmarks = currentBookmarks.filter((bookmark) => {
      return bookmark.name?.includes(text) || bookmark.url.includes(text);
    });

    const bookmarkSuggestions = searchedBookmarks.map((bookmark) => {
      return {
        content: bookmark.url,
        description: bookmark.name || bookmark.url,
      };
    });
    suggest(bookmarkSuggestions);
  }
);

// This part was taken https://github.com/sissbruecker/linkding-extension/blob/master/src/background.js Thanks to @sissbruecker

browser.omnibox.onInputEntered.addListener(
  async (content: string, disposition: OnInputEnteredDisposition) => {
    if (!(await isConfigured()) || !content) return;

    const isUrl = /^http(s)?:\/\//.test(content);
    const url = isUrl ? content : `lk`;

    if (disposition === 'currentTab') {
      const tabInfo = await getCurrentTabInfo();
      if (tabInfo.url === 'edge://newtab/') {
        disposition = 'newForegroundTab';
      }
    }

    switch (disposition) {
      case 'currentTab':
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        await browser.tabs.update({ url });
        break;
      case 'newForegroundTab':
        await browser.tabs.create({ url });
        break;
      case 'newBackgroundTab':
        await browser.tabs.create({ url, active: false });
        break;
    }
  }
);
