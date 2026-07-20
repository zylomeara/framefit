// mcp-server/tests/unit/layout-spec-regression-fixture.test.ts
// Фикстура регресс-прецедента: 5 дельт, которые визуальная сверка пропустила.
// Числа сведены с задачей: title→radio 48 vs 20; radio→текст 0 vs 16; footer 12 vs 6;
// 18/700 vs 19/650; кастомный компонент вместо DS listItem/basic.
// ВАЖНО: размеры ПОСЛЕДНИХ DOM-детей подобраны так, чтобы их end-край совпадал с figma
// (172/216/38 ниже) — каждый дефект даёт ровно ОДНУ fail-строку (гэп), без каскада
// в padding-end. Меняя координаты — пересчитай end-края, иначе появятся лишние fail.
// (для listItem padding-right теперь подавляется как trailing-text — подбор 216 сохранён для гэп-инварианта)
import { describe, it, expect } from 'vitest';
import { buildLayoutSpec } from '../../src/domain/layout-spec/projector.js';
import { diffPair, summarize } from '../../src/domain/layout-spec/diff.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';
import type { DomSnapshotOk } from '../../src/domain/layout-spec/types.js';

const box = (x: number, y: number, w: number, h: number) => ({ x, y, width: w, height: h });

// ── Figma-сторона (эталон) ──
const drawerBody: RawSceneNode = {
  id: '30872:96206', name: 'DrawerBody', type: 'FRAME', absoluteBoundingBox: box(0, 0, 343, 400),
  layoutMode: 'VERTICAL', itemSpacing: 20,
  children: [
    { id: '30872:1', name: 'title', type: 'TEXT', absoluteBoundingBox: box(16, 0, 300, 24), characters: 'Почему уходите?',
      style: { fontFamily: 'ABC Favorit', fontWeight: 650, fontSize: 19, lineHeightPx: 24, lineHeightUnit: 'PIXELS', letterSpacing: 0 },
      fills: [{ type: 'SOLID', color: { r: 0.08, g: 0.08, b: 0.08 } }] },
    { id: '30872:2', name: 'reasons', type: 'FRAME', absoluteBoundingBox: box(16, 44, 311, 200) }, // gap title→list = 20
  ],
} as RawSceneNode;

const listItem: RawSceneNode = {
  id: '30872:10', name: 'reason-item', type: 'INSTANCE', absoluteBoundingBox: box(16, 44, 311, 56),
  layoutMode: 'HORIZONTAL', itemSpacing: 16, componentId: '5:1',
  componentProperties: { 'Size#1:0': { type: 'VARIANT', value: 'medium' } },
  children: [
    { id: '30872:11', name: 'radio', type: 'INSTANCE', absoluteBoundingBox: box(32, 62, 20, 20) },
    { id: '30872:12', name: 'text', type: 'TEXT', absoluteBoundingBox: box(68, 60, 200, 24), characters: 'Дорого', // 68-52=16 gap
      style: { fontFamily: 'ABC Favorit', fontWeight: 400, fontSize: 16, lineHeightPx: 22, lineHeightUnit: 'PIXELS', letterSpacing: 0 } },
  ],
} as RawSceneNode;

const footer: RawSceneNode = {
  id: '30872:20', name: 'footer', type: 'FRAME', absoluteBoundingBox: box(0, 500, 343, 120),
  layoutMode: 'VERTICAL', itemSpacing: 6,
  children: [
    { id: '30872:21', name: 'stay', type: 'FRAME', absoluteBoundingBox: box(16, 516, 311, 44) },
    { id: '30872:22', name: 'leave', type: 'FRAME', absoluteBoundingBox: box(16, 566, 311, 44) }, // gap 6
  ],
} as RawSceneNode;

// ── DOM-сторона (реализация с 5 дефектами) ──
const domDrawerBody: DomSnapshotOk = {
  schema: 1, status: 'ok', selector: '.drawer-body', innerWidth: 375,
  rect: { x: 0, y: 0, w: 343, h: 400 }, borders: { top: 0, right: 0, bottom: 0, left: 0 },
  paddings: { top: 0, right: 0, bottom: 0, left: 0 }, clientWidth: 343, clientHeight: 400, scrollHeight: 400,
  scroll: { top: 0, left: 0 }, transformed: false, fontsLoaded: true,
  children: [
    { kind: 'element', tag: 'h2', classList: ['title'], rect: { x: 16, y: 0, w: 300, h: 24 },
      styles: { fontFamily: 'ABC Favorit', fontWeight: 700, fontSize: 18, lineHeight: 24, letterSpacing: 0, color: '#141414' } }, // Δ4: 18/700
    { kind: 'element', tag: 'div', classList: ['reasons'], rect: { x: 16, y: 72, w: 311, h: 172 } }, // Δ1: gap 48; h=172 → end 244 = figma (44+200)
  ],
};

const domListItem: DomSnapshotOk = {
  schema: 1, status: 'ok', selector: '.reason-item', innerWidth: 375,
  rect: { x: 16, y: 44, w: 311, h: 56 }, borders: { top: 0, right: 0, bottom: 0, left: 0 },
  paddings: { top: 0, right: 0, bottom: 0, left: 0 }, clientWidth: 311, clientHeight: 56, scrollHeight: 56,
  scroll: { top: 0, left: 0 }, transformed: false, fontsLoaded: true,
  componentHints: { tag: 'label', classList: ['custom-radio'], data: {} }, // Δ5: кастом вместо DS
  children: [
    { kind: 'element', tag: 'input', rect: { x: 32, y: 62, w: 20, h: 20 } },
    { kind: 'text', rect: { x: 52, y: 60, w: 216, h: 24 }, text: 'Дорого', // Δ2: gap 0 (52-52), голый text node; w=216 → end 268 = figma (68+200)
      styles: { fontFamily: 'ABC Favorit', fontWeight: 400, fontSize: 16, lineHeight: 22, letterSpacing: 0 } },
  ],
};

const domFooter: DomSnapshotOk = {
  schema: 1, status: 'ok', selector: '.footer', innerWidth: 375,
  rect: { x: 0, y: 500, w: 343, h: 120 }, borders: { top: 0, right: 0, bottom: 0, left: 0 },
  paddings: { top: 0, right: 0, bottom: 0, left: 0 }, clientWidth: 343, clientHeight: 120, scrollHeight: 120,
  scroll: { top: 0, left: 0 }, transformed: false, fontsLoaded: true,
  children: [
    { kind: 'element', tag: 'button', rect: { x: 16, y: 516, w: 311, h: 44 } },
    { kind: 'element', tag: 'button', rect: { x: 16, y: 572, w: 311, h: 38 } }, // Δ3: gap 12; h=38 → end 610 = figma (566+44)
  ],
};

describe('regression fixture — all 5 deltas caught, no false fails', () => {
  const ctx = { components: { '5:1': { key: 'k', name: 'basic', componentSetId: '4:1' } }, setNames: new Map([['4:1', 'listItem']]) };

  it('Δ1: drawer-body gap 48 vs 20 → fail Δ28', () => {
    const rows = diffPair(buildLayoutSpec(drawerBody), domDrawerBody, { tolerancePx: 1, frameWidth: 375 });
    expect(rows.find((r) => r.prop.startsWith('gap[0]'))).toMatchObject({ figma: 20, dom: 48, delta: 28, status: 'fail' });
  });

  it('Δ4: title typography 18/700 vs 19/650 → two fails (same pair as Δ1)', () => {
    const rows = diffPair(buildLayoutSpec(drawerBody), domDrawerBody, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'font-size[title]')).toMatchObject({ figma: 19, dom: 18, status: 'fail' });
    expect(rows.find((r) => r.prop === 'font-weight[title]')).toMatchObject({ figma: 650, dom: 700, status: 'fail' });
  });

  it('Δ2: radio↔text gap 0 vs 16 (bare text node) → fail Δ16', () => {
    const rows = diffPair(buildLayoutSpec(listItem, ctx), domListItem, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop.startsWith('gap[0]'))).toMatchObject({ figma: 16, dom: 0, delta: 16, status: 'fail' });
  });

  it('Δ5: component listItem/basic vs label.custom-radio → warn', () => {
    const rows = diffPair(buildLayoutSpec(listItem, ctx), domListItem, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop === 'component')).toMatchObject({ figma: 'listItem/basic', status: 'warn' });
  });

  it('Δ3: footer gap 12 vs 6 → fail Δ6', () => {
    const rows = diffPair(buildLayoutSpec(footer), domFooter, { tolerancePx: 1 });
    expect(rows.find((r) => r.prop.startsWith('gap[0]'))).toMatchObject({ figma: 6, dom: 12, delta: 6, status: 'fail' });
  });

  it('no false fails: every fail row is one of the 5 known deltas', () => {
    const all = [
      ...diffPair(buildLayoutSpec(drawerBody), domDrawerBody, { tolerancePx: 1, frameWidth: 375 }),
      ...diffPair(buildLayoutSpec(listItem, ctx), domListItem, { tolerancePx: 1, frameWidth: 375 }),
      ...diffPair(buildLayoutSpec(footer), domFooter, { tolerancePx: 1, frameWidth: 375 }),
    ];
    const fails = all.filter((r) => r.status === 'fail').map((r) => r.prop);
    expect(fails.sort()).toEqual(['font-size[title]', 'font-weight[title]', 'gap[0] radio↔text', 'gap[0] stay↔leave', 'gap[0] title↔reasons'].sort());
    const s = summarize(all);
    expect(s.fail).toBe(5);
    expect(s.warn).toBeGreaterThanOrEqual(1); // component Δ5
    expect(all.find((r) => r.prop === 'extractor_outdated')).toBeUndefined();
    expect(all.find((r) => r.prop === 'unwrapped')).toBeUndefined();
  });
});
