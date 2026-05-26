/* Denoising-a-Protein explorable — NGL-based renderer.
 *
 * Loads pre-computed EDM forward-noising trajectories (see
 * scripts/noise_ubiquitin.py) and renders them in four NGL Viewer stages.
 * Scroll position drives a shared frame index across the three variants.
 *
 *   tau = 0   ⇒  sigma ≈ 0       (clean structure)
 *   tau = 1   ⇒  sigma = sigma_data · sigma_max  (structure dissolved)
 *
 * Per-panel pipeline:
 *   1. Build a CA-only PDB string from PCA-projected coords (chain A; for
 *      the binder panel also chain B = synthesized partner).
 *   2. Load into an NGL Stage with `defaultRepresentation: false`.
 *   3. Add a cartoon representation; NGL handles CA-only SS detection and
 *      draws a smooth spline ribbon.
 *   4. On scroll: write new xyz into the structure's atomStore in place
 *      and call updateRepresentations({position: true}) — no PDB reload.
 */

(async function main() {
  const data = await d3.json("data/trajectories.json");
  console.log(`loaded ${data.pdb_id}: ${data.n_frames} frames, ${data.hero.coords_3d.length} CAs`);

  const N = data.n_frames;
  const heroLen = data.hero.coords_3d.length;
  const partnerLen = data.partner.coords_3d.length;

  // Motif residue range as an NGL selection string.
  const motifResnums = data.hero.motif_resnums;
  const MOTIF_SELE = `${motifResnums[0]}-${motifResnums[motifResnums.length - 1]}`;

  // -------------------------------------------------------------------------
  // Color: N → C residue gradient along the paper palette.
  // Registered as a custom NGL color scheme so cartoon polygons get the
  // gradient applied automatically along the chain.
  // -------------------------------------------------------------------------
  const PALETTE = [
    "#FFE0AC", "#FFC6B2", "#FFACB7", "#D59AB5",
    "#9596C6", "#6686C5", "#4B5FAA",
  ];
  const heroColorScale = d3.scaleSequential(d3.interpolateRgbBasis(PALETTE))
    .domain([0, heroLen - 1]);

  function rgbStringToInt(rgb) {
    // d3 returns "rgb(r, g, b)"; turn into 0xRRGGBB.
    const m = rgb.match(/\d+/g);
    return (parseInt(m[0]) << 16) | (parseInt(m[1]) << 8) | parseInt(m[2]);
  }

  // NGL's custom-scheme factory takes a constructor; `this.atomColor` is
  // called for every atom during render. atom.resno is the residue number
  // we wrote into the PDB.
  const heroScheme = NGL.ColormakerRegistry.addScheme(function () {
    const firstResno = 1;
    this.atomColor = function (atom) {
      if (atom.chainname !== "A") {
        return 0xb6b6c0; // partner stays gray
      }
      const i = atom.resno - firstResno;
      return rgbStringToInt(heroColorScale(i));
    };
  });

  // -------------------------------------------------------------------------
  // Build the PDB strings once (only structural skeleton matters; coords
  // get overwritten frame by frame for the variant panels).
  // -------------------------------------------------------------------------
  const heroPdb = buildChainPdb(data.hero.coords_3d, "A", 1, 1) + "\nEND\n";

  // Binder panel: hero (chain A, will be noised) + partner (chain B, static).
  const binderPdb =
    buildChainPdb(data.hero.coords_3d, "A", 1, 1) + "\n" +
    buildChainPdb(data.partner.coords_3d, "B", 1, heroLen + 1) + "\nEND\n";

  // Cache DOM refs used by renderAtTau early so they're in scope by the
  // time we trigger the initial render.
  const scrollyEl = document.querySelector(".scrolly");
  const tauValEl = document.querySelector(".tau-val");
  const sigmaValEl = document.querySelector(".sigma-val");

  // -------------------------------------------------------------------------
  // Spin up the four panels in parallel.
  // -------------------------------------------------------------------------
  const panels = {
    hero:   await setupPanel("hero",   heroPdb,   null),
    uncond: await setupPanel("uncond", heroPdb,   "uncond"),
    motif:  await setupPanel("motif",  heroPdb,   "motif"),
    binder: await setupPanel("binder", binderPdb, "binder"),
  };

  // Initial frame.
  renderAtTau(0);

  function renderAtTau(tau) {
    const frameIdx = Math.max(0, Math.min(N - 1, Math.round(tau * (N - 1))));
    for (const name of ["uncond", "motif", "binder"]) {
      panels[name].setFrame(frameIdx);
    }
    if (tauValEl) tauValEl.textContent = tau.toFixed(2);
    if (sigmaValEl) sigmaValEl.textContent = data.edm.sigmas[frameIdx].toFixed(2);
  }

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
  // Decorative right-angle dendrogram (unchanged from the SVG version).
  // -------------------------------------------------------------------------
  drawFanArrows();

  // =========================================================================
  // Helpers
  // =========================================================================

  async function setupPanel(panelName, pdbString, variantKey) {
    const el = document.querySelector(`[data-panel="${panelName}"]`);
    const stage = new NGL.Stage(el, {
      backgroundColor: "white",
      quality: "high",
      sampleLevel: 1,
    });

    // No user-driven camera (this is a curated viz; we don't want NGL to
    // capture wheel events and fight the page scroll). Disabling pointer
    // events on the underlying canvas is enough — NGL never receives input.
    stage.viewer.renderer.domElement.style.pointerEvents = "none";

    const blob = new Blob([pdbString], { type: "text/plain" });
    const component = await stage.loadFile(blob, {
      ext: "pdb",
      defaultRepresentation: false,
    });

    // Cartoon ribbon for the hero (chain A). NGL's CA-only path auto-
    // detects SS by spline curvature and lays down a real ribbon.
    component.addRepresentation("cartoon", {
      sele: ":A",
      colorScheme: heroScheme,
      smoothSheet: true,
      subdiv: 6,
      capped: true,
      aspectRatio: 4,
      radius: 0.55,
    });

    if (panelName === "motif") {
      // Darker overlay ribbon on the motif residues.
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

    if (panelName === "binder") {
      // Stylized partner chain in gray.
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

    // Fit camera to the visible structure.
    component.autoView(0);

    // For variant panels: in-place atomStore updates per frame.
    let setFrame = () => {};
    if (variantKey) {
      const frames = data.variants[variantKey].frames;
      const atomStore = component.structure.atomStore;
      setFrame = (idx) => {
        const frame = frames[idx];
        for (let i = 0; i < heroLen; i++) {
          atomStore.x[i] = frame[i][0];
          atomStore.y[i] = frame[i][1];
          atomStore.z[i] = frame[i][2];
        }
        // Mark coords dirty so spline + cartoon mesh regenerate.
        component.structure.refreshPosition();
        component.updateRepresentations({ position: true });
      };
    }

    return { stage, component, setFrame };
  }

  // -------------------------------------------------------------------------
  // PDB ATOM line formatter.
  //
  // PDB format is fixed-width (columns 1..80). NGL's parser is forgiving
  // but cartoon SS detection breaks if columns are off by even one space.
  // -------------------------------------------------------------------------
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
    // " CA " convention: blank in 13, atom name in 14-15, blank in 16.
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

  // -------------------------------------------------------------------------
  // Right-angle dendrogram fan-out arrows (still SVG; NGL is just for
  // the panel interiors).
  // -------------------------------------------------------------------------
  function drawFanArrows() {
    const svg = d3.select(".fan-arrows");
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
      .attr("stroke", trunkColor)
      .attr("stroke-width", 1.4)
      .attr("fill", "none")
      .attr("stroke-linecap", "round")
      .attr("opacity", 0.55);

    svg.append("path")
      .attr("d", `M ${endXs[0]} ${crossY} H ${endXs[endXs.length - 1]}`)
      .attr("stroke", trunkColor)
      .attr("stroke-width", 1.4)
      .attr("fill", "none")
      .attr("stroke-linecap", "round")
      .attr("opacity", 0.55);

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
