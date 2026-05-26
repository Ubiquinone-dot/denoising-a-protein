/* Denoising-a-Protein explorable — render loop.
 *
 * Loads pre-computed EDM forward-noising trajectories (see
 * scripts/noise_ubiquitin.py) and lets the user scrub a single time-fraction
 * τ ∈ [0, 1] that drives all three variant panels in sync.
 *
 *   τ = 0   ⇒  σ ≈ 0       (clean structure)
 *   τ = 1   ⇒  σ = σ_data·σ_max  (structure dissolved)
 *
 * τ is driven by page scroll position within the .scrolly section.
 */

(async function main() {
  const data = await d3.json("data/trajectories.json");
  console.log(`loaded ${data.pdb_id}: ${data.n_frames} frames`);

  // -------------------------------------------------------------------------
  // Color scale — N-terminus to C-terminus along the paper palette
  // (navaho → melon → pink → amaranth → coolgrey → blue → darkblue).
  // -------------------------------------------------------------------------
  const PALETTE = [
    "#FFE0AC", "#FFC6B2", "#FFACB7", "#D59AB5",
    "#9596C6", "#6686C5", "#4B5FAA",
  ];
  const ubqLen = data.hero.coords_3d.length;
  const colorScale = d3.scaleSequential(d3.interpolateRgbBasis(PALETTE))
    .domain([0, ubqLen - 1]);
  const colorOf = i => colorScale(i);

  // Resnums-of-motif as a Set for fast lookup.
  const motifResnums = new Set(data.hero.motif_resnums);
  const isMotifAt = i => motifResnums.has(data.hero.resnums[i]);

  // -------------------------------------------------------------------------
  // ViewBoxes — chosen so atoms can drift somewhat off-frame at high σ
  // without making the clean structure look tiny when τ = 0.
  //
  // All "coords" arrays are now PCA-projected 3D points [x, y, z]; the
  // bbox helpers and SVG layout use only [x, y].  The z dimension drives
  // depth cues (atom size, draw order, opacity) in drawAtoms().
  // -------------------------------------------------------------------------
  function bbox(coords) {
    const xs = coords.map(c => c[0]);
    const ys = coords.map(c => c[1]);
    return {
      x0: Math.min(...xs), x1: Math.max(...xs),
      y0: Math.min(...ys), y1: Math.max(...ys),
    };
  }

  // -------------------------------------------------------------------------
  // SVG defs: radial highlight (so atoms read as spheres) + soft drop
  // shadow filter for the backbone (so the chain lifts off the page).
  // Each panel SVG gets its own <defs> because filter / gradient refs
  // don't reliably cross SVG documents.
  // -------------------------------------------------------------------------
  function installDefs(svg) {
    const defs = svg.append("defs");

    // Radial gradient: bright spot at top-left of each atom, fading to
    // transparent across the disk. Object-bounding-box coords mean it
    // scales automatically to any circle radius.
    const grad = defs.append("radialGradient")
      .attr("id", "sphere-hilite")
      .attr("cx", "30%").attr("cy", "30%")
      .attr("r", "65%").attr("fx", "28%").attr("fy", "26%");
    grad.append("stop").attr("offset", "0%")
      .attr("stop-color", "white").attr("stop-opacity", 0.85);
    grad.append("stop").attr("offset", "55%")
      .attr("stop-color", "white").attr("stop-opacity", 0);

    // Soft drop-shadow filter for the backbone.
    const filt = defs.append("filter")
      .attr("id", "bb-shadow")
      .attr("x", "-20%").attr("y", "-20%")
      .attr("width", "140%").attr("height", "140%");
    filt.append("feGaussianBlur").attr("stdDeviation", 1.2);
  }

  function paddedViewBox(box, pad) {
    return [
      box.x0 - pad,
      box.y0 - pad,
      (box.x1 - box.x0) + 2 * pad,
      (box.y1 - box.y0) + 2 * pad,
    ];
  }

  const heroBox = bbox(data.hero.coords_3d);
  const heroVB = paddedViewBox(heroBox, 6);

  // Variant viewbox: 2× the hero bbox, so atoms have room to drift before
  // they clip out of frame. Past σ ≈ 30 Å they clip — which reads as
  // "structure has dissolved", which is exactly the visual story we want.
  const cx = (heroBox.x0 + heroBox.x1) / 2;
  const cy = (heroBox.y0 + heroBox.y1) / 2;
  const heroW = heroBox.x1 - heroBox.x0;
  const heroH = heroBox.y1 - heroBox.y0;
  const variantW = heroW * 2.2;
  const variantH = heroH * 2.2;
  const variantVB = [cx - variantW / 2, cy - variantH / 2, variantW, variantH];

  // Binder viewbox: union of hero + synthesized partner, with a margin.
  const allBinder = data.hero.coords_3d.concat(data.partner.coords_3d);
  const binderBox = bbox(allBinder);
  const binderVB = paddedViewBox(binderBox, 10);

  // -------------------------------------------------------------------------
  // Drawing primitives. Declared early so they're in scope for the hero and
  // partner renders below (avoids const temporal-dead-zone).
  //
  // Smoothed line generator (Catmull-Rom) makes the backbone read as a
  // continuous ribbon — far more "protein-like" than a polyline through
  // raw CA points. The same smoother works for clean and noised frames;
  // under noise the curve naturally tangles, which is what we want.
  // -------------------------------------------------------------------------
  const lineGen = d3.line()
    .x(d => d[0])
    .y(d => d[1])
    .curve(d3.curveCatmullRom.alpha(0.5));

  // Atom-pack settings — knobs for the depth shading appearance.
  const ATOM_R_BASE = 1.6;
  const ATOM_R_DEPTH = 0.55;   // back-to-front radius scale spread
  const ATOM_ALPHA_BACK = 0.55; // far atoms fade toward this opacity

  // Render a chain (hero or noised) with z-depth shading. Atoms drawn
  // back-to-front, radius and opacity scaled by z so the chain reads as
  // 3D balls-and-sticks rather than a flat scribble.
  //
  //   coords3d : Array<[x, y, z]>
  //   opts     : { showMotif, group, role: "hero" | "noised" | "partner" }
  function drawAtoms(svg, coords3d, opts = {}) {
    const { showMotif = false, group = null, role = "noised" } = opts;
    let g = group ? svg.select(`g.${group}`) : svg;
    if (group && g.empty()) g = svg.append("g").attr("class", group);

    // Per-frame z range — normalize each atom's z to [0, 1] (1 = closest).
    let zMin = Infinity, zMax = -Infinity;
    for (const c of coords3d) {
      if (c[2] < zMin) zMin = c[2];
      if (c[2] > zMax) zMax = c[2];
    }
    const zSpan = (zMax - zMin) || 1;
    const zNorm = i => (coords3d[i][2] - zMin) / zSpan;

    // Backbone — two passes: a wider blurred shadow underneath, then the
    // crisp colored stroke on top. The shadow lifts the line off the page.
    const d = lineGen(coords3d);

    let shadow = g.select("path.bb-shadow");
    if (shadow.empty()) {
      shadow = g.append("path")
        .attr("class", "bb-shadow")
        .attr("fill", "none")
        .attr("stroke", "#000")
        .attr("stroke-width", 2.6)
        .attr("stroke-opacity", 0.18)
        .attr("stroke-linecap", "round")
        .attr("stroke-linejoin", "round")
        .attr("filter", "url(#bb-shadow)");
    }
    shadow.attr("d", d);

    let backbone = g.select("path.backbone");
    if (backbone.empty()) {
      const bbColor = (role === "partner") ? "#b6b6c0" : "#5a5a66";
      const bbOpacity = (role === "partner") ? 0.55 : 0.75;
      backbone = g.append("path")
        .attr("class", "backbone")
        .attr("fill", "none")
        .attr("stroke", bbColor)
        .attr("stroke-width", 1.5)
        .attr("stroke-opacity", bbOpacity)
        .attr("stroke-linecap", "round")
        .attr("stroke-linejoin", "round");
    }
    backbone.attr("d", d);

    // Atoms — render each as a <g> containing a colored disc + a top-left
    // highlight overlay (radial gradient -> looks like a sphere).
    const indexed = coords3d.map((c, i) => ({ i, c }));

    const atoms = g.selectAll("g.atom").data(indexed, d => d.i);
    const enter = atoms.enter().append("g").attr("class", "atom");
    enter.append("circle").attr("class", "disc");
    enter.append("circle").attr("class", "hilite")
      .attr("fill", "url(#sphere-hilite)")
      .attr("pointer-events", "none");

    atoms.merge(enter).each(function (d) {
      const i = d.i;
      const r = ATOM_R_BASE * (1 - ATOM_R_DEPTH * 0.5 + ATOM_R_DEPTH * zNorm(i));
      const alpha = ATOM_ALPHA_BACK + (1 - ATOM_ALPHA_BACK) * zNorm(i);
      const sel = d3.select(this)
        .attr("transform", `translate(${d.c[0]},${d.c[1]})`)
        .attr("opacity", alpha);
      const fill = (role === "partner") ? "#a5a5b3" : colorOf(i);
      const motifHere = showMotif && role !== "partner" && isMotifAt(i);
      sel.select("circle.disc")
        .attr("r", r)
        .attr("fill", fill)
        .attr("stroke", motifHere ? "#08415C" : "#2a2a36")
        .attr("stroke-width", motifHere ? 1.0 : 0.35)
        .attr("stroke-opacity", motifHere ? 1.0 : 0.45);
      sel.select("circle.hilite")
        .attr("r", r * 0.72)
        .attr("cx", -r * 0.28)
        .attr("cy", -r * 0.28);
    });
    atoms.exit().remove();

    // Re-order DOM nodes so back atoms render first (occluded by front).
    g.selectAll("g.atom").sort((a, b) => a.c[2] - b.c[2]);
  }

  // Keep the old names as thin wrappers so the rest of the file is unchanged.
  function drawUbq(svg, coords, opts = {}) {
    drawAtoms(svg, coords, { ...opts, role: opts.role || "noised" });
  }

  function drawPartner(svg, coords) {
    drawAtoms(svg, coords, { role: "partner", group: "partner" });
  }

  // -------------------------------------------------------------------------
  // Render: clean hero (static — never changes).
  // -------------------------------------------------------------------------
  const heroSvg = d3.select('svg[data-panel="hero"]')
    .attr("viewBox", heroVB.join(" "))
    .attr("preserveAspectRatio", "xMidYMid meet");
  installDefs(heroSvg);

  // Hero panel is the *clean* structure — no motif highlight here.
  // The motif marker only shows up in the motif-scaffolding variant.
  drawAtoms(heroSvg, data.hero.coords_3d, { showMotif: false, role: "hero" });

  // -------------------------------------------------------------------------
  // Variant SVGs.
  // -------------------------------------------------------------------------
  const variantSvgs = {
    uncond: d3.select('svg[data-panel="uncond"]')
      .attr("viewBox", variantVB.join(" "))
      .attr("preserveAspectRatio", "xMidYMid meet"),
    motif:  d3.select('svg[data-panel="motif"]')
      .attr("viewBox", variantVB.join(" "))
      .attr("preserveAspectRatio", "xMidYMid meet"),
    binder: d3.select('svg[data-panel="binder"]')
      .attr("viewBox", binderVB.join(" "))
      .attr("preserveAspectRatio", "xMidYMid meet"),
  };
  for (const svg of Object.values(variantSvgs)) installDefs(svg);

  // Pre-render the synthesized partner (static — never noised in binder mode).
  drawPartner(variantSvgs.binder, data.partner.coords_3d);

  // -------------------------------------------------------------------------
  // Re-render variants on τ change.
  // -------------------------------------------------------------------------
  const N = data.n_frames;
  const tauValEl = document.querySelector(".tau-val");
  const sigmaValEl = document.querySelector(".sigma-val");

  function renderAtTau(tau) {
    const frameIdx = Math.max(0, Math.min(N - 1, Math.round(tau * (N - 1))));
    drawAtoms(variantSvgs.uncond, data.variants.uncond.frames[frameIdx],
              { showMotif: false });
    drawAtoms(variantSvgs.motif, data.variants.motif.frames[frameIdx],
              { showMotif: true });
    drawAtoms(variantSvgs.binder, data.variants.binder.frames[frameIdx],
              { showMotif: false, group: "ubq" });

    tauValEl.textContent = tau.toFixed(2);
    sigmaValEl.textContent = data.edm.sigmas[frameIdx].toFixed(2);
  }

  // Initial render.
  renderAtTau(0);

  // -------------------------------------------------------------------------
  // Scroll → τ wiring.
  // The .scrolly section has total height ≈ 100vh (sticky viz) + 280vh
  // (spacer). As the page scrolls through the section, we map the scroll
  // progress onto τ ∈ [0, 1] and re-render.
  // -------------------------------------------------------------------------
  const scrollyEl = document.querySelector(".scrolly");

  function onScroll() {
    const rect = scrollyEl.getBoundingClientRect();
    const scrollable = scrollyEl.offsetHeight - window.innerHeight;
    if (scrollable <= 0) return;
    const progress = Math.max(0, Math.min(1, -rect.top / scrollable));
    renderAtTau(progress);
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
  onScroll();

  // -------------------------------------------------------------------------
  // Fan-out arrows (decorative).
  // -------------------------------------------------------------------------
  drawFanArrows();

  function drawFanArrows() {
    const svg = d3.select(".fan-arrows");
    const w = 920, h = 72;
    svg.attr("viewBox", `0 0 ${w} ${h}`)
      .attr("preserveAspectRatio", "xMidYMid meet");

    // Right-angle dendrogram: a single trunk down from the hero, a
    // horizontal crossbar, then three vertical legs (with arrowheads)
    // down to each variant panel. No diagonal segments.
    const trunkX = w / 2;
    const trunkY1 = 0;
    const crossY = h * 0.50;
    const tipY = h - 4;
    const endXs = [w / 6, w / 2, (5 * w) / 6];
    const colors = ["#4FB9AF", "#D59AB5", "#6686C5"];
    const trunkColor = "#9b9ba6";

    // Trunk (vertical, neutral color).
    svg.append("path")
      .attr("d", `M ${trunkX} ${trunkY1} V ${crossY}`)
      .attr("stroke", trunkColor)
      .attr("stroke-width", 1.4)
      .attr("fill", "none")
      .attr("stroke-linecap", "round")
      .attr("opacity", 0.55);

    // Horizontal crossbar (neutral color).
    svg.append("path")
      .attr("d", `M ${endXs[0]} ${crossY} H ${endXs[endXs.length - 1]}`)
      .attr("stroke", trunkColor)
      .attr("stroke-width", 1.4)
      .attr("fill", "none")
      .attr("stroke-linecap", "round")
      .attr("opacity", 0.55);

    // Three colored vertical legs + arrowheads.
    endXs.forEach((ex, i) => {
      svg.append("path")
        .attr("d", `M ${ex} ${crossY} V ${tipY}`)
        .attr("stroke", colors[i])
        .attr("stroke-width", 1.6)
        .attr("fill", "none")
        .attr("stroke-linecap", "round")
        .attr("opacity", 0.75);
      svg.append("path")
        .attr("d", `M ${ex - 4.5} ${tipY - 5} L ${ex} ${tipY} L ${ex + 4.5} ${tipY - 5}`)
        .attr("stroke", colors[i])
        .attr("stroke-width", 1.6)
        .attr("fill", "none")
        .attr("opacity", 0.75)
        .attr("stroke-linecap", "round")
        .attr("stroke-linejoin", "round");
    });
  }
})().catch(err => {
  console.error(err);
  document.body.insertAdjacentHTML("afterbegin",
    `<pre style="background:#fdd;padding:1em;margin:0;color:#900">${err.message}\n${err.stack}</pre>`);
});
