'use strict';
/**
 * Layout geometry tests.
 *
 * The failure modes these guard against are all ones a user would notice
 * instantly: page content hidden under the toolbar, a split pane collapsed
 * to nothing, or a side panel shoving content off-screen.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const {
  METRICS, createLayoutState, contentRect, paneRects,
  splitDividerRect, ratioFromDividerX, chromeMetrics,
} = require('../src/main/window/layout');

test('vertical layout reserves the sidebar and toolbar', () => {
  const s = createLayoutState({ width: 1440, height: 900, sidebarWidth: 248 });
  const r = contentRect(s);
  assert.equal(r.x, 248);
  assert.equal(r.y, METRICS.toolbarHeight);
  assert.equal(r.width, 1440 - 248);
  assert.equal(r.height, 900 - METRICS.toolbarHeight);
});

test('horizontal layout reserves the tab strip plus toolbar and no sidebar', () => {
  const s = createLayoutState({ tabOrientation: 'horizontal', width: 1200, height: 800 });
  const r = contentRect(s);
  assert.equal(r.x, 0);
  assert.equal(r.y, METRICS.horizontalTabStripHeight + METRICS.toolbarHeight);
  assert.equal(r.width, 1200);
});

test('collapsed sidebar shrinks to the rail width', () => {
  const s = createLayoutState({ sidebarCollapsed: true, width: 1000 });
  assert.equal(contentRect(s).x, METRICS.sidebarCollapsed);
});

test('compact density trims chrome height', () => {
  const roomy = contentRect(createLayoutState({ height: 900 }));
  const tight = contentRect(createLayoutState({ height: 900, density: 'compact' }));
  assert.ok(tight.height > roomy.height, 'compact leaves more room for the page');
  assert.equal(tight.y, METRICS.compact.toolbarHeight);
});

test('a side panel takes width from content', () => {
  const s = createLayoutState({ width: 1440, panel: { kind: 'ai', width: 360 } });
  assert.equal(contentRect(s).width, 1440 - 248 - 360);
});

test('a side panel overlays instead of crushing a narrow window', () => {
  const s = createLayoutState({ width: 700, panel: { kind: 'ai', width: 600 } });
  const r = contentRect(s);
  assert.equal(r.width, 700 - 248, 'content keeps its width; the panel floats over it');
  assert.equal(chromeMetrics(s).panelOverlays, true);
});

test('split view produces two panes separated by exactly one divider', () => {
  const s = createLayoutState({
    width: 1440, height: 900,
    split: { tabIds: ['a', 'b'], ratio: 0.5 },
  });
  const panes = paneRects(s, 'a');
  assert.equal(panes.length, 2);
  const [l, r] = panes;
  assert.equal(l.bounds.x + l.bounds.width + METRICS.splitDividerWidth, r.bounds.x);
  assert.equal(r.bounds.x + r.bounds.width, contentRect(s).x + contentRect(s).width);
  assert.equal(l.bounds.height, r.bounds.height);
});

test('split ratio is clamped so neither pane becomes unusable', () => {
  const s = createLayoutState({
    width: 1440, split: { tabIds: ['a', 'b'], ratio: 0.001 },
  });
  const [l, r] = paneRects(s, 'a');
  assert.ok(l.bounds.width >= METRICS.splitMinPane - 1, `left pane ${l.bounds.width} too narrow`);
  assert.ok(r.bounds.width >= METRICS.splitMinPane - 1, `right pane ${r.bounds.width} too narrow`);
});

test('split falls back to a single pane when the window cannot fit two', () => {
  const s = createLayoutState({
    width: 560, split: { tabIds: ['a', 'b'], ratio: 0.5 },
  });
  const panes = paneRects(s, 'a');
  assert.equal(panes.length, 1);
  assert.equal(panes[0].role, 'single');
  assert.equal(panes[0].tabId, 'a', 'the active tab is the one that stays visible');
});

test('divider rect sits exactly in the gap between the panes', () => {
  const s = createLayoutState({ split: { tabIds: ['a', 'b'], ratio: 0.4 } });
  const [l, r] = paneRects(s, 'a');
  const d = splitDividerRect(s);
  assert.equal(d.x, l.bounds.x + l.bounds.width);
  assert.equal(d.x + d.width, r.bounds.x);
});

test('dragging the divider round-trips to a ratio', () => {
  const s = createLayoutState({ width: 1440, split: { tabIds: ['a', 'b'], ratio: 0.5 } });
  const target = contentRect(s).x + 400;
  const ratio = ratioFromDividerX(s, target);
  const moved = { ...s, split: { ...s.split, ratio } };
  const [l] = paneRects(moved, 'a');
  assert.ok(Math.abs(l.bounds.width - 400) <= 1, `expected ~400, got ${l.bounds.width}`);
});

test('responsive mode centres a device viewport inside the content area', () => {
  const s = createLayoutState({
    width: 1440, height: 900, responsive: { width: 390, height: 844, scale: 1 },
  });
  const [pane] = paneRects(s, 'a');
  const rect = contentRect(s);
  assert.equal(pane.bounds.width, 390);
  assert.equal(pane.bounds.height, 844);
  const leftGap = pane.bounds.x - rect.x;
  const rightGap = (rect.x + rect.width) - (pane.bounds.x + pane.bounds.width);
  assert.ok(Math.abs(leftGap - rightGap) <= 1, 'horizontally centred');
});

test('a device larger than the window is clipped to the content area', () => {
  const s = createLayoutState({
    width: 700, height: 500, responsive: { width: 1920, height: 1080, scale: 1 },
  });
  const [pane] = paneRects(s, 'a');
  const rect = contentRect(s);
  assert.ok(pane.bounds.width <= rect.width);
  assert.ok(pane.bounds.height <= rect.height);
});

test('layout never returns negative dimensions for a tiny window', () => {
  const s = createLayoutState({ width: 120, height: 20 });
  const r = contentRect(s);
  assert.ok(r.width >= 0 && r.height >= 0, `got ${r.width}x${r.height}`);
});
