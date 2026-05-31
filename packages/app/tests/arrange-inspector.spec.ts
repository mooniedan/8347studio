import { test, expect, type Page, type Locator } from '@playwright/test';

// Phase-12 M5b — selected-block inspector: loop toggle, Make Unique,
// delete. Make Unique forks a linked block onto its own pattern copy.

async function bridgeReady(page: Page) {
  await page.waitForFunction(() => (window as unknown as { __bridge?: object }).__bridge != null);
}

async function arrangeWithSubtractive(page: Page): Promise<number> {
  await page.goto('/');
  await bridgeReady(page);
  const idx = await page.evaluate(() =>
    (window as unknown as { __bridge: { addSubtractiveTrack: () => number } }).__bridge.addSubtractiveTrack(),
  );
  await page.getByTestId('view-toggle-arrange').click();
  await expect(page.getByTestId('arrangement-view')).toBeVisible();
  return idx;
}

function blocksOn(page: Page, trackIdx: number): Locator {
  return page.locator(`[data-testid^="arrange-block-${trackIdx}-"]:not([data-testid$="-resize"])`);
}

function patternIds(page: Page, trackIdx: number): Promise<string[]> {
  return page.evaluate(
    (i) => (window as unknown as { __bridge: { listBlocks: (n: number) => { patternId: string }[] } })
      .__bridge.listBlocks(i).map((b) => b.patternId),
    trackIdx,
  );
}

test.describe('phase-12 M5b — block inspector', () => {
  test('selecting a block reveals the inspector with its length', async ({ page }) => {
    const idx = await arrangeWithSubtractive(page);
    await expect(page.getByTestId('block-inspector')).toHaveCount(0);

    await blocksOn(page, idx).first().click();
    await expect(page.getByTestId('block-inspector')).toBeVisible();
    await expect(page.getByTestId('bi-length')).toHaveText(/bars/);
  });

  test('loop toggle flips the block’s loop flag', async ({ page }) => {
    const idx = await arrangeWithSubtractive(page);
    const block = blocksOn(page, idx).first();
    await expect(block).toHaveAttribute('data-loop', 'true');

    await block.click();
    await page.getByTestId('bi-loop').click();
    await expect(blocksOn(page, idx).first()).toHaveAttribute('data-loop', 'false');
  });

  test('Make Unique forks the selected block onto its own pattern', async ({ page }) => {
    const idx = await arrangeWithSubtractive(page);

    // Two linked blocks of the same pattern.
    await page.evaluate((i) => {
      const b = (window as unknown as { __bridge: { listBlocks: (n: number) => { id: string }[]; duplicateBlock: (id: string) => string } }).__bridge;
      b.duplicateBlock(b.listBlocks(i)[0].id);
    }, idx);
    await expect(blocksOn(page, idx)).toHaveCount(2);
    expect(new Set(await patternIds(page, idx)).size).toBe(1); // linked

    // Select the duplicate (lands one bar in) and fork it.
    await page.locator(`[data-testid^="arrange-block-${idx}-"][data-start-tick="3840"]:not([data-testid$="-resize"])`).click();
    await page.getByTestId('bi-make-unique').click();

    await expect.poll(async () => new Set(await patternIds(page, idx)).size).toBe(2); // forked
  });

  test('inspector Delete removes the block', async ({ page }) => {
    const idx = await arrangeWithSubtractive(page);
    await blocksOn(page, idx).first().click();
    await page.getByTestId('bi-delete').click();
    await expect(blocksOn(page, idx)).toHaveCount(0);
    await expect(page.getByTestId('block-inspector')).toHaveCount(0);
  });
});
