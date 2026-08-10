// mcp-server/src/adapters/driving/tools/dom-extractor.ts
// The canonical DOM extractor. Handed to the client via get_layout_spec {include_extractor:true},
// pasted into chrome-devtools evaluate_script VERBATIM. The visibility-predicate semantics are a
// mirror of the projector's inFlowChildren() — change only in sync (see dom-extractor.test.ts).
// Capture depth (flowChildren depthLeft, :86) has THREE mirrors: this (DOM), projector.ts
// projectChildren (the Figma projection) and projector.ts FETCH_DEPTH (the REST fetch — without it the Figma side
// doesn't get raw nodes any deeper — see projector.ts:12). Move all three in sync.
// The build has no browser types — which is why this is a string, not a function.
export const EXTRACTOR_JS = `async (selectors, uploadUrl, depthLeft = 3, budget = 90) => {
  const SCHEMA = 6;
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : undefined; };
  const round1 = (n) => Math.round(n * 10) / 10;
  const rectOf = (r) => ({ x: round1(r.x), y: round1(r.y), w: round1(r.width), h: round1(r.height) });
  const padsOf = (cs) => ({ top: num(cs.paddingTop) || 0, right: num(cs.paddingRight) || 0,
    bottom: num(cs.paddingBottom) || 0, left: num(cs.paddingLeft) || 0 });
  // The geometry gate rests on this flag - diff.ts refuses EVERY geometric row when it is set - so it
  // has to mean "the box is not where its layout puts it", not "the transform property is set".
  // A computed transform is always a matrix, and an IDENTITY one moves nothing: promoting a fixed
  // header with translateZ(0) is the common idiom, and under the old string test it made that header
  // permanently unmeasurable while the verdict said "wait for the animation to finish" - an
  // instruction nobody can carry out, since nothing is animating. Anything unparseable stays true:
  // over-gating loses a measurement, under-gating reports a moved box as a design defect.
  const IDENT = { 6: [1, 0, 0, 1, 0, 0], 16: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };
  const movedBy = (t) => {
    if (!t || t === 'none') return false;
    const n = t.slice(t.indexOf('(') + 1, -1).split(',').map(Number);
    const I = IDENT[n.length];
    return !I || n.some((v, i) => v !== I[i]);
  };
  // THE RULE: the DOM side either yields ONE comparable px number, or it says so.
  // Figma carries a single px cornerRadius, so that is the only shape there is anything to compare
  // against. Everything else -- four differing corners, a percentage, an ellipse -- has no axis on
  // the other side, and a number emitted for it is a verdict about something nobody measured.
  // Three shapes reached PASS before this test existed, each a false green:
  //   border-radius: 8px 0 0 0            -> reading the top-left corner alone gave a uniform 8
  //   border-radius: 8px / 4px 40px ...   -> four "h v" PAIRS, and parseFloat('8px 4px') is 8, so
  //                                          comparing parsed numbers made four different corners equal
  //   border-radius: 50%                  -> 50 compared as px; on a 300x20 box the real corners are
  //                                          150px and 10px, and it passed a Figma cornerRadius of 50
  //   border-radius: 8px / 4px            -> one uniform ELLIPSE, 8 horizontal by 4 vertical, passing
  //                                          a Figma 8 that describes a circle
  //   border-radius: clamp(4px, 10%, 12px) -> left VERBATIM by the browser, so it parsed to nothing and
  //                                          emitted nothing at all: no row, empty blocking,
  //                                          verification.complete TRUE over a corner that is painted
  // Hence: compare the four as STRINGS (that is what actually differs), and accept the value only
  // when it is a bare px length. num() is never asked to interpret anything else.
  // WHATEVER THE BROWSER COMPUTED IS A RADIUS, even when we cannot read it. min()/max()/clamp() and
  // calc() carrying a percentage all survive computation verbatim (measured in Chrome), and they
  // PAINT: hit-tested, the corner pixel of a clamp(4px, 10%, 12px) box is clipped exactly as for 8px,
  // while a no-radius control keeps it. Emitting nothing for those is the silent-omission lie this
  // change already rejected twice, so an unreadable computed value is uncomparable, not absent.
  // The ONLY silence left is an empty computed value -- nothing was computed, so there is nothing to
  // report; that is the pre-v6 behaviour and it keeps NaN off the wire.
  // PX_ONLY accepts the exponent form: measured in Chrome, 999999px stays 999999px but 1000000px
  // computes to '1e+06px' (and large values saturate at '1.67772e+07px'). The NEGATIVE exponent is
  // just as real and just as reachable: measured, '0.0001px' stays verbatim and '0.00009px' computes
  // to '9e-05px' -- it is six-significant-digit serialization, not a size threshold, so [+-] here is
  // load-bearing and not defensive. Those are ordinary
  // comparable radii -- parseFloat reads them correctly -- and rejecting them would flag a genuine px
  // radius with a note whose named shapes are all false about it.
  // The mantissa is a NUMBER, not a run of digits-and-dots: [0-9.]+ also accepted '.px' and '..px',
  // which pass the test and then parseFloat to NaN -> num() undefined -> no row at all from a truthy
  // computed string. That is the silent omission this rule exists to reject, only reached from a
  // hand-built string rather than from a browser.
  const PX_ONLY = /^-?[0-9]*\\.?[0-9]+(e[+-]?[0-9]+)?px$/;
  const radiusOf = (cs) => {
    const c = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius];
    if (!c.every((v) => v === c[0])) return { uncomparable: true };
    if (PX_ONLY.test(c[0])) return { value: num(c[0]) };
    return c[0] ? { uncomparable: true } : {};
  };
  const toHex = (c) => {
    const m = /^rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)$/.exec(c || '');
    if (!m) return undefined;
    const a = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (a === 0) return undefined;
    const h = (x) => (+x).toString(16).padStart(2, '0');
    const base = '#' + h(m[1]) + h(m[2]) + h(m[3]);
    return a >= 1 ? base : base + Math.round(a * 255).toString(16).padStart(2, '0');
  };
    const toHexLoose = (c) => toHex((c || '').replace(/\\s+/g, ' ').trim());
    // CSS named colors (Color-4 set, minus 'transparent') → #rrggbb, plus a pure-JS hsl()/hsla() → #hex
    // converter. Both run WITHOUT a browser normalizer: canvas / getComputedStyle-on-a-probe are absent
    // from the fake-DOM test harness, so a canvas path would execute in prod yet never under test (an
    // unlocked path — exactly the coverage trap to avoid). Pure JS runs identically in prod and test.
    const NAMED = { aliceblue:'#f0f8ff', antiquewhite:'#faebd7', aqua:'#00ffff', aquamarine:'#7fffd4', azure:'#f0ffff', beige:'#f5f5dc', bisque:'#ffe4c4', black:'#000000', blanchedalmond:'#ffebcd', blue:'#0000ff', blueviolet:'#8a2be2', brown:'#a52a2a', burlywood:'#deb887', cadetblue:'#5f9ea0', chartreuse:'#7fff00', chocolate:'#d2691e', coral:'#ff7f50', cornflowerblue:'#6495ed', cornsilk:'#fff8dc', crimson:'#dc143c', cyan:'#00ffff', darkblue:'#00008b', darkcyan:'#008b8b', darkgoldenrod:'#b8860b', darkgray:'#a9a9a9', darkgreen:'#006400', darkgrey:'#a9a9a9', darkkhaki:'#bdb76b', darkmagenta:'#8b008b', darkolivegreen:'#556b2f', darkorange:'#ff8c00', darkorchid:'#9932cc', darkred:'#8b0000', darksalmon:'#e9967a', darkseagreen:'#8fbc8f', darkslateblue:'#483d8b', darkslategray:'#2f4f4f', darkslategrey:'#2f4f4f', darkturquoise:'#00ced1', darkviolet:'#9400d3', deeppink:'#ff1493', deepskyblue:'#00bfff', dimgray:'#696969', dimgrey:'#696969', dodgerblue:'#1e90ff', firebrick:'#b22222', floralwhite:'#fffaf0', forestgreen:'#228b22', fuchsia:'#ff00ff', gainsboro:'#dcdcdc', ghostwhite:'#f8f8ff', gold:'#ffd700', goldenrod:'#daa520', gray:'#808080', green:'#008000', greenyellow:'#adff2f', grey:'#808080', honeydew:'#f0fff0', hotpink:'#ff69b4', indianred:'#cd5c5c', indigo:'#4b0082', ivory:'#fffff0', khaki:'#f0e68c', lavender:'#e6e6fa', lavenderblush:'#fff0f5', lawngreen:'#7cfc00', lemonchiffon:'#fffacd', lightblue:'#add8e6', lightcoral:'#f08080', lightcyan:'#e0ffff', lightgoldenrodyellow:'#fafad2', lightgray:'#d3d3d3', lightgreen:'#90ee90', lightgrey:'#d3d3d3', lightpink:'#ffb6c1', lightsalmon:'#ffa07a', lightseagreen:'#20b2aa', lightskyblue:'#87cefa', lightslategray:'#778899', lightslategrey:'#778899', lightsteelblue:'#b0c4de', lightyellow:'#ffffe0', lime:'#00ff00', limegreen:'#32cd32', linen:'#faf0e6', magenta:'#ff00ff', maroon:'#800000', mediumaquamarine:'#66cdaa', mediumblue:'#0000cd', mediumorchid:'#ba55d3', mediumpurple:'#9370db', mediumseagreen:'#3cb371', mediumslateblue:'#7b68ee', mediumspringgreen:'#00fa9a', mediumturquoise:'#48d1cc', mediumvioletred:'#c71585', midnightblue:'#191970', mintcream:'#f5fffa', mistyrose:'#ffe4e1', moccasin:'#ffe4b5', navajowhite:'#ffdead', navy:'#000080', oldlace:'#fdf5e6', olive:'#808000', olivedrab:'#6b8e23', orange:'#ffa500', orangered:'#ff4500', orchid:'#da70d6', palegoldenrod:'#eee8aa', palegreen:'#98fb98', paleturquoise:'#afeeee', palevioletred:'#db7093', papayawhip:'#ffefd5', peachpuff:'#ffdab9', peru:'#cd853f', pink:'#ffc0cb', plum:'#dda0dd', powderblue:'#b0e0e6', purple:'#800080', rebeccapurple:'#663399', red:'#ff0000', rosybrown:'#bc8f8f', royalblue:'#4169e1', saddlebrown:'#8b4513', salmon:'#fa8072', sandybrown:'#f4a460', seagreen:'#2e8b57', seashell:'#fff5ee', sienna:'#a0522d', silver:'#c0c0c0', skyblue:'#87ceeb', slateblue:'#6a5acd', slategray:'#708090', slategrey:'#708090', snow:'#fffafa', springgreen:'#00ff7f', steelblue:'#4682b4', tan:'#d2b48c', teal:'#008080', thistle:'#d8bfd8', tomato:'#ff6347', turquoise:'#40e0d0', violet:'#ee82ee', wheat:'#f5deb3', white:'#ffffff', whitesmoke:'#f5f5f5', yellow:'#ffff00', yellowgreen:'#9acd32' };
    const namedHex = (w) => { const k = (w || '').toLowerCase(); return Object.prototype.hasOwnProperty.call(NAMED, k) ? NAMED[k] : undefined; };
    const hslHex = (str) => {
      const m = /hsla?\\(\\s*([\\d.]+)(?:deg)?\\s*[, ]\\s*([\\d.]+)%\\s*[, ]\\s*([\\d.]+)%\\s*(?:[,/]\\s*([\\d.]+)(%?)\\s*)?\\)/i.exec(str || '');
      if (!m) return undefined;
      const h = (((parseFloat(m[1]) % 360) + 360) % 360);
      const S = Math.min(1, Math.max(0, parseFloat(m[2]) / 100)), L = Math.min(1, Math.max(0, parseFloat(m[3]) / 100));
      let a = 1; if (m[4] !== undefined) { a = parseFloat(m[4]); if (m[5] === '%') a /= 100; }
      if (!(a > 0)) return undefined;
      const c = (1 - Math.abs(2 * L - 1)) * S, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), mm = L - c / 2;
      let r = 0, g = 0, b = 0;
      if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; }
      else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
      const q = (v) => Math.round((v + mm) * 255).toString(16).padStart(2, '0');
      const base = '#' + q(r) + q(g) + q(b);
      return a >= 1 ? base : base + Math.round(a * 255).toString(16).padStart(2, '0');
    };
    // literal color authored directly in a candidate value: a longhand pure color OR the color substring/
    // word of a shorthand (background / border). Returns a normalized #rrggbb(aa) or undefined. Detection
    // is CLOSED for rgb()/#hex/hsl()/named-color literal forms (longhand AND single-word inside a shorthand);
    // oklch()/lab()/color-mix() are the ONLY forms still out of detection (device-independent color-space
    // math needs a browser normalizer unavailable to the harness — whole-branch follow-up). So the
    // "unextractable shorthand → conservative NOT-a-literal" arm stays never-false-green for those; and a
    // named/hsl/rgb/hex literal co-occurring with a var anchoring the SAME computed pixel now sets
    // explainingLiteral → {ambiguous-cascade}, closing the bulk of the litHex residual false-green.
    const litHex = (val) => {
      const s = (val || '').replace(/\\s+/g, ' ').trim();
      const whole = toHexLoose(s); if (whole) return whole.toLowerCase();
      const rgbM = s.match(/rgba?\\([^)]*\\)/);
      if (rgbM) { const h = toHex(rgbM[0].replace(/\\s+/g, '')); if (h) return h.toLowerCase(); }
      const hexM = s.match(/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/);
      if (hexM) { let x = hexM[0].slice(1); if (x.length === 3 || x.length === 4) x = x.split('').map((c) => c + c).join(''); return ('#' + x).toLowerCase(); }
      const hslM = s.match(/hsla?\\([^)]*\\)/i);
      if (hslM) { const h = hslHex(hslM[0]); if (h) return h.toLowerCase(); }
      const nWhole = namedHex(s); if (nWhole) return nWhole;                                // lone named longhand
      for (const tok of s.split(/[\\s,]+/)) { const nt = namedHex(tok); if (nt) return nt; }  // named word in a shorthand
      return undefined;
    };
  const parseShadow = (v) => {
    if (!v || v === 'none') return undefined;
    // split on top-level commas (commas inside rgb()/rgba() are ignored via paren-depth)
    const parts = []; let depth = 0, cur = '';
    for (const ch of v) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
    }
    if (cur.trim()) parts.push(cur);
    const first = parts[0].trim();
    const inset = /(^|\\s)inset(\\s|$)/.test(first);
    const colorMatch = first.match(/rgba?\\([^)]*\\)/);
    const colorHex = colorMatch ? toHex(colorMatch[0].replace(/\\s+/g, '')) : undefined;
    const lengths = (colorMatch ? first.replace(colorMatch[0], '') : first)
      .match(/-?[\\d.]+px/g) || [];
    const n = lengths.map(parseFloat);
    return { inset, x: n[0] || 0, y: n[1] || 0, blur: n[2] || 0, spread: n[3] || 0, colorHex, count: parts.length };
  };
  const typo = (cs) => ({
    fontFamily: cs.fontFamily || undefined,
    fontWeight: num(cs.fontWeight),
    fontSize: num(cs.fontSize),
    lineHeight: cs.lineHeight === 'normal' ? 'normal' : num(cs.lineHeight),
    letterSpacing: cs.letterSpacing === 'normal' ? 'normal' : num(cs.letterSpacing),
    color: toHex(cs.color),
  });
  // basePath ('' at the captured root) is the :nth-child chain to reach el itself — every emitted
  // child's .path is basePath extended by its own segment, giving a CSS selector usable as a
  // compare address later (suggest_pairs). Indexing uses el.children (elements-only), NOT
  // el.childNodes (which also carries text nodes) — otherwise indices would drift from the real
  // CSS :nth-child count.
  // Honest truncation: at depthLeft===0 flowChildren stops descending — this peeks ONE
  // level further to tell "true leaf" apart from "content exists below the depth cut, we're just not
  // capturing it". Predicate MUST mirror flowChildren's own visibility gate BY ORDER (contents BEFORE
  // position — flip flags display:contents+position:absolute wrapper nodes false; text checked with
  // its own non-empty+non-zero-rect rule) or this either over-flags (position:absolute-only
  // descendants, e.g. close controls) or under-flags (misses real content behind display:contents).
  const hasFlowContent = (el) => {
    for (const n of el.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) {
        if (!n.textContent || !n.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        const r = range.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return true;
        continue;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      const cs = getComputedStyle(n);
      if (cs.display === 'none') continue;
      if (cs.display === 'contents') { if (hasFlowContent(n)) return true; continue; }
      if (cs.position === 'absolute' || cs.position === 'fixed') continue;
      const r = n.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return true;
    }
    return false;
  };
  const flowChildren = (el, depthLeft, basePath) => {
    const out = [];
    // Out-of-flow children are correctly excluded from this box's layout, but dropping them without
    // a trace makes the box read as a true leaf. On a real page a fixed site header - the whole
    // navigation - vanished this way, and the diff then blamed the depth cut and told the reader to
    // raise max_depth, which can never reveal them. Count them so the diff can name the action that
    // does work: pair such an element directly.
    out.outOfFlow = 0;
    for (const n of el.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) {
        if (!n.textContent || !n.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        const r = range.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        // Text is diffed on its parent element, so it carries the parent's own path (basePath),
        // not a fresh segment of its own.
        // = SNIPPET_CAP (types.ts) — the browser script doesn't import it; the sync is guaranteed by the schema gate.
        out.push({ kind: 'text', rect: rectOf(r), text: n.textContent.trim().slice(0, 120),
          styles: Object.assign(typo(getComputedStyle(n.parentElement)),
            { colorToken: classifyColor(n.parentElement, 'color', toHex(getComputedStyle(n.parentElement).color)) }),
          path: basePath });
        continue;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      const cs = getComputedStyle(n);
      if (cs.display === 'none') continue;
      if (cs.display === 'contents') {
        // display:contents still counts toward CSS :nth-child (the browser doesn't remove it from
        // the tree, only from box generation) — so the promoted grandchildren's selector MUST pass
        // through this element's own segment, or the resulting path would fail to address them.
        // depthLeft is NOT decremented: contents is layout-transparent (doesn't consume the layout
        // depth budget) but not selector-transparent.
        const nodePath = (basePath + ' > :nth-child(' + (Array.from(el.children).indexOf(n) + 1) + ')').trim();
        const sub = flowChildren(n, depthLeft, nodePath);
        out.outOfFlow += sub.outOfFlow; // display:contents is layout-transparent - its skips are this box's
        out.push(...sub);
        continue;
      }
      if (cs.position === 'absolute' || cs.position === 'fixed') { out.outOfFlow++; continue; }
      const r = n.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const childSel = '> :nth-child(' + (Array.from(el.children).indexOf(n) + 1) + ')';
      const nodePath = (basePath + ' ' + childSel).trim();
      const child = { kind: 'element', tag: n.tagName.toLowerCase(),
        classList: Array.from(n.classList).slice(0, 10), rect: rectOf(r), styles: typo(cs),
        paddings: padsOf(cs), path: nodePath };
      // v5: the style bundle — COMPACT (a field is present only when the value is significant: absence = no
      // style) and CHEAP (token-classify — a full styleSheets walk — runs only AFTER the computed-
      // significance check; the flat wrapper pays zero walks — otherwise hundreds of children ×
      // ~8 walks = a giant-file-class latency regression).
      const cbg = toHex(cs.backgroundColor);
      if (cbg !== undefined) {
        child.styles.backgroundColor = cbg;
        child.styles.backgroundColorToken = classifyColor(n, 'background-color', cbg);
      }
      const crad = radiusOf(cs);
      if (crad.uncomparable) child.styles.borderRadiusUncomparable = true;
      else if (crad.value > 0) child.styles.borderRadius = crad.value;
      const cop = num(cs.opacity);
      if (cop !== undefined && cop < 1) child.styles.opacity = cop;
      surveyIcon(n, child.styles);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') {
        const cgrad = classifyGradient(n, cs);
        // Raster / url(...) background: classifyGradient sees no gradient layer → undefined. It is still a
        // REAL visible paint the gradient detector can't model, so flag it (compact — only when present) so
        // styleAnchor's transparentChild disqualifies this wrapper instead of descending through a painted node.
        if (cgrad) child.styles.gradient = cgrad;
        else child.styles.bgImage = true;
      }
      if (cs.boxShadow && cs.boxShadow !== 'none') {
        const csh = parseShadow(cs.boxShadow);
        if (csh) { csh.colorToken = classifyColor(n, 'box-shadow', csh.colorHex); child.shadow = csh; }
      }
      const cbw = { top: num(cs.borderTopWidth) || 0, right: num(cs.borderRightWidth) || 0,
        bottom: num(cs.borderBottomWidth) || 0, left: num(cs.borderLeftWidth) || 0 };
      if (cbw.top || cbw.right || cbw.bottom || cbw.left) {
        child.borders = cbw;
        child.borderColors = { top: toHex(cs.borderTopColor), right: toHex(cs.borderRightColor),
          bottom: toHex(cs.borderBottomColor), left: toHex(cs.borderLeftColor) };
        child.borderColorsToken = {
          top: cbw.top ? classifyColor(n, 'border-top-color', toHex(cs.borderTopColor)) : undefined,
          right: cbw.right ? classifyColor(n, 'border-right-color', toHex(cs.borderRightColor)) : undefined,
          bottom: cbw.bottom ? classifyColor(n, 'border-bottom-color', toHex(cs.borderBottomColor)) : undefined,
          left: cbw.left ? classifyColor(n, 'border-left-color', toHex(cs.borderLeftColor)) : undefined };
      }
      const cds = Object.entries(n.dataset || {}).slice(0, 10);
      if (cds.length) child.data = Object.fromEntries(cds);
      if (depthLeft > 0) {
        const kids = flowChildren(n, depthLeft - 1, nodePath);
        child.children = kids.slice(0, 15);
        if (kids.length > 15) child.childrenTruncated = true;
        if (kids.outOfFlow) child.outOfFlow = kids.outOfFlow;
      } else if (hasFlowContent(n)) {
        // depth budget exhausted, but there IS real flow content below — honest, not a fake leaf.
        child.childrenTruncated = true;
      }
      out.push(child);
    }
    return out;
  };
  // Post-pruning of the total budget (the budget param, default 90 — the base of the budgetFor(maxDepth) formula from
  // projector.ts; get-layout-spec-tool.ts passes budgetFor(maxDepth) here as the 4th argument when
  // max_depth is explicit, so budget scales up to 180 at maxDepth 5-8). The Zod gate in
  // dom-snapshot-schema.ts is a SEPARATE mirror, a static upper backstop of 300 nodes (a sanity cap
  // in case the extractor doesn't honor budget) — this is NOT the same number as the base-90 here; don't confuse
  // "budget=90 by default" with "Zod accepts 90 max" (see dom-snapshot-schema.ts:70-75).
  // max_depth drill-down: all mirrors (this, projector.ts pruneToBudget, the Zod gate)
  // must agree in sync BY MEANING — the same per-request budget must reach here as an honest
  // 4th argument, otherwise a deep snapshot either doesn't reach here honestly truncated, or is
  // rejected by Zod BEFORE the diff. A level is accepted whole only if it fits the remainder; otherwise
  // children is dropped (childrenTruncated=true) and the node itself stays. The reserve for the whole level
  // is allocated BEFORE the decision on any specific node — otherwise "flat" siblings past the budget threshold
  // still make it into the output (each array node is unremovable), and the total can exceed budget
  // (proven at the default 60: 30 root × 2 leaves gives 70 without a reserve, 60 with it — the same reserve mechanism
  // scales to any budget unchanged).
  const pruneToBudget = (kids, state, budgetCap) => {
    state.n += kids.length;
    for (const k of kids) {
      if (!k.children) continue;
      if (state.n + k.children.length > budgetCap) { k.childrenTruncated = true; delete k.children; continue; }
      pruneToBudget(k.children, state, budgetCap);
    }
  };
  // Authored-binding classifier: value-anchored, conservative-unknown.
  // Returns { token } | { literal: true } | { unknown: reason }. Doctrine: undecidable → unknown, NEVER
  // literal — with a NARROW REMAINING RESIDUAL (litHex now parses rgb()/#hex/hsl()/named-color literal
  // forms; only oklch()/lab()/color-mix() literals co-occurring with a pixel-anchoring var are still
  // mis-scored {token} instead of {ambiguous-cascade} — device-independent color-space math needs a
  // browser normalizer the harness lacks; documented at litHex below, whole-branch follow-up). A token
  // claim is only ever value-anchored (resolved var == computed pixel). Hardening over the core subset: (a) shorthand-authored var() — CSSOM empties the longhand
  // on the rule, so the var lives only on the shorthand entry (background / border[-side]); read those
  // too. (b) @media/@supports recursion — evaluate the condition LIVE (matchMedia / CSS.supports) and
  // descend only when active, so an inactive block never contributes a candidate. (c) @layer — with
  // layers in play, CSSOM source order no longer reveals the specificity winner, so "last authored
  // wins" is unsound → unknown (unless inline wins outright). (d) composite box-shadow — the color
  // can't be isolated from a partial var, so the token claim anchors on the WHOLE computed shadow, and
  // an unattributable composite stays unknown, never literal.
  const classifyColor = (el, prop, computedHex) => {
    if (computedHex === undefined) return undefined; // unparseable color — hex axis handles it
    const cs = getComputedStyle(el);
    const SHORTHANDS = { 'background-color': ['background'], 'border-top-color': ['border-top', 'border'],
      'border-right-color': ['border-right', 'border'], 'border-bottom-color': ['border-bottom', 'border'],
      'border-left-color': ['border-left', 'border'] };
    const shorthands = SHORTHANDS[prop] || [];
    // gather candidate authored values for prop: inline first (highest precedence), then matched rules
    const candidates = [];
    let sawUnreadable = false;
    let sawLayeredMatch = false;   // a rule DECLARING this prop sits inside an @layer block
    // push prop (+ its shorthand carriers) from a CSSStyleDeclaration-like source; returns whether any
    // value was contributed (so @layer is flagged only when the layered rule actually touches this prop).
    const pushFrom = (style) => {
      let pushed = false;
      const v = style.getPropertyValue(prop);
      if (v) { candidates.push(v); pushed = true; }
      for (const sh of shorthands) { const sv = style.getPropertyValue(sh); if (sv) { candidates.push(sv); pushed = true; } }
      return pushed;
    };
    let inlineCount = 0;
    if (el.style && el.style.getPropertyValue) { const before = candidates.length; pushFrom(el.style); inlineCount = candidates.length - before; }
    const isLayerRule = (r) => (typeof CSSLayerBlockRule !== 'undefined' && r instanceof CSSLayerBlockRule)
      || (r.constructor && r.constructor.name === 'CSSLayerBlockRule');
    // recurse grouping rules: @media (type 4)/@supports (type 12) descend only when the condition is
    // active (evaluated live) — an inactive block must NOT contribute a candidate (never-false-green);
    // @layer blocks descend but flag the match as layered; other grouping rules pass through.
    // CSS NESTING: a STYLE rule can ALSO carry nested rules (r.cssRules) — modern CSS-module pipelines
    // (SCSS / Lightning CSS / PostCSS) compile to nested CSS, so '.x { color: var(--t); &:hover {…} }' is one
    // CSSStyleRule with BOTH its own declarations AND .cssRules. The grouping check must therefore key on
    // "has cssRules AND NO own selectorText" (true grouping) — a nesting style rule has a selectorText and
    // must fall through to the style branch, or every nested-authored color is skipped → {unknown} on the
    // whole DS (a production live-acceptance root cause). scopeSel carries the parent's resolved selector so
    // '&' in a nested rule resolves against it. This only ADDS candidate sources — value-anchor + the
    // ambiguity gates keep it never-false-green (a new source can only turn unknown→token/literal/ambiguous).
    const walk = (rules, inLayer, scopeSel) => {
      for (const r of Array.from(rules || [])) {
        if (r.cssRules && !r.selectorText) {
          if (isLayerRule(r)) { walk(r.cssRules, true, scopeSel); continue; }
          if (r.type === 4) {
            let active = false; try { active = !!(window.matchMedia && window.matchMedia(r.conditionText).matches); } catch (e) {}
            if (active) walk(r.cssRules, inLayer, scopeSel);
            continue;
          }
          if (r.type === 12) {
            let active = false; try { active = !!(window.CSS && window.CSS.supports && window.CSS.supports(r.conditionText)); } catch (e) {}
            if (active) walk(r.cssRules, inLayer, scopeSel);
            continue;
          }
          // @container / @scope / other conditional grouping whose condition we do NOT evaluate:
          // descending would let an INACTIVE block contribute a phantom candidate (false-green). Skip
          // entirely — costs a false-red (a token inside an ACTIVE container is missed), doctrine-aligned
          // (never-false-green > completeness). Only @media/@supports (gated live) and @layer descend. (C)
          continue;
        }
        // style rule (nested or not): read its own declarations, then descend into its nested rules.
        if (r.style && r.selectorText) {
          // resolve & against the enclosing scope, wrapped in :is() so selector lists / combinators stay
          // correct (specificity is irrelevant to value-anchoring). A nested rule with a non-matching
          // resolved selector (e.g. &:hover in the resting snapshot, & .child pointing at a descendant) is
          // filtered out by el.matches exactly as the browser would — so no phantom candidate.
          // replacement is a FUNCTION (not a string) so a '$' inside scopeSel — e.g. an attribute value
          // adjacent to a quote — is inserted verbatim, never interpreted as a $-pattern ($&, $', $1...).
          const effSel = scopeSel ? r.selectorText.replace(/&/g, () => ':is(' + scopeSel + ')') : r.selectorText;
          let m = false; try { m = el.matches(effSel); } catch (e) {}
          if (m && pushFrom(r.style) && inLayer) sawLayeredMatch = true;
          if (r.cssRules) walk(r.cssRules, inLayer, effSel);
          continue;
        }
        // bare nested declarations (CSSNestedDeclarations: style, no selectorText, no cssRules) — these apply
        // to the ENCLOSING scope element (the parent rule's subject), so gate them on scopeSel matching el.
        if (r.style && scopeSel) {
          let m = false; try { m = el.matches(scopeSel); } catch (e) {}
          if (m && pushFrom(r.style) && inLayer) sawLayeredMatch = true;
        }
      }
    };
    let sheets;
    try { sheets = document.styleSheets; } catch (e) { sheets = []; }
    for (const sh of Array.from(sheets || [])) {
      let rules; try { rules = sh.cssRules; } catch (e) { sawUnreadable = true; continue; }
      walk(rules, false, null);
    }
    // value-anchor: a var() counts only if the referenced custom prop resolves to the computed hex. An
    // authored value can name SEVERAL custom props (shorthand 'border: var(--w) solid var(--line)') — pull
    // EVERY one and anchor each, or a leading non-color var (--w→2px, unanchorable) masks the real color
    // token (--line) and the edge is misread as literal (false-red).
    const varMatchAll = (val) => { const out = []; const re = /var\\(\\s*(--[\\w-]+)/g; let mm; while ((mm = re.exec(val || ''))) out.push(mm[1]); return out; };
    // @layer posture (relaxed): value-anchoring is cascade-order / specificity / importance / @layer
    // -AGNOSTIC — a var counts ONLY if it resolves to the REAL computed pixel (ground truth), so the WINNING
    // declaration's own value is always among the anchors. @layer changes WHO wins, not the candidate set nor
    // each candidate's resolved pixel. So we do NOT bail on sawLayeredMatch here (the old blanket
    // 'layered-undecidable' was over-conservative and nuked token attribution on whole-DS-in-@layer apps): the
    // explain-based logic below is sound under layers for {token} (a single unambiguous anchor is a proof). The
    // ONE thing layers make unprovable is {literal:true} — an unparseable-form winner (oklch/lab/color-mix) in a
    // WINNING layer can shadow a coincident literal in a LOSING layer — so the literal fallback is suppressed to
    // {unknown:'layered-undecidable'} in the tail. Residual under layers = the SAME pre-existing residuals as the
    // non-layered path (unparseable-form / cross-origin-unreadable / @container-@scope-skipped / CSS-wide-keyword
    // winner co-occurring with a pixel-coincident var → {token}); relaxing merely brings layered to parity with
    // the already-shipped non-layered behavior — NO new class of false-green.
    // box-shadow needs no layer guard either: its branch surveys ALL var-carriers reproducing the whole computed
    // shadow (>1 distinct → composite-shadow) and never returns literal, so it is layer-agnostic-sound too.
    if (prop === 'box-shadow') {
      const normShadow = (s) => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const computedShadow = normShadow(cs.boxShadow);
      // Survey ALL var-carriers across ALL candidates (not first-hit last->first) whose value reproduces the
      // WHOLE computed shadow. >1 DISTINCT match → the winner is not provable (e.g. two layers each carrying a
      // matching var) → composite-shadow, never a guessed token (S5 fix; mirrors the color axis' ambiguity
      // survey). Layer-agnostic: the winning shadow declaration's value is among the surveyed candidates.
      const shadowAnchors = new Set();
      let sawVarCarrier = false;
      for (const cand of candidates) {
        const names = varMatchAll(cand);
        if (!names.length) continue;
        sawVarCarrier = true;
        for (const name of names) {
          if (computedShadow && normShadow(cs.getPropertyValue(name)) === computedShadow) shadowAnchors.add(name);
        }
      }
      if (shadowAnchors.size === 1) return { token: Array.from(shadowAnchors)[0] };
      if (shadowAnchors.size > 1) return { unknown: 'composite-shadow' };
      if (sawVarCarrier) return { unknown: 'composite-shadow' };   // var carrier(s) but none reproduce the whole shadow
      if (sawUnreadable) return { unknown: 'cross-origin' };
      if (candidates.length === 0) return { unknown: 'unattributed' };   // (D): box-shadow does NOT inherit — no rule found, not 'inherited'
      return { unknown: 'composite-shadow' };   // literal composite (no var) — never literal
    }
    // explain-based cascade classification: do NOT stop at the first anchoring var — a
    // pixel-coincident var would beat the real literal winner (DOM hardcoded a literal UNDER a matching
    // token → the very defect the tool exists to catch). Survey ALL candidates: collect every var name
    // that value-anchors in the computed hex, and whether any var-FREE candidate literally explains the
    // pixel. A token is claimed ONLY when it is the single, unambiguous explanation; otherwise → unknown.
    const anchoredNames = new Set();
    let explainingLiteral = false;
    const cl = computedHex.toLowerCase();
    for (const cand of candidates) {
      const names = varMatchAll(cand);
      if (names.length) {
        // var carrier (incl. var(--undef,#lit) fallback): only its anchoring vars count; its literal
        // fallback is NOT a standalone literal explanation (conservative — fallback wins only when the
        // var is undefined, and that already routes to {literal} below when no var anchors).
        // The custom-prop VALUE is parsed with litHex (hex/rgb/hsl/named), NOT rgb-only toHexLoose:
        // hex-authored DS tokens ('--neutral-fg: #9e9e9e') are the common case and MUST anchor, else
        // every hex-authored tokened color is misread {literal} → false-red across the whole DS.
        // litHex's named-color WORD-scan can extract an incidental color word from a non-color prop value
        // (e.g. '2px solid red'); the anchor stays sound only because cl is the SAME element/property's
        // real computed pixel — an incidental word can equal it only if that value truly produced the pixel
        // (an invalid substitution for the color property never resolves to that color). A purely
        // numeric/keyword value ('2px') yields undefined → never anchors (defect-B non-regression; locked).
        for (const name of names) {
          const resolved = litHex(cs.getPropertyValue(name));
          if (resolved && resolved.toLowerCase() === cl) anchoredNames.add(name);
        }
      } else if (litHex(cand) === cl) {
        explainingLiteral = true;
      }
    }
    // a literal AND a token both explain the pixel, OR several distinct vars anchor → the cascade winner
    // is not provable → unknown, never a guessed token/literal (never-false-green; ambiguous-cascade).
    if (explainingLiteral && anchoredNames.size > 0) return { unknown: 'ambiguous-cascade' };
    if (anchoredNames.size === 1) return { token: Array.from(anchoredNames)[0] };
    if (anchoredNames.size > 1) return { unknown: 'ambiguous-cascade' };
    // no var anchors the pixel
    if (sawUnreadable) return { unknown: 'cross-origin' };
    if (candidates.length === 0) {
      // (D) honest reason-code: 'inherited' is only truthful for an INHERITING prop (color). A non-inheriting
      // prop (background / border-*-color) with a real color but no matched authoring rule was NOT inherited —
      // the rule simply was not found (dev-server-evicted <style>, or an adopted/shadow-root sheet we do not
      // scan). Label that 'unattributed' instead of mislabeling it 'inherited'. Either way it stays unknown —
      // never a false token/literal.
      return { unknown: (prop === 'color' || prop === 'fill' || prop === 'stroke') ? 'inherited' : 'unattributed' };
    }
    // under layers a {literal:true} verdict is unprovable: an unparseable-form winner (oklch/lab/color-mix) in a
    // winning layer can shadow a coincident literal in a losing layer, and litHex can't see it to set
    // explainingLiteral. Suppress to unknown — never a false {literal} under layers. (never-false-green)
    if (sawLayeredMatch) return { unknown: 'layered-undecidable' };
    return { literal: true };   // var(--undef,#lit) fallback / pure literal (non-layered)
  };
  // icon-color (feedback item 6, phase 1): the painted color of an svg icon. Panel-locked
  // rules: survey ALL path-like descendants (first-path-only is a one-sided multi-color
  // detector); fill -> none => stroke (outline icons paint the stroke); alpha folds through
  // fill/stroke-opacity and the element opacity chain up to the svg (toHex's 8-digit
  // convention); computed fill already resolves currentColor - no fallback (for an unset fill
  // it would replace the SVG-initial black with an invented inherited color); unreadable
  // paints (url()/gradients) emit an explicit unknown - a new extractor always writes
  // SOMETHING for a detected svg, which is what makes an ABSENT field mean 'older extractor'.
  const ICON_PARTS = 'path,circle,rect,line,polygon,polyline,ellipse';
  const iconSvgOf = (el) => {
    if (el.tagName.toLowerCase() === 'svg') return el;
    if (!el.querySelectorAll) return undefined;
    const svgs = Array.from(el.querySelectorAll('svg'));
    if (svgs.length !== 1) return undefined;
    const sr = svgs[0].getBoundingClientRect(); const er = el.getBoundingClientRect();
    if (er.width <= 0 || er.height <= 0) return undefined;
    // per-DIMENSION threshold: a 16x16 glyph inside a 24x24 padded button is 44% by area but
    // clearly THE icon - each dimension must cover at least half its box.
    return (sr.width >= er.width / 2 && sr.height >= er.height / 2) ? svgs[0] : undefined;
  };
  const surveyIcon = (el, styles) => {
    const svg = iconSvgOf(el);
    if (!svg) return;
    const parts = Array.from(svg.querySelectorAll(ICON_PARTS));
    if (parts.length === 0) { styles.iconColorUnknown = 'no path-like elements'; return; }
    // Template containers (defs/clipPath/mask/symbol/pattern/marker) hold geometry that is not
    // itself rendered, and display:none does NOT inherit - a descendant of a hidden <g> still
    // computes its own display 'inline'. One ancestor walk answers both.
    const NON_PAINTING = ['defs', 'clippath', 'mask', 'symbol', 'pattern', 'marker'];
    const hiddenOrTemplate = (n) => {
      let cur = n;
      while (cur) {
        if (getComputedStyle(cur).display === 'none') return true;
        if (NON_PAINTING.indexOf((cur.tagName || '').toLowerCase()) !== -1) return true;
        if (cur === svg) break;
        cur = cur.parentElement;
      }
      return false;
    };
    // The opacity chain folds up to the SURVEYED element INCLUSIVE: a wrapper's own opacity dims
    // the glyph exactly like a Figma candidate's own opacity, which the projector folds - stopping
    // at the svg made the two sides compare different conventions on the padded-wrapper shape.
    const alphaChainOf = (n) => {
      let a = 1; let cur = n;
      while (cur) { const o = num(getComputedStyle(cur).opacity); if (o !== undefined) a *= o; if (cur === el) break; cur = cur.parentElement; }
      return a;
    };
    const withAlpha = (hex, alpha) => {
      const base = hex.slice(0, 7);
      const prior = hex.length === 9 ? parseInt(hex.slice(7, 9), 16) / 255 : 1;
      const a = Math.max(0, Math.min(1, prior * alpha));
      return a >= 1 ? base : base + Math.round(a * 255).toString(16).padStart(2, '0');
    };
    let hex; let multi = false; let unknown; let carrier; let carrierProp = 'fill'; let attrLiteral = false;
    for (const p of parts) {
      if (hiddenOrTemplate(p)) continue;
      const pcs = getComputedStyle(p);
      let paintProp = 'fill'; let paint = pcs.fill;
      if (!paint || paint === 'none') { paintProp = 'stroke'; paint = pcs.stroke; }
      if (!paint || paint === 'none') continue;
      // A fully transparent paint renders nothing - the part contributes NOTHING (like
      // display:none), it is not an 'unreadable' paint (toHex refuses alpha 0 by design).
      if (paint === 'transparent' || /rgba?\\([^)]+,\\s*0(\\.0+)?\\s*\\)\\s*$/.test(paint)) continue;
      const ph = toHexLoose(paint);
      if (ph === undefined) { if (unknown === undefined) unknown = 'unreadable ' + paintProp + ' (' + String(paint).slice(0, 48) + ')'; continue; }
      const fo = num(paintProp === 'fill' ? pcs.fillOpacity : pcs.strokeOpacity);
      const eff = withAlpha(ph, (fo === undefined ? 1 : fo) * alphaChainOf(p));
      if (hex === undefined) {
        hex = eff; carrier = p; carrierProp = paintProp;
        // Value-anchored attribute claim (the classifyColor doctrine - a literal is only ever
        // claimed from a value that PRODUCED the pixel): fill="currentColor" is a deferral, and
        // a presentation attribute beaten by author CSS painted nothing - both fall through to
        // the classifier on the property that actually carried the paint.
        const av = p.getAttribute && p.getAttribute(paintProp);
        const ah = av ? toHexLoose(av) || namedHex(av) || hslHex(av) || (/^#[0-9a-f]{6}$/i.test(av) ? av.toLowerCase() : undefined) : undefined;
        attrLiteral = ah !== undefined && ah.slice(0, 7) === ph.slice(0, 7).toLowerCase();
      }
      else if (hex !== eff) multi = true;
    }
    if (multi) { styles.iconColorMulti = true; return; }
    if (hex === undefined) { styles.iconColorUnknown = unknown || 'no readable fill/stroke'; return; }
    if (unknown !== undefined) { styles.iconColorUnknown = unknown; return; }
    styles.iconColor = hex;
    const tok = attrLiteral ? { literal: true } : classifyColor(carrier, carrierProp, hex.slice(0, 7));
    if (tok !== undefined) styles.iconColorToken = tok;
  };
    // gradient: bracket-aware top-level comma split (rgb()/var() contain commas — naive split corrupts stops)
    const splitTop = (s) => {
      const out = []; let depth = 0, cur = '';
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '(') depth++; else if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
      }
      if (cur.trim()) out.push(cur.trim());
      return out;
    };
    const SIDE_DEG = { 'to top':0,'to right':90,'to bottom':180,'to left':270,'to top right':45,'to right top':45,'to bottom right':135,'to right bottom':135,'to bottom left':225,'to left bottom':225,'to top left':315,'to left top':315 };
    // parse ONE computed gradient layer -> { kind, angleDeg, stops:[{position,hex}] } (ground-truth; NO tokens here)
    const parseCssGradient = (layer) => {
      const m = layer.match(/^(repeating-)?(linear|radial|conic)-gradient\\((.*)\\)$/);
      if (!m) return null;
      const kind = m[1] ? 'unknown' : m[2];
      const parts = splitTop(m[3]);
      let angleDeg; let stopParts = parts;
      if (m[2] === 'linear' && !m[1]) {
        const head = parts.length ? parts[0] : '';
        if (/deg\\s*$/.test(head)) { angleDeg = ((parseFloat(head) % 360) + 360) % 360; stopParts = parts.slice(1); }
        else if (/^to /.test(head)) { angleDeg = SIDE_DEG[head.trim()]; stopParts = parts.slice(1); }
        else { angleDeg = 180; }
      } else {
        // radial/conic: drop leading geometry descriptor if first part is not a color
        if (parts.length && litHex(parts[0].split(/\\s+/)[0]) === undefined && !/^var\\(/.test(parts[0])) stopParts = parts.slice(1);
      }
      const stops = stopParts.map((p) => {
        const toks = p.split(/\\s+/);
        const posTok = toks.find((t) => /%\\s*$/.test(t));
        // color = the stop MINUS its position token(s): computed rgb()/hsl() carry internal spaces
        // (rgb(32, 161, 176)), so a naive toks[0] truncates the color to 'rgb(32,' -> litHex undefined.
        // Rejoin the non-position tokens so the full color literal reaches litHex (never-false-green).
        const colorTok = toks.filter((t) => !/%\\s*$/.test(t)).join(' ');
        return { colorTok: colorTok, hex: litHex(colorTok), position: posTok ? parseFloat(posTok) / 100 : undefined };
      });
      // normalize auto positions: first->0, last->1, interior evenly between explicit neighbours
      if (stops.length) {
        if (stops[0].position === undefined) stops[0].position = 0;
        if (stops[stops.length - 1].position === undefined) stops[stops.length - 1].position = 1;
        for (let i = 1; i < stops.length - 1; i++) if (stops[i].position === undefined) {
          let j = i + 1; while (j < stops.length && stops[j].position === undefined) j++;
          const lo = stops[i - 1].position, hi = stops[j].position, span = j - (i - 1);
          stops[i].position = lo + (hi - lo) * (1 / span);
        }
      }
      return { kind, angleDeg, stops };
    };
    // authoredCandidates(el, prop, shorthands): ALL matched authored values of prop (plus each shorthand carrier)
    // across matched CSS rules + inline — RAW, NOT computed (computed resolves var(), which gradient provenance
    // must NOT lose). Returns EVERY matched value (not just the source-order-last winner-proxy) so the caller can
    // run an ambiguity survey: CSSOM source order is NOT specificity/@layer order, so a source-later coincident
    // var can masquerade as the winner over a more-specific hardcoded literal — the exact false-green that
    // classifyColor's survey catches. An isolated minimal copy of classifyColor's walk (color path untouched).
    // CSS-NESTING invariants: the true-grouping gate is (r.cssRules AND NO own selectorText) so a CSS-NESTING style rule
    // (has selectorText AND cssRules) falls through to the style branch and is NOT skipped; '&' resolves to
    // :is(scopeSel) on descent. Only @layer / live-active @media / @supports descend — an inactive or unevaluated
    // (@container/@scope) grouping block is skipped so it never contributes a phantom authored value.
    const authoredCandidates = (el, prop, shorthands) => {
      const out = [];
      // @layer parity: a MATCHED rule that pushes a candidate while sitting inside an @layer block makes
      // the {literal} fallback UNPROVABLE (an unparseable-form winner in a winning layer can shadow it) —
      // track it so classifyGradient suppresses only the literal fallbacks to layered-undecidable.
      let sawLayered = false;
      const pushFrom = (style) => {
        let pushed = false;
        const v = style.getPropertyValue(prop);
        if (v) { out.push(v); pushed = true; }
        for (const sh of shorthands || []) { const sv = style.getPropertyValue(sh); if (sv) { out.push(sv); pushed = true; } }
        return pushed;
      };
      const isLayerRule = (r) => (typeof CSSLayerBlockRule !== 'undefined' && r instanceof CSSLayerBlockRule)
        || (r.constructor && r.constructor.name === 'CSSLayerBlockRule');
      const walkA = (rules, scopeSel, inLayer) => {
        for (const r of Array.from(rules || [])) {
          if (r.cssRules && !r.selectorText) {
            if (isLayerRule(r)) { walkA(r.cssRules, scopeSel, true); continue; }
            if (r.type === 4) { let active = false; try { active = !!(window.matchMedia && window.matchMedia(r.conditionText).matches); } catch (e) {} if (active) walkA(r.cssRules, scopeSel, inLayer); continue; }
            if (r.type === 12) { let active = false; try { active = !!(window.CSS && window.CSS.supports && window.CSS.supports(r.conditionText)); } catch (e) {} if (active) walkA(r.cssRules, scopeSel, inLayer); continue; }
            continue;
          }
          if (r.style && r.selectorText) {
            const effSel = scopeSel ? r.selectorText.replace(/&/g, () => ':is(' + scopeSel + ')') : r.selectorText;
            let m = false; try { m = el.matches(effSel); } catch (e) {}
            if (m) { if (pushFrom(r.style) && inLayer) sawLayered = true; }
            if (r.cssRules) walkA(r.cssRules, effSel, inLayer);
            continue;
          }
          if (r.style && scopeSel) { let m = false; try { m = el.matches(scopeSel); } catch (e) {} if (m) { if (pushFrom(r.style) && inLayer) sawLayered = true; } }
        }
      };
      if (el.style && el.style.getPropertyValue) pushFrom(el.style);   // inline is never layered (inLayer=false)
      let sheets; try { sheets = document.styleSheets; } catch (e) { sheets = []; }
      for (const sh of Array.from(sheets || [])) {
        let rules; try { rules = sh.cssRules; } catch (e) { continue; }
        walkA(rules, null, false);
      }
      return { values: out, sawLayered };
    };
    // classifyGradient(el, cs) -> GradientModel | undefined  (value-anchored provenance whole+per-stop,
    // ambiguity-surveyed against source-order false-green — mirrors classifyColor's cascade doctrine).
    const classifyGradient = (el, cs) => {
      const bg = cs.backgroundImage;
      if (!bg || bg === 'none') return undefined;
      const layers = splitTop(bg);
      let parsed = null, idx = -1;
      for (let i = 0; i < layers.length; i++) { const p = parseCssGradient(layers[i]); if (p) { parsed = p; idx = i; break; } }
      if (!parsed) return undefined;
      // ALL authored candidates (raw, var-preserving). We read authored 'background-image' (fallback shorthand
      // 'background'). Authored/resolved layers map 1:1 to computed layers, so we compare the layer at idx (the
      // computed gradient layer we chose), not 0.
      const { values: cands, sawLayered } = authoredCandidates(el, 'background-image', ['background']);
      // does a gradient VALUE reproduce the chosen computed gradient layer? (same kind + stop count + every stop
      // hex equal; an unparseable computed stop hex (oklch/lab) is never counted a match — never-false-green).
      const matchesComputed = (val) => {
        const g = parseCssGradient(splitTop(val)[idx] || '');
        return !!(g && g.kind === parsed.kind && g.stops.length === parsed.stops.length
          && g.stops.every((s, i) => parsed.stops[i].hex !== undefined && s.hex === parsed.stops[i].hex));
      };
      // whole provenance via ambiguity survey: a var counts ONLY if its resolved value reproduces the computed
      // gradient (value-anchor). A coincident literal-gradient candidate that ALSO reproduces it, OR >1 distinct
      // anchoring token, means the cascade winner is unprovable → {unknown:'ambiguous-cascade'}, never a guessed
      // token. This closes the source-order false-green (a hardcoded literal winner + a later coincident var(--g)
      // both anchor in the same computed pixels, and source order alone cannot say which the browser applied).
      let whole;
      const anchoredNames = [];
      let explainingLiteral = false, sawLiteralGradient = false, sawNestedVar = false, sawWholeVar = false;
      for (const cand of cands) {
        const t = cand.trim();
        const wm = t.match(/^var\\(\\s*(--[\\w-]+)/);
        if (wm) {
          sawWholeVar = true;
          const val = cs.getPropertyValue(wm[1]);
          if (/var\\(/.test(val)) { sawNestedVar = true; continue; }   // nested var → hex-equality unreachable
          if (matchesComputed(val) && anchoredNames.indexOf(wm[1]) === -1) anchoredNames.push(wm[1]);
        } else if (parseCssGradient(splitTop(t)[idx] || '')) {
          sawLiteralGradient = true;
          if (matchesComputed(t)) explainingLiteral = true;
        }
      }
      if (cands.length === 0) whole = { unknown: 'unattributed' };
      else if (explainingLiteral && anchoredNames.length > 0) whole = { unknown: 'ambiguous-cascade' };
      else if (anchoredNames.length > 1) whole = { unknown: 'ambiguous-cascade' };
      else if (anchoredNames.length === 1) whole = { token: anchoredNames[0] };
      else if (sawLiteralGradient) whole = sawLayered ? { unknown: 'layered-undecidable' } : { literal: true };
      else if (sawNestedVar) whole = { unknown: 'nested-var' };
      else if (sawWholeVar) whole = { unknown: 'anchor-mismatch' };
      else whole = { unknown: 'unattributed' };
      // per-stop provenance: same doctrine over ALL literal-gradient candidates (whole-vars excluded — their
      // stops are the whole token's concern) that match the computed stop count. When whole itself is ambiguous,
      // no stop is creditable either (conservative — honest 'ambiguous-cascade', never a false token).
      let stopTokens;
      if (whole.unknown === 'ambiguous-cascade') {
        stopTokens = parsed.stops.map(() => ({ unknown: 'ambiguous-cascade' }));
      } else {
        const litGrads = [];
        let sawMismatchCount = false;
        for (const cand of cands) {
          const t = cand.trim();
          if (/^var\\(/.test(t)) continue;
          const g = parseCssGradient(splitTop(t)[idx] || '');
          if (!g) continue;
          if (g.stops.length === parsed.stops.length) litGrads.push(g); else sawMismatchCount = true;
        }
        if (litGrads.length) {
          stopTokens = parsed.stops.map((ps, i) => {
            const anchoredVars = [];
            let explaining = false, sawVar = false, sawInnerVar = false;
            for (const g of litGrads) {
              const colorTok = g.stops[i].colorTok || '';   // empty colorTok (transition-hint) → not var → literal
              const vm = colorTok.match(/^var\\(\\s*(--[\\w-]+)/);
              if (vm) {
                sawVar = true;
                if (ps.hex !== undefined && litHex(cs.getPropertyValue(vm[1])) === ps.hex && anchoredVars.indexOf(vm[1]) === -1) anchoredVars.push(vm[1]);
              } else if (ps.hex !== undefined && litHex(colorTok) === ps.hex) {
                explaining = true;
              } else if (/var\\(/.test(colorTok)) {
                sawInnerVar = true;   // var() wrapped in an unparseable form (color-mix/light-dark/relative-color) — literal cannot be isolated
              }
            }
            if (explaining && anchoredVars.length > 0) return { unknown: 'ambiguous-cascade' };
            if (anchoredVars.length > 1) return { unknown: 'ambiguous-cascade' };
            if (anchoredVars.length === 1) return { token: anchoredVars[0] };
            if (sawVar) return { unknown: 'stop-anchor-mismatch' };
            if (sawInnerVar && !explaining) return { unknown: 'inner-var-unreadable' };   // token-derived stop the DOM tokenized — REVIEW, not a false-red literal (a lone explaining literal stays literal)
            return sawLayered ? { unknown: 'layered-undecidable' } : { literal: true };
          });
        } else if (sawMismatchCount) {
          stopTokens = parsed.stops.map(() => ({ unknown: 'stop-count-mismatch' }));
        } else {
          stopTokens = parsed.stops.map(() => (sawLayered ? { unknown: 'layered-undecidable' } : { literal: true }));
        }
      }
      const model = { kind: parsed.kind, stops: parsed.stops.map((s, i) => ({ position: s.position, hex: s.hex, token: stopTokens[i] })), whole: whole };
      if (parsed.angleDeg !== undefined) model.angleDeg = parsed.angleDeg;
      if (layers.length > 1) model.multiLayer = true;
      // repeating gradient: kind stays 'unknown' (we do not fully model repeating), and whole is suppressed to
      // an honest unknown regardless of provenance — conservative (a false-red at worst), never a false token.
      if (parsed.kind === 'unknown') model.whole = { unknown: 'repeating' };
      return model;
    };
  // A gutter can be RESERVED without being painted (scrollbar-gutter: stable, page does not scroll):
  // innerWidth - clientWidth reads 0 while the page root really lost it, and only the ROOT BOX shows
  // it. Omitted unless a gutter is DECLARED, and the html margins are subtracted: measured,
  // html{margin-left:15px} alone reports exactly one bar, and with stable set it reports two - the
  // both-edges shape. Read-only: nothing is written to the page.
  const docEl = document.documentElement;
  const docCs = getComputedStyle(docEl);
  const docBox = docCs.scrollbarGutter && docCs.scrollbarGutter !== 'auto'
    ? docEl.getBoundingClientRect() : undefined;
  const docMl = docBox ? (num(docCs.marginLeft) || 0) : 0;
  const rawGutter = docBox
    ? Math.max(0, round1(docEl.clientWidth - docBox.width - docMl - (num(docCs.marginRight) || 0)))
    : undefined;
  // ...and how much of it sits on the LEADING edge (both-edges reserves half there). Without this,
  // "root at half a gutter, full width" is indistinguishable from a box overflowing to the right.
  const rawLeft = docBox ? Math.max(0, round1(docBox.x - docMl)) : undefined;
  // A NARROWED html is byte-identical to a reserve. Measured at 1280 with stable declared and no
  // scroll: html{max-width:1200px} -> 80, html{width:1200px} -> 80, transform:scale(.9) -> 141.5, each
  // demoting a shortfall that IS a layout rule. No second witness exists (media-query width and
  // visualViewport are both blind to a reserve, measured), so the reserve is bounded per edge by what
  // a scrollbar can BE and an over-wide reading is DROPPED, not clamped - the page keeps its fail.
  // ponytail: 20px prior; measured bars 11 and 15, and both-edges is 15 PER EDGE. Raise on evidence.
  const gutterOk = rawGutter !== undefined && rawGutter - rawLeft <= 20 && rawLeft <= 20;
  const reservedGutter = gutterOk ? rawGutter : undefined;
  const reservedGutterLeft = gutterOk ? rawLeft : undefined;
  const snapshots = selectors.map((selector) => {
    let found;
    try { found = document.querySelectorAll(selector); }
    catch (e) { return { selector, status: 'not_found' }; }
    if (found.length === 0) return { selector, status: 'not_found' };
    if (found.length > 1) return { selector, status: 'multiple', matches: found.length };
    const el = found[0];
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (cs.display === 'none' || r.width <= 0 || r.height <= 0) return { selector, status: 'hidden' };
    const kids = flowChildren(el, depthLeft, '');
    const children = kids.slice(0, 30);
    pruneToBudget(children, { n: 0 }, budget);
    const shadow = parseShadow(cs.boxShadow);
    if (shadow) shadow.colorToken = classifyColor(el, 'box-shadow', shadow.colorHex);
    const rrad = radiusOf(cs);
    const snap = {
      schema: SCHEMA, status: 'ok', selector,
      innerWidth: window.innerWidth,
      // the width CSS laid the page out in: innerWidth includes the page scrollbar, this does not
      layoutViewportWidth: docEl.clientWidth,
      // ...and this is the part clientWidth does NOT see: a gutter reserved but not painted (above)
      reservedGutter,
      reservedGutterLeft,
      rect: rectOf(r),
      borders: { top: num(cs.borderTopWidth) || 0, right: num(cs.borderRightWidth) || 0,
                 bottom: num(cs.borderBottomWidth) || 0, left: num(cs.borderLeftWidth) || 0 },
      borderColors: { top: toHex(cs.borderTopColor), right: toHex(cs.borderRightColor),
                      bottom: toHex(cs.borderBottomColor), left: toHex(cs.borderLeftColor) },
      borderColorsToken: { top: classifyColor(el, 'border-top-color', toHex(cs.borderTopColor)),
                           right: classifyColor(el, 'border-right-color', toHex(cs.borderRightColor)),
                           bottom: classifyColor(el, 'border-bottom-color', toHex(cs.borderBottomColor)),
                           left: classifyColor(el, 'border-left-color', toHex(cs.borderLeftColor)) },
      shadow,
      paddings: padsOf(cs),
      clientWidth: el.clientWidth,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      scroll: { top: el.scrollTop, left: el.scrollLeft },
      transformed: movedBy(cs.transform),
      fontsLoaded: document.fonts ? document.fonts.status === 'loaded' : undefined,
      styles: Object.assign({ display: cs.display, backgroundColor: toHex(cs.backgroundColor) },
        rrad.uncomparable ? { borderRadiusUncomparable: true } : { borderRadius: rrad.value },
        { opacity: num(cs.opacity), justifyContent: cs.justifyContent,
          colorToken: classifyColor(el, 'color', toHex(cs.color)),
          backgroundColorToken: classifyColor(el, 'background-color', toHex(cs.backgroundColor)),
          gradient: classifyGradient(el, cs) }, typo(cs)),
      componentHints: { tag: el.tagName.toLowerCase(), classList: Array.from(el.classList).slice(0, 10),
        data: Object.fromEntries(Object.entries(el.dataset || {}).slice(0, 10)) },
      children,
      childrenTruncated: kids.length > 30 ? true : undefined,
      outOfFlow: kids.outOfFlow || undefined,
    };
    surveyIcon(el, snap.styles);
    return snap;
  });
  // Back-compat: no uploadUrl -> the historical plain-array return (byte-for-byte).
  if (!uploadUrl) return snapshots;
  // uploadUrl given: full snapshots never leave the browser in this branch —
  // only compact summaries (chat-context-sized), plus the store's ref/expiry
  // or an honest upload_error the caller can surface (see dom-snapshot-routes.ts).
  const summarize = (s) => ({ selector: s.selector, status: s.status || 'ok',
    rect: s.rect ? { w: s.rect.w, h: s.rect.h } : null,
    tag: (s.componentHints && s.componentHints.tag) || null,
    class0: (s.componentHints && s.componentHints.classList && s.componentHints.classList[0]) || null,
    childCount: s.children ? s.children.length : 0 });
  const summaries = snapshots.map(summarize);
  try {
    const resp = await fetch(uploadUrl, { method: 'POST', headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ snapshots }) });
    if (!resp.ok) {
      // resp.text() can itself throw (e.g. body already consumed by an
      // intermediary) — that must not swallow the HTTP status we already have.
      const text = await resp.text().catch(() => '');
      return { upload_error: 'HTTP ' + resp.status + ': ' + text.slice(0, 200), summaries };
    }
    const data = await resp.json();
    return { snapshot_ref: data.snapshot_ref, expires_at: data.expires_at, ...(data.viewport_warning ? { viewport_warning: data.viewport_warning } : {}), summaries };
  } catch (e) { return { upload_error: String(e), summaries }; }
}`;

// Loader thunk (get_layout_spec {extractor_mode:'loader'}, the default when the server has a public
// base URL): a script-tag injection instead of eval/new Function — CSP script-src is commonly looser
// than script-src-elem+unsafe-eval, so this survives stricter host pages that would reject an inline
// eval of EXTRACTOR_JS. Idempotent (checks window.__figmaDomDiff first) so repeated calls in the same
// page don't re-fetch. Same (selectors, uploadUrl, depthLeft, budget) 4-arg signature as EXTRACTOR_JS
// itself, so callers pasting this VERBATIM per get_layout_spec's upload_hint need no branching logic.
// CRITICAL: depthLeft/budget MUST be forwarded to window.__figmaDomDiff — this is the
// prod-default extractor path (loader mode, active whenever the server has a public base URL), so a
// forward-less regression here makes max_depth silently a no-op on the DOM side while the Figma-side
// projection genuinely drills deeper (see dom-extractor.test.ts loader round-trip test). Omitted args
// forward as `undefined`, which still triggers EXTRACTOR_JS's own default parameters (depthLeft = 3,
// budget = 90) on the other end — backward-compat for 2-arg callers is preserved by JS semantics, not
// by branching here.
export const buildExtractorLoader = (baseUrl: string): string => `async (selectors, uploadUrl, depthLeft, budget) => {
  if (!window.__figmaDomDiff) {
    await new Promise((ok, err) => { const s = document.createElement('script');
      s.src = '${baseUrl}/api/dom-snapshots/extractor.js'; s.onload = ok; s.onerror = () => err(new Error('extractor script blocked (CSP?) — re-run get_layout_spec {extractor_mode:"inline"}'));
      document.head.appendChild(s); });
  }
  return await window.__figmaDomDiff(selectors, uploadUrl, depthLeft, budget);
}`;
