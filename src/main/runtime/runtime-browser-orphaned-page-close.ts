import { BrowserError } from '../browser/browser-error'
import type { RuntimeBrowserCommandHost } from './browser/browser-command-contracts'

type OrphanedPageCloseHost = Pick<
  RuntimeBrowserCommandHost,
  | 'getRuntimeBrowserPageRegistry'
  | 'getBrowserHostLeaseRegistry'
  | 'resolveBrowserWorkspace'
  | 'retireRuntimeOwnedBrowserSessionTab'
  | 'notifyHeadlessBrowserSessionTabsChanged'
>

/** A retained client page can be dismissed without starting a local browser provider. */
export async function retireOrphanedClientBrowserPage(
  host: OrphanedPageCloseHost,
  params: { page?: string; worktree?: string }
): Promise<boolean> {
  if (!params.page) {
    return false
  }
  const pages = host.getRuntimeBrowserPageRegistry()
  const page = pages.getPage(params.page)
  if (!page) {
    return false
  }
  const authority = host.getBrowserHostLeaseRegistry()
  if (authority.getPlacement(page.browserPageId)) {
    return false
  }
  if (params.worktree) {
    const workspace = await host.resolveBrowserWorkspace(params.worktree)
    if (workspace.id !== page.workspaceId) {
      throw new BrowserError(
        'browser_tab_not_found',
        `Browser page ${page.browserPageId} was not found in this worktree`
      )
    }
  }
  // A client may have reclaimed the page while its workspace selector was resolving.
  if (authority.getPlacement(page.browserPageId)) {
    return false
  }
  if (!pages.retirePage(page.browserPageId, page.placement)) {
    throw new Error('browser_page_placement_stale')
  }
  if (host.retireRuntimeOwnedBrowserSessionTab) {
    host.retireRuntimeOwnedBrowserSessionTab(page.workspaceId, page.browserPageId)
  } else {
    host.notifyHeadlessBrowserSessionTabsChanged?.(page.workspaceId)
  }
  return true
}
