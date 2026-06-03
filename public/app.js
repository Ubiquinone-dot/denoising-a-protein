/* Denoising-a-Protein explorable — NGL-based renderer.
 *
 * Loads pre-computed forward-noising trajectories (see
 * scripts/noise_ubiquitin.py) and renders them in two scrollable sections:
 *
 *   1. EDM (Karras / RFD3 parameterization): unbounded sigma schedule.
 *      Three variants under different masking conditions.
 *   2. Flow matching: straight-line interpolation between the clean
 *      structure and a fixed-variance noise cloud. Same three masking
 *      conditions, same protein, different generative-model story.
 *
 * Each section is independent: its scroll position drives its own
 * frame index, its own readout, its own three variant panels.
 */

(async function main() {
  const data = await d3.json("data/trajectories.json");
  console.log(
    `loaded ${data.pdb_id}: ${data.n_frames} frames, ` +
    `${data.hero.coords_3d.length} CAs`,
  );

  const N = data.n_frames;
  const heroLen = data.hero.coords_3d.length;

  // Motif residue range -> an NGL selection string.
  const motifResnums = data.hero.motif_resnums;
  const MOTIF_SELE = `${motifResnums[0]}-${motifResnums[motifResnums.length - 1]}`;

  // -------------------------------------------------------------------------
  // Color: N → C residue gradient along the paper palette.
  // -------------------------------------------------------------------------
  const PALETTE = [
    "#FFE0AC", "#FFC6B2", "#FFACB7", "#D59AB5",
    "#9596C6", "#6686C5", "#4B5FAA",
  ];
  const heroColorScale = d3.scaleSequential(d3.interpolateRgbBasis(PALETTE))
    .domain([0, heroLen - 1]);

  function rgbStringToInt(rgb) {
    const m = rgb.match(/\d+/g);
    return (parseInt(m[0]) << 16) | (parseInt(m[1]) << 8) | parseInt(m[2]);
  }

  const heroScheme = NGL.ColormakerRegistry.addScheme(function () {
    this.atomColor = function (atom) {
      if (atom.chainname !== "A") return 0xb6b6c0; // partner = gray
      return rgbStringToInt(heroColorScale(atom.resno - 1));
    };
  });

  // -------------------------------------------------------------------------
  // Build the two PDB skeletons (only structural info matters; coords
  // get overwritten frame by frame for the variant panels).
  // -------------------------------------------------------------------------
  const heroPdb = buildChainPdb(data.hero.coords_3d, "A", 1, 1) + "\nEND\n";
  const binderPdb =
    buildChainPdb(data.hero.coords_3d, "A", 1, 1) + "\n" +
    buildChainPdb(data.partner.coords_3d, "B", 1, heroLen + 1) + "\nEND\n";

  // -------------------------------------------------------------------------
  // Two independent sections. Each has its own hero, three variants, and
  // a scroll-position → frame-index mapping. The hero panel is static; the
  // three variants update on scroll.
  // -------------------------------------------------------------------------
  const edmSection = await setupSection({
    suffix: "",
    scrollySelector: ".scrolly:not(.scrolly-flow)",
    fanArrowsSelector: '.fan-arrows:not([data-which="flow"])',
    variants: data.variants,
    // EDM's Karras schedule blows up to σ ~ 2560 Å at τ = 1. Anything past
    // about frame 32/50 is just an empty panel (atoms scattered miles away),
    // and rendering those frames also OOMs NGL's bond store. Clamp the
    // scrolled τ to the visually useful range.
    maxFrameFraction: 0.65,
    // Two-phase progressive disclosure: the first half of the scroll
    // shows ONLY the unconditional panel noising; the second half reveals
    // the motif and binder panels and noises all three in sync.
    phased: true,
    readout: (tau, frameIdx) => {
      document.querySelector(".tau-val").textContent = tau.toFixed(2);
      document.querySelector(".sigma-val").textContent =
        data.edm.sigmas[frameIdx].toFixed(2);
    },
  });

  const flowSection = await setupSection({
    suffix: "-flow",
    scrollySelector: ".scrolly-flow",
    fanArrowsSelector: '.fan-arrows[data-which="flow"]',
    variants: data.flow_variants,
    // Flow matching's endpoint variance is bounded — full slider range is fine.
    maxFrameFraction: 1.0,
    readout: (tau /*, frameIdx*/) => {
      document.querySelector(".t-val-flow").textContent = tau.toFixed(2);
      // noise σ is constant (FLOW_NOISE_SIGMA), so static — set once below.
    },
  });
  document.querySelector(".sigma-flow-val").textContent =
    data.flow_matching.noise_sigma.toFixed(2);

  // Render once at τ = 0.
  edmSection.update(0);
  flowSection.update(0);

  // -------------------------------------------------------------------------
  // Single scroll handler -> dispatches to every section.
  // -------------------------------------------------------------------------
  function onScroll() {
    edmSection.updateFromScroll();
    flowSection.updateFromScroll();
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
  onScroll();

  // =========================================================================
  // Section setup
  // =========================================================================

  async function setupSection({
    suffix, scrollySelector, fanArrowsSelector, variants, readout,
    maxFrameFraction = 1.0,
    phased = false,
  }) {
    const scrollyEl = document.querySelector(scrollySelector);
    if (!scrollyEl) throw new Error(`no element for ${scrollySelector}`);

    const panels = {
      hero:   await setupPanel(`hero${suffix}`,   heroPdb,   null),
      uncond: await setupPanel(`uncond${suffix}`, heroPdb,   variants.uncond.frames),
      motif:  await setupPanel(`motif${suffix}`,  heroPdb,   variants.motif.frames),
      binder: await setupPanel(`binder${suffix}`, binderPdb, variants.binder.frames),
    };

    drawFanArrows(d3.select(fanArrowsSelector));

    const maxFrame = Math.floor((N - 1) * maxFrameFraction);

    // Progressive-disclosure DOM refs (.variant containers for the side
    // panels, plus the section's fan-arrows SVG). When `phased` is on,
    // these collapse in phase 1 and reveal in phase 2.
    const sideContainers = phased ? [
      scrollyEl.querySelector(`[data-variant="motif${suffix}"]`),
      scrollyEl.querySelector(`[data-variant="binder${suffix}"]`),
    ].filter(Boolean) : [];
    const fanArrowsEl = phased ? scrollyEl.querySelector(".fan-arrows") : null;

    // Initial state: side panels collapsed, dendrogram hidden.
    if (phased) {
      sideContainers.forEach(el => el.classList.add("collapsed"));
      fanArrowsEl?.classList.add("collapsed");
    }

    // Threshold below which we're in phase 1 (uncond only).
    const PHASE_THRESHOLD = 0.5;

    function frameAt(t) {
      return Math.max(0, Math.min(maxFrame, Math.round(t * maxFrame)));
    }

    function update(tau) {
      if (!phased) {
        const frameIdx = frameAt(tau);
        panels.uncond.setFrame(frameIdx);
        panels.motif.setFrame(frameIdx);
        panels.binder.setFrame(frameIdx);
        readout(tau, frameIdx);
        return;
      }

      // Two-phase: split the scroll range in half.
      if (tau < PHASE_THRESHOLD) {
        // Phase 1: uncond noises 0 -> 1 alone. Side panels stay clean
        // (frame 0) underneath their fade-out so they're ready to appear.
        const phaseTau = tau / PHASE_THRESHOLD;
        const frameIdx = frameAt(phaseTau);
        panels.uncond.setFrame(frameIdx);
        panels.motif.setFrame(0);
        panels.binder.setFrame(0);
        sideContainers.forEach(el => el.classList.add("collapsed"));
        fanArrowsEl?.classList.add("collapsed");
        readout(phaseTau, frameIdx);
      } else {
        // Phase 2: all three reveal and noise 0 -> 1 in sync. The
        // uncond panel resets to clean at the phase transition — a small
        // jump that reads as a deliberate beat ("now let's see all
        // three together") rather than a glitch.
        const phaseTau = (tau - PHASE_THRESHOLD) / (1 - PHASE_THRESHOLD);
        const frameIdx = frameAt(phaseTau);
        panels.uncond.setFrame(frameIdx);
        panels.motif.setFrame(frameIdx);
        panels.binder.setFrame(frameIdx);
        sideContainers.forEach(el => el.classList.remove("collapsed"));
        fanArrowsEl?.classList.remove("collapsed");
        readout(phaseTau, frameIdx);
      }
    }

    function updateFromScroll() {
      const rect = scrollyEl.getBoundingClientRect();
      const scrollable = scrollyEl.offsetHeight - window.innerHeight;
      if (scrollable <= 0) return;
      const tau = Math.max(0, Math.min(1, -rect.top / scrollable));
      update(tau);
    }

    return { panels, update, updateFromScroll };
  }

  // -------------------------------------------------------------------------
  // Single-panel setup. `framesArray` is null for static (hero) panels;
  // otherwise it's an array of n_frames × n_atoms × 3 arrays.
  // -------------------------------------------------------------------------
  async function setupPanel(panelDataAttr, pdbString, framesArray) {
    const el = document.querySelector(`[data-panel="${panelDataAttr}"]`);
    if (!el) throw new Error(`no [data-panel="${panelDataAttr}"]`);

    const stage = new NGL.Stage(el, {
      backgroundColor: "white",
      quality: "high",
      sampleLevel: 1,
    });
    // No user-driven camera — viz is fully scroll-controlled.
    stage.viewer.renderer.domElement.style.pointerEvents = "none";

    const blob = new Blob([pdbString], { type: "text/plain" });
    const component = await stage.loadFile(blob, {
      ext: "pdb",
      defaultRepresentation: false,
    });

    // Main cartoon ribbon (chain A, N→C palette gradient).
    component.addRepresentation("cartoon", {
      sele: ":A",
      colorScheme: heroScheme,
      smoothSheet: true,
      subdiv: 6,
      capped: true,
      aspectRatio: 4,
      radius: 0.55,
    });

    // Motif overlay (motif panels only — keyed off the panel id ending).
    if (panelDataAttr.startsWith("motif")) {
      component.addRepresentation("cartoon", {
        sele: `:A and ${MOTIF_SELE}`,
        color: 0x08415C,
        smoothSheet: true,
        subdiv: 6,
        capped: true,
        aspectRatio: 4,
        radius: 0.7,
      });
    }

    // Partner cartoon (binder panels only — chain B exists in the PDB).
    if (panelDataAttr.startsWith("binder")) {
      component.addRepresentation("cartoon", {
        sele: ":B",
        color: 0xa9a9b8,
        smoothSheet: true,
        subdiv: 6,
        capped: true,
        aspectRatio: 4,
        radius: 0.55,
      });
    }

    component.autoView(0);

    // Per-scroll frame update: write straight into the structure's
    // atomStore (Float32Array) and trigger a single re-render.
    //
    // NOTE: we deliberately skip structure.refreshPosition() — it rebuilds
    // the bond store / spatial hash from the new coords, and at EDM's
    // extreme-σ frames (σ ~ 2500 Å) the bond store tries to allocate a
    // multi-gigabyte buffer and throws RangeError. updateRepresentations
    // is enough to re-derive the cartoon mesh from the new atomStore.
    let setFrame = () => {};
    if (framesArray) {
      const atomStore = component.structure.atomStore;
      setFrame = (idx) => {
        const frame = framesArray[idx];
        for (let i = 0; i < heroLen; i++) {
          atomStore.x[i] = frame[i][0];
          atomStore.y[i] = frame[i][1];
          atomStore.z[i] = frame[i][2];
        }
        component.updateRepresentations({ position: true });
      };
    }

    return { stage, component, setFrame };
  }

  // =========================================================================
  // PDB ATOM line formatter
  // =========================================================================

  function buildChainPdb(coords3d, chainId, startResnum, startSerial) {
    const lines = [];
    for (let i = 0; i < coords3d.length; i++) {
      const xyz = coords3d[i];
      lines.push(fmtPdbAtom(
        startSerial + i, "CA", "ALA", chainId,
        startResnum + i, xyz[0], xyz[1], xyz[2],
      ));
    }
    return lines.join("\n");
  }

  function fmtPdbAtom(serial, atomName, resName, chainId, resseq, x, y, z) {
    const cols = new Array(80).fill(" ");
    const set = (start, end, str) => {
      for (let i = 0; i < end - start + 1 && i < str.length; i++) {
        cols[start - 1 + i] = str[i];
      }
    };
    set(1, 4, "ATOM");
    set(7, 11, String(serial).padStart(5));
    set(13, 16, (" " + atomName).padEnd(4));
    set(18, 20, resName.padEnd(3));
    set(22, 22, chainId);
    set(23, 26, String(resseq).padStart(4));
    set(31, 38, x.toFixed(3).padStart(8));
    set(39, 46, y.toFixed(3).padStart(8));
    set(47, 54, z.toFixed(3).padStart(8));
    set(55, 60, "  1.00");
    set(61, 66, "  0.00");
    set(77, 78, " C");
    return cols.join("");
  }

  // =========================================================================
  // Right-angle dendrogram fan-out arrows (one per section).
  // =========================================================================

  function drawFanArrows(svg) {
    if (svg.empty()) return;
    const w = 920, h = 72;
    svg.attr("viewBox", `0 0 ${w} ${h}`)
      .attr("preserveAspectRatio", "xMidYMid meet");

    const trunkX = w / 2;
    const crossY = h * 0.50;
    const tipY = h - 4;
    const endXs = [w / 6, w / 2, (5 * w) / 6];
    // Columns are motif / uncond / binder → amaranth / teal / blue
    const colors = ["#D59AB5", "#4FB9AF", "#6686C5"];
    const trunkColor = "#9b9ba6";

    svg.append("path")
      .attr("d", `M ${trunkX} 0 V ${crossY}`)
      .attr("stroke", trunkColor).attr("stroke-width", 1.4)
      .attr("fill", "none").attr("stroke-linecap", "round")
      .attr("opacity", 0.55);

    svg.append("path")
      .attr("d", `M ${endXs[0]} ${crossY} H ${endXs[endXs.length - 1]}`)
      .attr("stroke", trunkColor).attr("stroke-width", 1.4)
      .attr("fill", "none").attr("stroke-linecap", "round")
      .attr("opacity", 0.55);

    endXs.forEach((ex, i) => {
      svg.append("path")
        .attr("d", `M ${ex} ${crossY} V ${tipY}`)
        .attr("stroke", colors[i]).attr("stroke-width", 1.6)
        .attr("fill", "none").attr("stroke-linecap", "round")
        .attr("opacity", 0.75);
      svg.append("path")
        .attr("d", `M ${ex - 4.5} ${tipY - 5} L ${ex} ${tipY} L ${ex + 4.5} ${tipY - 5}`)
        .attr("stroke", colors[i]).attr("stroke-width", 1.6)
        .attr("fill", "none").attr("opacity", 0.75)
        .attr("stroke-linecap", "round").attr("stroke-linejoin", "round");
    });
  }
})().catch(err => {
  console.error(err);
  document.body.insertAdjacentHTML("afterbegin",
    `<pre style="background:#fdd;padding:1em;margin:0;color:#900">${err.message}\n${err.stack}</pre>`);
});

/* =========================================================================
 * Latent Atlas: t-SNE of equivariant-AE latents + decoded-residue viewer.
 *
 * Loads public/data/latent_atlas.json (produced by the offline pipeline:
 * scripts/precompute_latent_atlas.py for real model output, or
 * scripts/synth_latent_atlas.py for local synthetic dev data).
 *
 * Each point in the t-SNE is one real residue from the val set; hovering a
 * point loads its decoded heavy atoms into a small NGL ball-and-stick
 * viewer to the right. Every reconstruction shares the same canonical
 * N/CA/C/O backbone frame (precomputed offline), so the camera stays put
 * and only the side chain morphs as you sweep around the latent space.
 *
 * Layout note for future Modal endpoint: the per-point `latent` vector is
 * preserved in the JSON so this same viewer can later re-decode latents on
 * the fly by POSTing them to a hosted decoder (or by extrapolating between
 * neighbouring points), without restructuring the frontend.
 * ========================================================================= */
(async function latentAtlas() {
  const svgEl = document.querySelector(".tsne-svg");
  const viewerEl = document.querySelector('[data-panel="residue"]');
  if (!svgEl || !viewerEl) return;

  let atlas;
  try {
    atlas = await d3.json("data/latent_atlas.json");
  } catch (err) {
    console.warn("latent_atlas.json not available; skipping atlas section.", err);
    return;
  }
  console.log(
    `latent atlas: ${atlas.points.length} points, latent_dim=${atlas.meta.latent_dim}, ` +
    `encoder=${atlas.meta.encoder}`,
  );

  // -------------------------------------------------------------------------
  // Setup: D3 scales + color lookup keyed by residue-type id.
  // -------------------------------------------------------------------------
  const points = atlas.points;
  const labelFor = (rt) => atlas.restype_labels[rt] || `RT${rt}`;

  // ---- Paper-colours palette (matches CLAUDE.md). Used by the
  //      hydrophobicity + heavy-atom-count schemes. ----
  const PAPER = {
    teal:     "#4FB9AF",
    navaho:   "#FFE0AC",
    melon:    "#FFC6B2",
    pink:     "#FFACB7",
    amaranth: "#D59AB5",
    coolgrey: "#9596C6",
    blue:     "#6686C5",
    darkblue: "#4B5FAA",
    indigo:   "#08415C",
  };
  // Ordered gradient (from CLAUDE.md): navaho → melon → pink → amaranth →
  // coolgrey → blue → darkblue. Used by the heavy-atom-count scheme.
  const PAPER_RAMP = [PAPER.navaho, PAPER.melon, PAPER.pink, PAPER.amaranth,
                      PAPER.coolgrey, PAPER.blue, PAPER.darkblue];

  // ---- Standard 20-element categorical palette, one slot per canonical AA.
  //      This is matplotlib's `tab20` (= D3 schemeCategory20, = vega tab20),
  //      the de-facto 20-colour categorical palette in scientific viz. It
  //      pairs ten hues × {saturated, soft} so every adjacent pair shares a
  //      hue family — half the swatches still read as pastel, but every
  //      slot is distinguishable from every other slot (no three-way pink
  //      collision like the ColorBrewer Set3+Pastel1 stack had).
  //
  //      Ordering follows the 1-indexed `restype_labels` from the atlas
  //      JSON: ALA, ARG, ASN, ASP, CYS, GLN, GLU, GLY, HIS, ILE, LEU, LYS,
  //      MET, PHE, PRO, SER, THR, TRP, TYR, VAL. We interleave the
  //      saturated and soft halves across the pair to maximise visual
  //      contrast between neighbouring AAs in the legend.
  const AA_PALETTE_20 = [
    "#1f77b4", // ALA  blue
    "#aec7e8", // ARG  light blue
    "#ff7f0e", // ASN  orange
    "#ffbb78", // ASP  light orange
    "#2ca02c", // CYS  green
    "#98df8a", // GLN  light green
    "#d62728", // GLU  red
    "#ff9896", // GLY  light red / pink
    "#9467bd", // HIS  purple
    "#c5b0d1", // ILE  light purple
    "#8c564b", // LEU  brown
    "#c49c94", // LYS  light brown
    "#e377c2", // MET  magenta
    "#f7b6d2", // PHE  light magenta
    "#7f7f7f", // PRO  grey
    "#c7c7c7", // SER  light grey
    "#bcbd22", // THR  olive
    "#dbdb8d", // TRP  light olive
    "#17becf", // TYR  cyan
    "#9edae5", // VAL  light cyan
  ];
  // Convert restype id (1-indexed; 0 = MSK) → AA palette colour. Falls back
  // to the atlas-supplied colour for any id outside 1..20 (e.g. MSK / UNK).
  function aaColor(rt) {
    if (rt >= 1 && rt <= 20) return AA_PALETTE_20[rt - 1];
    return atlas.restype_colors[rt] || "#888";
  }

  // ---- Hydrophobicity buckets (Kyte-Doolittle-ish, simplified). ----
  // Hydrophobic: ALA VAL LEU ILE PHE MET TRP PRO CYS
  // Polar (uncharged): SER THR ASN GLN TYR GLY HIS
  // Basic (+):   LYS ARG
  // Acidic (-):  ASP GLU
  // residue_type id → bucket name.
  const HYDRO_BUCKETS = {
    1: "hydrophobic", 5: "hydrophobic", 10: "hydrophobic", 11: "hydrophobic",
    13: "hydrophobic", 14: "hydrophobic", 15: "hydrophobic", 18: "hydrophobic",
    20: "hydrophobic",
    3: "polar", 6: "polar", 8: "polar", 9: "polar", 16: "polar", 17: "polar",
    19: "polar",
    2: "basic", 12: "basic",
    4: "acidic", 7: "acidic",
  };
  const HYDRO_COLORS = {
    hydrophobic: PAPER.navaho,
    polar:       PAPER.teal,
    acidic:      PAPER.pink,
    basic:       PAPER.blue,
  };
  const HYDRO_LABELS = ["hydrophobic", "polar", "acidic", "basic"];

  // ---- Heavy-atom-count scheme — one color per residue per its number
  //      of heavy atoms (from the decoded structure). ----
  const ATOM_COUNTS = points.map((p) => p.atoms.length);
  const ATOM_MIN = d3.min(ATOM_COUNTS);
  const ATOM_MAX = d3.max(ATOM_COUNTS);
  const atomRamp = d3.scaleSequential(d3.interpolateRgbBasis(PAPER_RAMP))
    .domain([ATOM_MIN, ATOM_MAX]);

  // ---- Active colour scheme — switched by the three buttons up top. ----
  let scheme = "aa";
  function colorForPoint(p) {
    if (scheme === "aa") return aaColor(p.gt_restype);
    if (scheme === "hydro") {
      const b = HYDRO_BUCKETS[p.gt_restype];
      return HYDRO_COLORS[b] || "#888";
    }
    return atomRamp(p.atoms.length);   // "atoms"
  }
  function colorForRt(rt) { return aaColor(rt); }

  const padding = 16;
  // Use SVG bounding box for scale ranges — responsive without re-layout.
  function rangeFor(svg) {
    const r = svg.getBoundingClientRect();
    return { w: r.width || 540, h: r.height || 420 };
  }
  const svg = d3.select(svgEl);
  const { w, h } = rangeFor(svgEl);
  svg.attr("viewBox", `0 0 ${w} ${h}`).attr("preserveAspectRatio", "xMidYMid meet");

  const xs = points.map((p) => p.tsne[0]);
  const ys = points.map((p) => p.tsne[1]);
  const xScale = d3.scaleLinear()
    .domain([d3.min(xs), d3.max(xs)]).nice()
    .range([padding, w - padding]);
  const yScale = d3.scaleLinear()
    .domain([d3.min(ys), d3.max(ys)]).nice()
    .range([h - padding, padding]);

  // -------------------------------------------------------------------------
  // Scatter.
  // -------------------------------------------------------------------------
  const dotGroup = svg.append("g").attr("class", "dots");
  const circles = dotGroup.selectAll("circle.pt")
    .data(points)
    .join("circle")
      .attr("class", "pt")
      .attr("cx", (d) => xScale(d.tsne[0]))
      .attr("cy", (d) => yScale(d.tsne[1]))
      .attr("r", 3.6)
      .attr("fill", (d) => colorForPoint(d))
      .attr("fill-opacity", 0.8)
      .attr("stroke", "rgba(0,0,0,0.18)")
      .attr("stroke-width", 0.5);

  // -------------------------------------------------------------------------
  // Legend — re-rendered when the scheme switches. For the AA scheme we
  // show one chip per AA, click to filter. For hydrophobicity we show 4
  // bucket chips (also filterable). For heavy-atoms we show a gradient bar
  // with min / max counts (no filter — would be arbitrary).
  // -------------------------------------------------------------------------
  const legendEl = document.querySelector(".latent-legend");
  const presentRts = Array.from(new Set(points.map((p) => p.gt_restype))).sort((a, b) => a - b);
  // ``activeFilter`` semantics:
  //   AA scheme    → restype id (1..20) or null
  //   hydro scheme → bucket name (e.g. "polar") or null
  //   atoms scheme → null always (no filter)
  let activeFilter = null;

  function rebuildLegend() {
    legendEl.innerHTML = "";
    legendEl.className = "latent-legend";

    if (scheme === "atoms") {
      // Gradient bar — no clickable filter, just min / max labels.
      const grad = document.createElement("div");
      grad.className = "legend-gradient";
      const bar = document.createElement("div");
      bar.className = "legend-gradient-bar";
      const stops = PAPER_RAMP.map((c, i) => `${c} ${(i / (PAPER_RAMP.length - 1) * 100).toFixed(0)}%`).join(", ");
      bar.style.background = `linear-gradient(to right, ${stops})`;
      const labels = document.createElement("div");
      labels.className = "legend-gradient-labels";
      labels.innerHTML = `<span>${ATOM_MIN} heavy atoms</span><span>${ATOM_MAX}</span>`;
      grad.appendChild(bar);
      grad.appendChild(labels);
      legendEl.appendChild(grad);
      activeFilter = null;
      circles.classed("dim", false);
      return;
    }

    const items = scheme === "hydro"
      ? HYDRO_LABELS.map((name) => ({ key: name, label: name, color: HYDRO_COLORS[name] }))
      : presentRts.map((rt) => ({ key: rt, label: labelFor(rt), color: colorForRt(rt) }));

    items.forEach((item) => {
      const chip = document.createElement("span");
      chip.className = "legend-chip";
      chip.innerHTML =
        `<span class="legend-dot" style="background:${item.color}"></span>` +
        `<span>${item.label}</span>`;
      chip.addEventListener("click", () => {
        activeFilter = activeFilter === item.key ? null : item.key;
        legendEl.querySelectorAll(".legend-chip").forEach((el) => el.classList.remove("active"));
        if (activeFilter !== null) chip.classList.add("active");
        applyFilterDim();
      });
      if (activeFilter === item.key) chip.classList.add("active");
      legendEl.appendChild(chip);
    });
  }

  function applyFilterDim() {
    if (activeFilter === null) { circles.classed("dim", false); return; }
    if (scheme === "aa") {
      circles.classed("dim", (d) => d.gt_restype !== activeFilter);
    } else if (scheme === "hydro") {
      circles.classed("dim", (d) => HYDRO_BUCKETS[d.gt_restype] !== activeFilter);
    } else {
      circles.classed("dim", false);
    }
  }

  function applyScheme(newScheme) {
    if (newScheme === scheme) return;
    scheme = newScheme;
    activeFilter = null;
    document.querySelectorAll(".scheme-btn").forEach((b) =>
      b.classList.toggle("active", b.dataset.scheme === scheme));
    circles.attr("fill", (d) => colorForPoint(d));
    rebuildLegend();
    applyFilterDim();
    // Re-render the chi panel so its dot colors track the scheme.
    if (lastRenderedPoint) renderChiPanel(lastRenderedPoint);
  }

  document.querySelectorAll(".scheme-btn").forEach((btn) =>
    btn.addEventListener("click", () => applyScheme(btn.dataset.scheme)));
  rebuildLegend();

  // -------------------------------------------------------------------------
  // NGL viewer for the decoded residue. The camera is locked once on the
  // shared canonical CA position so the residue doesn't jump between hovers
  // — only the atoms move. The user can still drag to rotate / scroll to
  // zoom; that rotation persists across residue swaps because we restore
  // the saved camera orientation after each load instead of running
  // autoView again.
  // -------------------------------------------------------------------------
  const stage = new NGL.Stage(viewerEl, {
    backgroundColor: "#fafaf7",
    quality: "high",
    cameraType: "perspective",
    sampleLevel: 2,
  });
  // NOTE: pointerEvents are now ENABLED (no `pointer-events: none` override)
  // so the user can rotate / pan / zoom the residue.

  let currentComponent = null;
  let renderToken = 0;
  let savedOrientation = null;  // NGL viewer Matrix4 (camera position+target+zoom)
  let pinnedIdx = null;         // index of click-pinned point; null = follow hover
  let lastRenderedPoint = null; // point currently shown in the viewer / readout

  // Color by atom element — backbone in a soft palette, sidechain in the
  // dot's residue color so hovered identity reads at a glance.
  function makeResidueScheme(residueColor) {
    return NGL.ColormakerRegistry.addScheme(function () {
      const bbColor = 0xb5b5c3;
      const sideHex = residueColor.replace("#", "");
      const side = parseInt(sideHex, 16);
      this.atomColor = function (atom) {
        const n = atom.atomname;
        if (n === "N" || n === "CA" || n === "C" || n === "O") return bbColor;
        return side;
      };
    });
  }

  function residuePdb(atoms, resName) {
    // af2 atom names map directly to PDB ATOM records.
    return atoms.map((atom, i) =>
      fmtPdbAtomLocal(i + 1, atom.name, resName, "A", 1,
        atom.xyz[0], atom.xyz[1], atom.xyz[2])
    ).join("\n") + "\nEND\n";
  }

  async function renderResidue(point) {
    const token = ++renderToken;
    const pdb = residuePdb(point.atoms, labelFor(point.pred_restype));
    const blob = new Blob([pdb], { type: "text/plain" });
    const component = await stage.loadFile(blob, { ext: "pdb", defaultRepresentation: false });
    if (token !== renderToken) {
      // A newer hover already started — discard this load.
      stage.removeComponent(component);
      return;
    }
    if (currentComponent) stage.removeComponent(currentComponent);
    currentComponent = component;

    const nglScheme = makeResidueScheme(colorForPoint(point));
    component.addRepresentation("ball+stick", {
      sele: "all",
      colorScheme: nglScheme,
      radiusScale: 0.55,
      bondScale: 0.55,
      multipleBond: "symmetric",
      aspectRatio: 1.6,
    });

    // Camera handling: lock once on the canonical CA at origin with a fixed
    // wide zoom (sized for the biggest residue, TRP) so every subsequent
    // swap keeps the camera *exactly* where it was — only atoms move.
    //
    // We seed the orientation off a synthetic axis-aligned bounding box that
    // covers the worst-case sidechain reach (~7 Å in any direction). That
    // way the first real residue doesn't drive the zoom level — TRP's
    // 6 Å indole fits and ALA's lone CB sits at the center of a comfortably
    // sized panel. Subsequent loads call `orient()` to restore.
    if (savedOrientation === null) {
      // Build a phantom 8-atom bounding-box residue, autoView on it, save
      // orientation, remove it. The user never sees this frame.
      // ~3.4 Å reach in each direction → 6.8 Å cube. TRP (the largest residue)
      // has a ~7.6 × 5.3 Å bbox from CA, so this lets it almost fill the panel
      // (a hair of its indole edges may sit at the viewport border) while
      // smaller AAs feel comfortably zoomed in instead of lonely. The size
      // difference between residues stays informative — that's the
      // side-chain story.
      const REACH = 3.4;
      const bboxAtoms = [];
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        bboxAtoms.push({ name: "C", xyz: [sx * REACH, sy * REACH, sz * REACH] });
      }
      const bboxPdb = residuePdb(bboxAtoms, "BOX");
      const bboxBlob = new Blob([bboxPdb], { type: "text/plain" });
      const bboxComp = await stage.loadFile(bboxBlob, { ext: "pdb", defaultRepresentation: false });
      bboxComp.addRepresentation("point", { sele: "all", radius: 0.01 });
      bboxComp.autoView();  // instant snap — animated autoView(N) reads
                            // orientation mid-animation and saves the wrong frame.
      // Tilt off-axis. autoView lands on a canonical axis-aligned view
      // (camera at +z looking toward −z), which leaves C and O sitting
      // almost directly behind CA in our canonical GLU65 backbone frame —
      // not a useful base orientation for showing the backbone.
      //
      // We swing the camera ≈ +Hα instead. For an L-amino acid with this
      // backbone, the implicit Cα-Hα bond points at roughly (+0.98, −0.01,
      // +0.21) — derived from tetrahedral geometry around CA given N at
      // (−0.60, +1.23, +0.52) and C at (−0.20, −0.13, −1.51). Looking
      // down that axis is the classic biochem-textbook view: N upper-left,
      // CA centre, C lower-right, O further lower-right, side chain
      // pointing slightly into the page. All four backbone atoms read at
      // a glance.
      //
      // 70° yaw around y gets the camera most of the way there. The
      // small +pitch and +roll deliberately *don't* land cleanly on +Hα —
      // a few degrees of jitter keep aromatic ring planes oblique to the
      // camera (so TRP / PHE / TYR / HIS still show their depth) and
      // stop the backbone from reading as a flat schematic.
      stage.viewerControls.rotate(new NGL.Vector3(0, 1, 0), (Math.PI * 70) / 180);
      stage.viewerControls.rotate(new NGL.Vector3(1, 0, 0), (Math.PI * 12) / 180);
      stage.viewerControls.rotate(new NGL.Vector3(0, 0, 1), (Math.PI *  6) / 180);
      // Tiny extra pull-back so the residue doesn't hug the panel edges.
      stage.viewerControls.zoom(0.06);
      savedOrientation = stage.viewerControls.getOrientation();
      stage.removeComponent(bboxComp);
      stage.viewerControls.orient(savedOrientation);
    } else {
      stage.viewerControls.orient(savedOrientation);
    }

    // Update the readout panel. Decoder argmax is correct ~100% of the
    // time, so we just show one identity label / swatch (the AA scheme
    // color of that residue).
    document.querySelector(".residue-pred-swatch").style.background = colorForPoint(point);
    document.querySelector(".residue-pred-name").textContent = labelFor(point.pred_restype);
    const nSide = Math.max(0, point.atoms.length - 4);
    document.querySelector(".residue-atom-count").textContent =
      `${point.atoms.length} total · ${nSide} side-chain`;

    lastRenderedPoint = point;

    // Refresh the chi-space panel for this point's AA, with the active dot.
    renderChiPanel(point);

    // Cross-sync: also light up the matching t-SNE dot. Skip if a pin is
    // active — the pin handler maintains its own highlight separately.
    if (pinnedIdx === null) {
      circles.classed("active", false).attr("r", 3.6);
      circles.filter((d) => d === point).classed("active", true).attr("r", 5.4);
    }
  }

  // -------------------------------------------------------------------------
  // Chi-space distribution. For the currently active residue's AA we show
  // either:
  //   * a 2-D χ₁ × χ₂ scatter (most AAs — same convention as Lovell /
  //     Dunbrack rotamer libraries),
  //   * a 1-D wrapped strip of χ₁ for AAs with only one defined dihedral,
  //   * or a "no χ angles" placeholder for GLY / ALA.
  // The currently hovered/pinned residue's dot gets the same indigo halo
  // we use on the t-SNE so you can see exactly which rotamer well it
  // landed in within its AA's distribution.
  // -------------------------------------------------------------------------
  const chiSvg = d3.select(".chi-svg");
  // Pre-bucket points by AA so chi rendering is O(per-AA) per hover, not O(N).
  const pointsByAa = new Map();
  for (const p of points) {
    const aa = p.gt_restype;
    if (!pointsByAa.has(aa)) pointsByAa.set(aa, []);
    pointsByAa.get(aa).push(p);
  }

  function chiCount(point) {
    if (!point.chi_deg) return 0;
    let n = 0;
    for (const v of point.chi_deg) if (v !== null && v !== undefined) n++;
    return n;
  }

  // -------------------------------------------------------------------------
  // Shared click handler — the chi panel + t-SNE both call this so their
  // pin / unpin behaviour stays in lock-step. Returns the new pinned state.
  // -------------------------------------------------------------------------
  function togglePinAt(point) {
    const idx = points.indexOf(point);
    if (pinnedIdx === idx) {
      pinnedIdx = null;
      circles.classed("pinned", false);
      chiSvg.selectAll("circle.pt.pinned").classed("pinned", false);
      return false;
    }
    pinnedIdx = idx;
    circles.classed("pinned", false).classed("active", false).attr("r", 3.6);
    circles.filter((d) => d === point)
      .classed("pinned", true).classed("active", true).attr("r", 6.2);
    chiSvg.selectAll("circle.pt").classed("pinned", false);
    chiSvg.selectAll("circle.pt").filter((d) => d === point)
      .classed("pinned", true).classed("active", true).attr("r", 6.2);
    renderResidue(point);
    return true;
  }

  function renderChiPanel(activePoint) {
    chiSvg.selectAll("*").remove();
    const aaId = activePoint.gt_restype;
    const aaPts = pointsByAa.get(aaId) || [];
    const aaName = labelFor(aaId);
    document.querySelector(".chi-aa-name").textContent = `· ${aaName}`;

    // Populate the χ readout cells with the active point's values.
    const chi = activePoint.chi_deg || [null, null, null, null];
    [1, 2, 3, 4].forEach((k, idx) => {
      const v = chi[idx];
      const cell = document.querySelector(`.chi${k}-val`).closest(".chi-cell");
      const el   = document.querySelector(`.chi${k}-val`);
      if (v === null || v === undefined) {
        el.textContent = "—";
        cell.classList.add("unset");
      } else {
        el.textContent = `${v >= 0 ? "+" : ""}${v.toFixed(0)}°`;
        cell.classList.remove("unset");
      }
    });

    // SVG geometry — driven by computed size so it stays responsive.
    const box = chiSvg.node().getBoundingClientRect();
    const W = box.width || 240, H = box.height || 240;
    chiSvg.attr("viewBox", `0 0 ${W} ${H}`).attr("preserveAspectRatio", "xMidYMid meet");

    const maxNchi = Math.max(0, ...aaPts.map(chiCount));
    if (maxNchi === 0) {
      chiSvg.append("text").attr("class", "nodata")
        .attr("x", W / 2).attr("y", H / 2)
        .text(`${aaName} has no χ angles`);
      return;
    }

    if (maxNchi === 1) {
      // 1-D: lay chi₁ along a horizontal axis from -180 to +180.
      const pad = 22;
      const x = d3.scaleLinear().domain([-180, 180]).range([pad, W - pad]);
      const y = H / 2;
      // Background ticks at ±180, ±60, 0.
      const ticks = [-180, -120, -60, 0, 60, 120, 180];
      const grid = chiSvg.append("g").attr("class", "well-grid");
      ticks.forEach((t) => grid.append("line")
        .attr("x1", x(t)).attr("x2", x(t)).attr("y1", y - 28).attr("y2", y + 28));
      const axis = chiSvg.append("g").attr("class", "axis");
      axis.append("line").attr("x1", pad).attr("x2", W - pad).attr("y1", y + 32).attr("y2", y + 32);
      [-180, -60, 60, 180].forEach((t) => axis.append("text")
        .attr("x", x(t)).attr("y", y + 44).attr("text-anchor", "middle").text(`${t}°`));
      axis.append("text")
        .attr("x", W / 2).attr("y", H - 4).attr("text-anchor", "middle").text("χ₁");
      // All AA's chi₁ as small dots; active one larger + haloed.
      const dots = chiSvg.append("g").selectAll("circle.pt").data(aaPts).join("circle")
        .attr("class", "pt")
        .attr("cx", (d) => x(d.chi_deg[0]))
        .attr("cy", y - 1)
        .attr("r", 3.0).attr("fill", (d) => colorForPoint(d)).attr("fill-opacity", 0.6)
        .attr("stroke", "rgba(0,0,0,0.18)").attr("stroke-width", 0.5);
      dots.filter((d) => d === activePoint).attr("class", "pt active").attr("r", 5.2);
      if (pinnedIdx !== null && points[pinnedIdx])
        dots.filter((d) => d === points[pinnedIdx]).classed("pinned", true);
      attachChiHandlers(dots, /* restR= */ 3.0, /* hoverR= */ 5.2);
      return;
    }

    // 2-D χ₁ × χ₂ scatter. Even AAs with χ₃ / χ₄ get this view —
    // the extra dimensions are summarised in the readout cells below.
    const pad = 24;
    const xs = d3.scaleLinear().domain([-180, 180]).range([pad, W - pad]);
    const ys = d3.scaleLinear().domain([-180, 180]).range([H - pad, pad]);

    // Grid at rotamer-well centres (±60°, ±180°), plus 0°.
    const grid = chiSvg.append("g").attr("class", "well-grid");
    const ticks = [-180, -120, -60, 0, 60, 120, 180];
    ticks.forEach((t) => {
      grid.append("line").attr("x1", xs(t)).attr("x2", xs(t)).attr("y1", pad).attr("y2", H - pad);
      grid.append("line").attr("x1", pad).attr("x2", W - pad).attr("y1", ys(t)).attr("y2", ys(t));
    });

    // Axes (a thin border + tick labels at extremes & 0°).
    const axis = chiSvg.append("g").attr("class", "axis");
    axis.append("line").attr("x1", pad).attr("x2", W - pad).attr("y1", H - pad).attr("y2", H - pad);
    axis.append("line").attr("x1", pad).attr("x2", pad).attr("y1", pad).attr("y2", H - pad);
    [-180, 0, 180].forEach((t) => {
      axis.append("text").attr("x", xs(t)).attr("y", H - pad + 11)
        .attr("text-anchor", "middle").text(`${t}`);
      axis.append("text").attr("x", pad - 4).attr("y", ys(t) + 3)
        .attr("text-anchor", "end").text(`${t}`);
    });
    axis.append("text").attr("x", W - 2).attr("y", H - pad + 11)
      .attr("text-anchor", "end").attr("fill", "var(--muted)").text("χ₁");
    axis.append("text").attr("x", 4).attr("y", pad - 4)
      .attr("text-anchor", "start").attr("fill", "var(--muted)").text("χ₂");

    // Dots for each AA member; active dot highlighted.
    const dots = chiSvg.append("g").selectAll("circle.pt")
      .data(aaPts.filter((d) => chiCount(d) >= 2))
      .join("circle")
        .attr("class", "pt")
        .attr("cx", (d) => xs(d.chi_deg[0]))
        .attr("cy", (d) => ys(d.chi_deg[1]))
        .attr("r", 2.8).attr("fill", (d) => colorForPoint(d)).attr("fill-opacity", 0.55)
        .attr("stroke", "rgba(0,0,0,0.15)").attr("stroke-width", 0.4);
    dots.filter((d) => d === activePoint).attr("class", "pt active").attr("r", 5.0);
    if (pinnedIdx !== null && points[pinnedIdx])
      dots.filter((d) => d === points[pinnedIdx]).classed("pinned", true);
    attachChiHandlers(dots, /* restR= */ 2.8, /* hoverR= */ 5.0);
  }

  // Hover / click handlers for chi-panel dots. Behaviour mirrors the
  // t-SNE dots: mouse over → enlarge + queue a render of that residue;
  // click → pin (and unpin the previous); leave → back to small unless
  // it's the pinned point. ``stopPropagation`` keeps the click from
  // bubbling to the chi-svg background unpin handler below.
  function attachChiHandlers(sel, restR, hoverR) {
    sel
      .style("cursor", "pointer")
      .on("mouseenter", function (_evt, d) {
        if (pinnedIdx !== null) return;
        chiSvg.selectAll("circle.pt").classed("active", false).attr("r", restR);
        d3.select(this).classed("active", true).attr("r", hoverR);
        scheduleRender(d);
      })
      .on("mouseleave", function (_evt, d) {
        if (pinnedIdx !== null) return;
        if (d3.select(this).classed("pinned")) return;
        d3.select(this).classed("active", false).attr("r", restR);
      })
      .on("click", function (evt, d) {
        evt.stopPropagation();
        togglePinAt(d);
      });
  }

  // -------------------------------------------------------------------------
  // Wire hover + click. Throttle hover-driven renders to ~80 ms so a fast
  // mouse-sweep doesn't queue dozens of NGL loads. Click "pins" a point:
  // the viewer locks on it and hovers stop updating until you click
  // somewhere else (or click the same point again to unpin).
  // -------------------------------------------------------------------------
  let pendingPoint = null;
  let renderTimer = null;
  function scheduleRender(point) {
    pendingPoint = point;
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      const p = pendingPoint;
      pendingPoint = null;
      renderTimer = null;
      renderResidue(p);
    }, 80);
  }

  circles
    .style("cursor", "pointer")
    .on("mouseenter", function (_evt, d) {
      if (pinnedIdx !== null) return;  // viewer is locked on a clicked point
      circles.classed("active", false);
      d3.select(this).classed("active", true).attr("r", 5.4);
      scheduleRender(d);
    })
    .on("mouseleave", function () {
      if (pinnedIdx !== null) return;
      d3.select(this).classed("active", false).attr("r", 3.6);
    })
    .on("click", function (evt, d) {
      // Stop the click from bubbling to the SVG-background handler below,
      // which would otherwise immediately unpin the point we just clicked.
      evt.stopPropagation();
      togglePinAt(d);
    });

  // Clicking anywhere off a dot (on either SVG's background) unpins and
  // resumes hover-driven updates. Dot clicks stop propagation so they
  // never reach these handlers.
  function unpinOnBackgroundClick() {
    if (pinnedIdx === null) return;
    pinnedIdx = null;
    circles.classed("pinned", false).classed("active", false).attr("r", 3.6);
    chiSvg.selectAll("circle.pt").classed("pinned", false).classed("active", false);
  }
  svg.on("click", unpinOnBackgroundClick);
  chiSvg.on("click", unpinOnBackgroundClick);

  // Initial render: pick the point closest to the t-SNE centroid for a
  // sensible "everything is calm" starting view.
  const cx = d3.mean(points, (p) => p.tsne[0]);
  const cy = d3.mean(points, (p) => p.tsne[1]);
  let best = 0, bestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    const dx = points[i].tsne[0] - cx, dy = points[i].tsne[1] - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD) { bestD = d2; best = i; }
  }
  await renderResidue(points[best]);

  // Re-fit scatter on window resize so the chart breathes with the layout.
  window.addEventListener("resize", () => {
    const { w: nw, h: nh } = rangeFor(svgEl);
    svg.attr("viewBox", `0 0 ${nw} ${nh}`);
    xScale.range([padding, nw - padding]);
    yScale.range([nh - padding, padding]);
    circles
      .attr("cx", (d) => xScale(d.tsne[0]))
      .attr("cy", (d) => yScale(d.tsne[1]));
  });

  // -------------------------------------------------------------------------
  // Standalone PDB ATOM line writer (the main IIFE has its own private one
  // — we duplicate the few lines instead of refactoring its closure).
  // -------------------------------------------------------------------------
  function fmtPdbAtomLocal(serial, atomName, resName, chainId, resseq, x, y, z) {
    const cols = new Array(80).fill(" ");
    const set = (start, end, str) => {
      for (let i = 0; i < end - start + 1 && i < str.length; i++) {
        cols[start - 1 + i] = str[i];
      }
    };
    // Atom names: per PDB rules, single-letter element names start at col 14
    // (i.e. col 13 is the leading space); the longer multi-char names start
    // at col 13. atomworks-style names like CA/CB/CG/OG1/CH2/NH1 are all
    // safe with the " " + name pattern used by the main writer.
    set(1, 4, "ATOM");
    set(7, 11, String(serial).padStart(5));
    const padName = atomName.length >= 4 ? atomName : " " + atomName;
    set(13, 16, padName.padEnd(4));
    set(18, 20, resName.padEnd(3));
    set(22, 22, chainId);
    set(23, 26, String(resseq).padStart(4));
    set(31, 38, x.toFixed(3).padStart(8));
    set(39, 46, y.toFixed(3).padStart(8));
    set(47, 54, z.toFixed(3).padStart(8));
    set(55, 60, "  1.00");
    set(61, 66, "  0.00");
    // Best-effort element symbol from the first character of the atom name.
    const el = atomName.replace(/[0-9]/g, "")[0] || "C";
    set(77, 78, (" " + el).slice(-2));
    return cols.join("");
  }
})().catch(err => {
  console.error(err);
  document.body.insertAdjacentHTML("afterbegin",
    `<pre style="background:#fdd;padding:1em;margin:0;color:#900">latent atlas: ${err.message}\n${err.stack}</pre>`);
});
