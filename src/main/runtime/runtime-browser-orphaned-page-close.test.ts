import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeBrowserCommandHost } from './browser/browser-command-contracts'
import { BrowserError } from '../browser/browser-error'
import { RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT } from './client-hosted-browser-page-persistence'
import { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import {
  createRuntimeBrowserCommands,
  setRuntimeBrowserCommandsFactory
} from './runtime-browser-commands-factory'

function fixture() {
  const pages = new RuntimeBrowserPageRegistry()
  const input = {
    browserPageId: 'restored-page',
    workspaceId: 'folder-workspace',
    browserProfileId: 'default',
    executionHostKey: 'restored-client-host-execution',
    placement: RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT,
    url: 'https://example.com',
    loading: false,
    active: false
  }
  pages.publishClientPage(input)
  const getPlacement = vi.fn((): typeof input.placement | undefined => undefined)
  const resolveBrowserWorkspace = vi.fn(async () => ({ id: input.workspaceId }))
  const retireRuntimeOwnedBrowserSessionTab = vi.fn(() => true)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: orphan retirement reads only these host members; the fallback provider is a rejecting proxy.
  const host = {
    getRuntimeBrowserPageRegistry: () => pages,
    getBrowserHostLeaseRegistry: () => ({ getPlacement }),
    resolveBrowserWorkspace,
    retireRuntimeOwnedBrowserSessionTab
  } as unknown as RuntimeBrowserCommandHost
  return {
    host,
    pages,
    input,
    getPlacement,
    resolveBrowserWorkspace,
    retireRuntimeOwnedBrowserSessionTab
  }
}

afterEach(() => setRuntimeBrowserCommandsFactory(null))

describe('provider-independent orphan page close', () => {
  it('does not retire a replacement generation while resolving the workspace', async () => {
    const f = fixture()
    f.resolveBrowserWorkspace.mockImplementation(async () => {
      f.pages.retirePage(f.input.browserPageId, f.input.placement)
      f.pages.publishClientPage({
        ...f.input,
        placement: { ...f.input.placement, pageHostGeneration: 2 }
      })
      return { id: f.input.workspaceId }
    })
    await expect(
      createRuntimeBrowserCommands(f.host).browserTabClose({
        page: f.input.browserPageId,
        worktree: 'folder'
      })
    ).rejects.toThrow('browser_page_placement_stale')
    expect(f.pages.getPage(f.input.browserPageId)?.placement.pageHostGeneration).toBe(2)
    expect(f.retireRuntimeOwnedBrowserSessionTab).not.toHaveBeenCalled()
  })

  it('delegates live pages to the configured provider', async () => {
    const f = fixture()
    const close = vi.fn(async () => ({ closed: true }))
    f.getPlacement.mockReturnValue(f.input.placement)
    setRuntimeBrowserCommandsFactory(() =>
      Object.assign(Object.create(null), { browserTabClose: close })
    )
    const commands = createRuntimeBrowserCommands(f.host)
    expect(await Promise.resolve(commands)).toBe(commands)
    const params = { page: f.input.browserPageId, worktree: 'folder' }
    await expect(commands.browserTabClose(params)).resolves.toEqual({ closed: true })
    expect(close).toHaveBeenCalledExactlyOnceWith(params)
    expect(f.pages.getPage(f.input.browserPageId)).toBeDefined()
  })

  it('announces retirement when the legacy host has no persistence hook', async () => {
    const f = fixture()
    const notifyHeadlessBrowserSessionTabsChanged = vi.fn()
    const commands = createRuntimeBrowserCommands({
      ...f.host,
      retireRuntimeOwnedBrowserSessionTab: undefined,
      notifyHeadlessBrowserSessionTabsChanged
    })
    await commands.browserTabClose({ page: f.input.browserPageId })
    expect(notifyHeadlessBrowserSessionTabsChanged).toHaveBeenCalledExactlyOnceWith(
      f.input.workspaceId
    )
  })

  it.each(['absent', 'unavailable'] as const)(
    'retires a saved page with an %s provider',
    async (state) => {
      const f = fixture()
      setRuntimeBrowserCommandsFactory(null)
      if (state === 'unavailable') {
        setRuntimeBrowserCommandsFactory(
          () =>
            new Proxy(Object.create(null), {
              get: () => () => {
                throw new BrowserError('browser_unavailable', 'Provider unavailable')
              }
            })
        )
      }
      const commands = createRuntimeBrowserCommands(f.host)
      await expect(
        commands.browserTabClose({ page: f.input.browserPageId, worktree: 'path:/folder' })
      ).resolves.toEqual({ closed: true })
      expect(f.pages.getPage(f.input.browserPageId)).toBeUndefined()
      expect(f.retireRuntimeOwnedBrowserSessionTab).toHaveBeenCalledExactlyOnceWith(
        f.input.workspaceId,
        f.input.browserPageId
      )
    }
  )

  it('preserves pages in another workspace', async () => {
    const f = fixture()
    f.resolveBrowserWorkspace.mockResolvedValue({ id: 'other-workspace' })
    await expect(
      createRuntimeBrowserCommands(f.host).browserTabClose({
        page: f.input.browserPageId,
        worktree: 'other'
      })
    ).rejects.toMatchObject({ code: 'browser_tab_not_found' })
    expect(f.pages.getPage(f.input.browserPageId)).toBeDefined()
    expect(f.retireRuntimeOwnedBrowserSessionTab).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'does not retire an owned page (reconnected during resolution: %s)',
    async (reconnected) => {
      const f = fixture()
      if (reconnected) {
        f.resolveBrowserWorkspace.mockImplementation(async () => {
          f.getPlacement.mockReturnValue(f.input.placement)
          return { id: f.input.workspaceId }
        })
      } else {
        f.getPlacement.mockReturnValue(f.input.placement)
      }
      await expect(
        createRuntimeBrowserCommands(f.host).browserTabClose({
          page: f.input.browserPageId,
          worktree: 'folder'
        })
      ).rejects.toMatchObject({ code: 'browser_unavailable' })
      expect(f.pages.getPage(f.input.browserPageId)).toBeDefined()
      expect(f.retireRuntimeOwnedBrowserSessionTab).not.toHaveBeenCalled()
    }
  )

  it.each([{}, { index: 0 }, { page: 'unknown' }])(
    'does not claim a close for %j',
    async (params) => {
      const f = fixture()
      await expect(
        createRuntimeBrowserCommands(f.host).browserTabClose(params)
      ).rejects.toMatchObject({ code: 'browser_unavailable' })
      expect(f.pages.getPage(f.input.browserPageId)).toBeDefined()
      expect(f.retireRuntimeOwnedBrowserSessionTab).not.toHaveBeenCalled()
    }
  )

  it('leaves browser automation unavailable after closing a retained page', async () => {
    const f = fixture()
    const commands = createRuntimeBrowserCommands(f.host)
    await commands.browserTabClose({ page: f.input.browserPageId })
    expect(() => commands.browserGoto({ url: 'https://example.com' })).toThrow(BrowserError)
    await expect(commands.browserTabClose({ page: f.input.browserPageId })).rejects.toMatchObject({
      code: 'browser_unavailable'
    })
    expect(f.retireRuntimeOwnedBrowserSessionTab).toHaveBeenCalledTimes(1)
  })
})
