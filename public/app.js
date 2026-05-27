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

    function update(tau) {
      const frameIdx = Math.max(0, Math.min(maxFrame, Math.round(tau * maxFrame)));
      panels.uncond.setFrame(frameIdx);
      panels.motif.setFrame(frameIdx);
      panels.binder.setFrame(frameIdx);
      readout(tau, frameIdx);
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
    const colors = ["#4FB9AF", "#D59AB5", "#6686C5"];
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
