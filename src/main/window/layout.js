'use strict';
/**
 * Window layout geometry.
 *
 * Kept as pure functions over a plain state object: given the window size
 * and the current chrome configuration, produce the rectangle each page view
 * should occupy. Nothing here touches Electron, which means the tricky parts
 * — split ratios, panel widths, responsive-mode letterboxing — are unit
 * testable rather than "drag it and see".
 *
 *   +----------------------------------------------------------+
 *   | title bar (frameless: drag region lives in the chrome UI) |
 *   +--------+--------------------------------------+----------+
 *   |        |            toolbar                   |          |
 *   | tab    +----------------+---------------------+  side    |
 *   | side   |                |                     |  panel   |
 *   | bar    |   page A       |   page B (split)    |  (AI /   |
 *   |        |                |                     |   REST)  |
 *   +--------+----------------+---------------------+----------+
 */

/** Chrome dimensions, in CSS px. Density-scaled by the caller. */
const METRICS = {
  toolbarHeight: 44,
  horizontalTabStripHeight: 36,
  sidebarMin: 180,
  sidebarMax: 480,
  sidebarCollapsed: 52,
  panelMin: 280,
  panelMax: 720,
  splitDividerWidth: 6,
  splitMinPane: 220,
  /** Compact density trims vertical chrome. */
  compact: { toolbarHeight: 36, horizontalTabStripHeight: 30 },
};

/**
 * @typedef {object} LayoutState
 * @property {number} width          window content width
 * @property {number} height         window content height
 * @property {'vertical'|'horizontal'} tabOrientation
 * @property {number} sidebarWidth
 * @property {boolean} sidebarCollapsed
 * @property {'comfortable'|'compact'} density
 * @property {{kind:string, width:number}|null} panel
 * @property {{tabIds:[string,string], ratio:number}|null} split
 * @property {{width:number,height:number,scale:number}|null} responsive
 */

/** A fresh layout state with sane defaults. */
function createLayoutState(overrides = {}) {
  return {
    width: 1440,
    height: 900,
    tabOrientation: 'vertical',
    sidebarWidth: 248,
    sidebarCollapsed: false,
    density: 'comfortable',
    panel: null,
    split: null,
    responsive: null,
    ...overrides,
  };
}

function metricsFor(state) {
  const base = { ...METRICS };
  if (state.density === 'compact') Object.assign(base, METRICS.compact);
  return base;
}

/** Clamp a number into a range. */
function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/** Content narrower than this is not worth showing, so the panel floats. */
const MIN_CONTENT_WIDTH = 360;

/**
 * How the side panel is presented at the current window size, and how wide
 * it is. Both `contentRect` and `chromeMetrics` read this rather than each
 * re-deriving the rule — when the predicate lived in two places they
 * disagreed on narrow windows and the chrome drew a panel gap that the page
 * views did not leave.
 *
 * @returns {{open:boolean, width:number, overlays:boolean}}
 */
function panelMode(state) {
  if (!state.panel) return { open: false, width: 0, overlays: false };
  const m = metricsFor(state);
  const width = clamp(state.panel.width, m.panelMin, m.panelMax);
  const available = baseContentWidth(state);
  return { open: true, width, overlays: available - width < MIN_CONTENT_WIDTH };
}

/** Content width before any panel is considered. */
function baseContentWidth(state) {
  const m = metricsFor(state);
  if (state.tabOrientation !== 'vertical') return state.width;
  const sidebar = state.sidebarCollapsed
    ? m.sidebarCollapsed
    : clamp(state.sidebarWidth, m.sidebarMin, m.sidebarMax);
  return state.width - sidebar;
}

/**
 * The rectangle available to page content, i.e. the window minus the tab
 * sidebar/strip, the toolbar and any open side panel.
 * @param {LayoutState} state
 */
function contentRect(state) {
  const m = metricsFor(state);
  let x = 0;
  let y = 0;
  let width = state.width;
  let height = state.height;

  if (state.tabOrientation === 'vertical') {
    const sidebar = state.sidebarCollapsed
      ? m.sidebarCollapsed
      : clamp(state.sidebarWidth, m.sidebarMin, m.sidebarMax);
    x += sidebar;
    width -= sidebar;
    y += m.toolbarHeight;
    height -= m.toolbarHeight;
  } else {
    // Horizontal: tab strip above the toolbar, both full width.
    const chrome = m.horizontalTabStripHeight + m.toolbarHeight;
    y += chrome;
    height -= chrome;
  }

  // A panel never squeezes content below a usable width; past that point it
  // overlays instead, which is what Arc and Edge do on narrow windows.
  const panel = panelMode(state);
  if (panel.open && !panel.overlays) width -= panel.width;

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(Math.max(0, width)),
    height: Math.round(Math.max(0, height)),
  };
}

/**
 * Rectangles for the visible page view(s).
 *
 * @param {LayoutState} state
 * @param {string} activeTabId
 * @returns {Array<{tabId:string, bounds:{x:number,y:number,width:number,height:number}, role:string}>}
 */
function paneRects(state, activeTabId) {
  const m = metricsFor(state);
  const rect = contentRect(state);

  // --- split view -------------------------------------------------------
  if (state.split && state.split.tabIds?.length === 2) {
    const [left, right] = state.split.tabIds;
    const divider = m.splitDividerWidth;
    const usable = rect.width - divider;

    // Keep both panes usable regardless of what ratio the user dragged to.
    const minRatio = m.splitMinPane / usable;
    const ratio = clamp(state.split.ratio ?? 0.5, minRatio, 1 - minRatio);

    // If the window is too narrow to honour both minimums, fall back to a
    // single pane rather than rendering two unusable slivers.
    if (usable < m.splitMinPane * 2) {
      return [{ tabId: activeTabId, bounds: rect, role: 'single' }];
    }

    const leftWidth = Math.round(usable * ratio);
    return [
      {
        tabId: left,
        role: 'split-left',
        bounds: { x: rect.x, y: rect.y, width: leftWidth, height: rect.height },
      },
      {
        tabId: right,
        role: 'split-right',
        bounds: {
          x: rect.x + leftWidth + divider,
          y: rect.y,
          width: rect.width - leftWidth - divider,
          height: rect.height,
        },
      },
    ];
  }

  // --- responsive design mode ------------------------------------------
  if (state.responsive) {
    const { width: dw, height: dh } = state.responsive;
    const scale = state.responsive.scale || 1;
    const w = Math.min(Math.round(dw * scale), rect.width);
    const h = Math.min(Math.round(dh * scale), rect.height);
    return [{
      tabId: activeTabId,
      role: 'responsive',
      bounds: {
        // Centre the device viewport in the available space.
        x: rect.x + Math.round((rect.width - w) / 2),
        y: rect.y + Math.round((rect.height - h) / 2),
        width: w,
        height: h,
      },
    }];
  }

  return [{ tabId: activeTabId, bounds: rect, role: 'single' }];
}

/**
 * The divider's hit rectangle, so the chrome can render a drag handle in
 * exactly the gap the page views leave.
 */
function splitDividerRect(state) {
  if (!state.split) return null;
  const m = metricsFor(state);
  const panes = paneRects(state, null);
  if (panes.length !== 2) return null;
  const left = panes[0].bounds;
  return {
    x: left.x + left.width,
    y: left.y,
    width: m.splitDividerWidth,
    height: left.height,
  };
}

/**
 * Convert a divider drag (absolute window x) into a split ratio.
 * Returned value is already clamped to the usable range.
 */
function ratioFromDividerX(state, x) {
  const m = metricsFor(state);
  const rect = contentRect(state);
  const usable = rect.width - m.splitDividerWidth;
  if (usable <= 0) return 0.5;
  const minRatio = m.splitMinPane / usable;
  return clamp((x - rect.x) / usable, minRatio, 1 - minRatio);
}

/**
 * Everything the chrome renderer needs to draw itself in agreement with
 * where the main process actually put the page views.
 */
function chromeMetrics(state) {
  const m = metricsFor(state);
  const sidebar = state.tabOrientation === 'vertical'
    ? (state.sidebarCollapsed ? m.sidebarCollapsed : clamp(state.sidebarWidth, m.sidebarMin, m.sidebarMax))
    : 0;
  const panel = panelMode(state);
  const rect = contentRect(state);
  return {
    ...m,
    sidebarWidth: sidebar,
    panelWidth: panel.width,
    // True when the panel had to float over content rather than push it.
    panelOverlays: panel.overlays,
    contentRect: rect,
    divider: splitDividerRect(state),
    tabOrientation: state.tabOrientation,
    density: state.density,
    split: state.split,
    responsive: state.responsive,
  };
}

module.exports = {
  METRICS,
  MIN_CONTENT_WIDTH,
  createLayoutState,
  panelMode,
  contentRect,
  paneRects,
  splitDividerRect,
  ratioFromDividerX,
  chromeMetrics,
  clamp,
};
