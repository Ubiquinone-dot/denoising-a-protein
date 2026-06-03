/* Forward-noising explorable — NGL + D3 renderer.
 *
 * One protein, two noise schedules: EDM (Karras et al. 2022 — the schedule
 * RFdiffusion / RFD3 use) and flow matching (straight-line interpolation
 * from clean structure to a fixed-σ Gaussian cloud). User flips between
 * them with the mode toggle above the panel. In both modes the scroll-
 * driven τ ∈ [0, 1] drives BOTH the structure panel AND the schedule plot
 * marker; the schedule curve itself swaps between modes.
 */

(async function main() {
  const data = await d3.json("data/trajectories.json");
  console.log(
    `loaded ${data.pdb_id}: ${data.n_frames} frames, ` +
    `${data.hero.coords_3d.length} CAs`,
  );

  const N = data.n_frames;
  const FLOW_SIGMA_MAX = data.flow_matching.noise_sigma;  // 12 Å
  const EDM_SIGMAS = data.edm.sigmas;                      // 50-element array

  // -------------------------------------------------------------------------
  // Hero protein catalog. The viz starts on 1QYS (Top7) and the user can
  // swap via the .hero-switch buttons. All three are small monomers; we
  // generate noised frames client-side (see makeFramesForCoords below) so
  // adding a new protein here only needs the PDB file in public/data/.
  // -------------------------------------------------------------------------
  const HERO_PROTEINS = {
    "1qys": { label: "1QYS · Top7", pdbPath: "data/1qys.pdb" },
    "1enh": { label: "1ENH · Engrailed", pdbPath: "data/1enh.pdb" },
    "1ubq": { label: "1UBQ · Ubiquitin", pdbPath: "data/1ubq.pdb" },
  };
  let currentHero = "1qys";  // default
  // Per-hero mutable state — gets re-bound on every setHero() call.
  let heroLen = 0;
  let edmFrames = null;
  let flowFrames = null;

  // -------------------------------------------------------------------------
  // Mode plumbing. Each mode supplies:
  //   - frames: per-frame coords for the structure panel
  //   - sigmaAt(t): σ at scroll-τ ∈ [0, 1] for the plot marker + readout
  //   - schedule: array of (t, σ) sample points that defines the plotted curve
  //   - maxFrameFraction: fraction of N to actually advance the structure to.
  //     EDM blows up at τ = 1 (σ ~ 160 Å); render past 0.65 and NGL's bond
  //     store OOMs. The PLOT still ranges 0..1 — the structure just freezes
  //     at the last visually useful frame while the marker rides to the end.
  //   - sigmaRange: y-axis domain for the schedule plot.
  // -------------------------------------------------------------------------
  // Each mode supplies `tToFrameT(t)` — remap from scroll-τ ∈ [0,1] to the
  // effective interpolation coefficient used to look up a frame. For EDM
  // the precomputed frames already follow the Karras schedule at linear
  // step indices, so it's identity. For nonlinear flow matching we look
  // up the linearly-interpolated frames at √τ instead of τ — that yields
  // a structure whose noise magnitude matches σ_max·√τ.
  const MODES = {
    edm: {
      label: "Diffusion",
      explainer:
        "Diffusion trains a model to undo Gaussian noise added step by " +
        "step under a chosen schedule. The forward (training) process " +
        "destroys the structure until it matches a fixed Gaussian " +
        "prior; the model learns the reverse, one denoising step at a " +
        "time.",
      get frames() { return edmFrames; },
      maxFrameFraction: 0.65,
      tToFrameT: (t) => t,
      sigmaAt: (t) => {
        const idx = Math.max(0, Math.min(N - 1, Math.round(t * (N - 1))));
        return EDM_SIGMAS[idx];
      },
      schedule: EDM_SIGMAS.map((s, i) => [i / (N - 1), s]),
      // σ spans ~4e-4 to 160 Å; show on a log y-axis or it's a hockey
      // stick that's flat for 90% of τ. Log gives readable monotonic ramp.
      yType: "log",
      sigmaRange: [Math.max(1e-3, EDM_SIGMAS[0]), EDM_SIGMAS[EDM_SIGMAS.length - 1]],
    },
    flow: {
      label: "Flow matching",
      explainer:
        "Flow matching defines a smooth path between data and a fixed " +
        "prior (a Gaussian here), then trains the model to predict the " +
        "velocity field along it. No noise schedule — just an " +
        "interpolation between the protein and the prior.",
      get frames() { return flowFrames; },
      maxFrameFraction: 1.0,
      // Linear interpolation: x_τ = (1−τ)·x_0 + τ·noise. σ(τ) = τ·σ_max.
      tToFrameT: (t) => t,
      sigmaAt: (t) => t * FLOW_SIGMA_MAX,
      schedule: (() => {
        const arr = [];
        for (let i = 0; i <= 60; i++) {
          const t = i / 60;
          arr.push([t, t * FLOW_SIGMA_MAX]);
        }
        return arr;
      })(),
      yType: "linear",
      sigmaRange: [0, FLOW_SIGMA_MAX],
    },
  };
  let currentMode = "edm";

  // -------------------------------------------------------------------------
  // Color: N → C residue gradient along the paper palette.
  // The color scale's domain is re-bound on every hero swap (different
  // proteins have different lengths). The NGL Colormaker closes over the
  // outer `heroColorScale` reference, so swapping the closure works.
  // -------------------------------------------------------------------------
  const PALETTE = [
    "#FFACB7",  // [255, 172, 183]
    "#E39FB3",  // [227, 159, 179]
    "#4FB9AF",  // [79, 185, 175]
    "#4D8CAD",  // [77, 140, 173]
    "#4B5FAA",  // [75, 95, 170]
  ];
  let heroColorScale = d3.scaleSequential(d3.interpolateRgbBasis(PALETTE));

  function rgbStringToInt(rgb) {
    const m = rgb.match(/\d+/g);
    return (parseInt(m[0]) << 16) | (parseInt(m[1]) << 8) | parseInt(m[2]);
  }

  const heroScheme = NGL.ColormakerRegistry.addScheme(function () {
    this.atomColor = function (atom) {
      return rgbStringToInt(heroColorScale(atom.resno - 1));
    };
  });

  // -------------------------------------------------------------------------
  // Tiny seeded PRNG (mulberry32). One global seed per app load is enough:
  // we want frames to be reproducible *within* a session (so τ-driven
  // re-renders look stable) but we don't need cross-session determinism.
  // The same seed is reused across every protein, so the noise field has
  // the same "shape" — visually the noising character feels consistent
  // even as the underlying protein changes.
  // -------------------------------------------------------------------------
  function mulberry32(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // Box-Muller off mulberry32 → standard-normal samples.
  function gaussField(seed, L) {
    const rng = mulberry32(seed);
    // 3 dims per residue.
    const out = new Float32Array(L * 3);
    for (let i = 0; i < L * 3; i += 2) {
      let u1 = rng(); if (u1 < 1e-9) u1 = 1e-9;
      const u2 = rng();
      const r = Math.sqrt(-2 * Math.log(u1));
      const theta = 2 * Math.PI * u2;
      out[i] = r * Math.cos(theta);
      if (i + 1 < L * 3) out[i + 1] = r * Math.sin(theta);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Parse CA atoms (chain A) from a raw PDB string. Returns array of
  // [x,y,z]. Only consumes ATOM records with atom name "CA" in chain A.
  // -------------------------------------------------------------------------
  async function fetchCAs(pdbPath) {
    const res = await fetch(pdbPath);
    if (!res.ok) throw new Error(`fetch ${pdbPath} failed: ${res.status}`);
    const text = await res.text();
    const out = [];
    const seenResnums = new Set();
    for (const line of text.split("\n")) {
      if (!line.startsWith("ATOM")) continue;
      const atomName = line.substring(12, 16).trim();
      const altLoc = line.substring(16, 17);
      const chainId = line.substring(21, 22);
      if (atomName !== "CA") continue;
      if (chainId !== "A") continue;
      // Skip altLoc duplicates beyond the first.
      if (altLoc !== " " && altLoc !== "" && altLoc !== "A") continue;
      const resnum = parseInt(line.substring(22, 26).trim(), 10);
      if (seenResnums.has(resnum)) continue;
      seenResnums.add(resnum);
      const x = parseFloat(line.substring(30, 38));
      const y = parseFloat(line.substring(38, 46));
      const z = parseFloat(line.substring(46, 54));
      out.push([x, y, z]);
    }
    if (out.length === 0) throw new Error(`no chain-A CA atoms in ${pdbPath}`);
    return out;
  }

  // -------------------------------------------------------------------------
  // Generate noised frames for a clean coords array. For each frame index
  // i ∈ [0..N-1] we add σ_i · noise to the clean coords. The noise field
  // is *shared* across frames so atoms drift smoothly with σ, instead of
  // re-randomising each frame.
  // -------------------------------------------------------------------------
  function makeFramesForCoords(cleanCoords, sigmas) {
    const L = cleanCoords.length;
    const noise = gaussField(0xC0FFEE, L);  // shared seed across proteins
    const frames = new Array(sigmas.length);
    for (let k = 0; k < sigmas.length; k++) {
      const s = sigmas[k];
      const frame = new Array(L);
      for (let i = 0; i < L; i++) {
        const c = cleanCoords[i];
        frame[i] = [
          c[0] + s * noise[i * 3],
          c[1] + s * noise[i * 3 + 1],
          c[2] + s * noise[i * 3 + 2],
        ];
      }
      frames[k] = frame;
    }
    return frames;
  }

  // -------------------------------------------------------------------------
  // Single scroll-driven panel — mode picks which trajectory to render.
  // -------------------------------------------------------------------------
  const scrollyEl = document.querySelector(".scrolly");
  if (!scrollyEl) throw new Error("no .scrolly element");

  // Hero stage + panel — recreated on every hero swap (different residue
  // counts mean the atomStore length changes, so we can't reuse).
  let panel = null;

  async function buildHero(heroId) {
    const heroDef = HERO_PROTEINS[heroId];
    if (!heroDef) throw new Error(`unknown hero ${heroId}`);
    const cleanCoords = await fetchCAs(heroDef.pdbPath);
    heroLen = cleanCoords.length;
    heroColorScale.domain([0, heroLen - 1]);
    // Flow-matching σ schedule: linear over frame index (matches the
    // linear σ(τ) = τ·σ_max used by the mode). EDM uses the data file's
    // precomputed Karras schedule directly.
    const flowSigmas = [];
    for (let i = 0; i < N; i++) flowSigmas.push((i / (N - 1)) * FLOW_SIGMA_MAX);
    edmFrames = makeFramesForCoords(cleanCoords, EDM_SIGMAS);
    flowFrames = makeFramesForCoords(cleanCoords, flowSigmas);
    const heroPdb = buildChainPdb(cleanCoords, "A", 1, 1) + "\nEND\n";
    // Tear down any previous stage so its WebGL context can be freed.
    // NGL's stage.dispose() releases the GL context but does NOT remove
    // the wrapper <div>/canvas it appended into the panel element — so
    // back-to-back hero swaps would stack canvases and the original
    // (top-z) canvas would keep occluding every subsequent render, making
    // it look like the selector did nothing. Explicitly empty the panel
    // element after dispose to clear those leftovers.
    if (panel) {
      try { panel.stage.dispose(); } catch (e) { /* ignore */ }
      panel = null;
      const heroEl = document.querySelector('[data-panel="noise-hero"]');
      if (heroEl) heroEl.innerHTML = "";
    }
    panel = await setupPanel("noise-hero", heroPdb);
  }

  await buildHero(currentHero);
  // panel.setFrame(framesArray, idx) writes coords into the atomStore.

  function frameAt(t) {
    const mode = MODES[currentMode];
    const maxFrame = Math.floor((N - 1) * mode.maxFrameFraction);
    const effT = mode.tToFrameT(t);
    return Math.max(0, Math.min(maxFrame, Math.round(effT * (N - 1))));
  }

  // -- schedule plot. Curve and axis swap on mode change.
  const scheduleSvgEl = document.querySelector(".schedule-svg");
  const schedule = buildSchedulePlot(scheduleSvgEl);
  schedule.setMode(MODES[currentMode]);

  let lastT = 0;
  function update(t) {
    lastT = t;
    const mode = MODES[currentMode];
    const frameIdx = frameAt(t);
    panel.setFrame(mode.frames, frameIdx);
    const sigma = mode.sigmaAt(t);
    document.querySelector(".t-val").textContent = t.toFixed(2);
    document.querySelector(".sigma-val").textContent = formatSigma(sigma);
    schedule.setT(t);
  }

  function formatSigma(s) {
    if (s >= 10) return s.toFixed(1);
    if (s >= 0.1) return s.toFixed(2);
    return s.toExponential(1);
  }

  function updateFromScroll() {
    const rect = scrollyEl.getBoundingClientRect();
    const scrollable = scrollyEl.offsetHeight - window.innerHeight;
    if (scrollable <= 0) return;
    // Symmetric scroll grace: τ stays at 0 for the first 30% of the
    // spacer (user can settle into the sticky view before noising kicks
    // in) and pins at 1 for the last 30% (fully noised state lingers
    // before the section unsticks). Active noising happens in the
    // middle 40% of the spacer.
    const GRACE = 0.30;
    const raw = -rect.top / scrollable;
    const t = Math.max(0, Math.min(1, (raw - GRACE) / (1 - 2 * GRACE)));
    update(t);
  }

  // Mode toggle wiring. Pushes the active mode's explainer text into the
  // left-of-protein side card too — that card describes the training
  // recipe for whichever schedule the user is looking at right now.
  const explainerBodyEl = document.querySelector(".mode-explainer-body");
  function applyExplainer(m) {
    if (explainerBodyEl) explainerBodyEl.textContent = MODES[m].explainer;
  }
  function setMode(m) {
    if (!MODES[m] || m === currentMode) return;
    currentMode = m;
    document.querySelectorAll(".mode-btn").forEach((b) =>
      b.classList.toggle("active", b.dataset.mode === m));
    document.querySelector(".mode-label").textContent = MODES[m].label;
    applyExplainer(m);
    schedule.setMode(MODES[m]);
    update(lastT);
  }
  document.querySelectorAll(".mode-btn").forEach((btn) =>
    btn.addEventListener("click", () => setMode(btn.dataset.mode)));
  // Initial text.
  applyExplainer(currentMode);

  // -------------------------------------------------------------------------
  // Hero swap. Tears down the current NGL stage, fetches the new PDB's
  // CAs, regenerates noised frames for both modes, rebuilds the panel,
  // and re-runs update(lastT). The .hero-label-name span is updated so
  // the readout below the panel matches the new protein.
  // -------------------------------------------------------------------------
  let heroBusy = false;
  async function setHero(id) {
    if (!HERO_PROTEINS[id] || id === currentHero || heroBusy) return;
    heroBusy = true;
    try {
      currentHero = id;
      document.querySelectorAll(".hero-btn").forEach((b) =>
        b.classList.toggle("active", b.dataset.hero === id));
      await buildHero(id);
      const labelName = id.toUpperCase();
      const el = document.querySelector(".hero-label-name");
      if (el) el.textContent = labelName;
      update(lastT);
    } catch (err) {
      console.error("setHero failed:", err);
    } finally {
      heroBusy = false;
    }
  }
  document.querySelectorAll(".hero-btn").forEach((btn) =>
    btn.addEventListener("click", () => setHero(btn.dataset.hero)));

  update(0);
  window.addEventListener("scroll", updateFromScroll, { passive: true });
  window.addEventListener("resize", () => { schedule.resize(); updateFromScroll(); }, { passive: true });
  updateFromScroll();

  // -------------------------------------------------------------------------
  // D3 schedule-plot factory. Generic: callers supply a mode object with
  // `schedule` (array of [t, σ]), `sigmaRange`, `yType` ("linear" | "log").
  // Returns { setMode(mode), setT(t), resize() }.
  // -------------------------------------------------------------------------
  function buildSchedulePlot(svgEl) {
    const padL = 48, padR = 14, padT = 22, padB = 30;
    let W = 0, H = 0;
    let xScale, yScale, gdot;
    let mode = null;

    const root = d3.select(svgEl);

    function layout() {
      const r = svgEl.getBoundingClientRect();
      W = Math.max(220, r.width);
      H = Math.max(160, r.height);
      root.attr("viewBox", `0 0 ${W} ${H}`)
        .attr("preserveAspectRatio", "none");
      xScale = d3.scaleLinear().domain([0, 1]).range([padL, W - padR]);
      const [ymin, ymax] = mode.sigmaRange;
      yScale = (mode.yType === "log")
        ? d3.scaleLog().domain([ymin, ymax]).range([H - padB, padT])
        : d3.scaleLinear().domain([ymin, ymax]).range([H - padB, padT]);
    }

    function draw() {
      root.selectAll("*").remove();
      if (!mode) return;
      layout();

      // x ticks (more of them for readability) + light vertical gridlines.
      // Log y picks decade-aligned ticks; linear y uses 4 evenly spaced ones.
      const xTickVals = [0, 0.25, 0.5, 0.75, 1];
      const yTickVals = (mode.yType === "log")
        ? niceLogTicks(mode.sigmaRange[0], mode.sigmaRange[1])
        : niceLinearTicks(mode.sigmaRange[0], mode.sigmaRange[1], 4);

      // Gridlines — drawn first so axes/curve sit on top.
      const gridG = root.append("g").attr("class", "grid");
      xTickVals.forEach((tx) => {
        if (tx === 0 || tx === 1) return;
        gridG.append("line")
          .attr("x1", xScale(tx)).attr("x2", xScale(tx))
          .attr("y1", padT).attr("y2", H - padB);
      });
      yTickVals.forEach((ty) => {
        if (ty === mode.sigmaRange[0] || ty === mode.sigmaRange[1]) return;
        gridG.append("line")
          .attr("x1", padL).attr("x2", W - padR)
          .attr("y1", yScale(ty)).attr("y2", yScale(ty));
      });

      // Axis lines.
      const axisG = root.append("g").attr("class", "axis");
      axisG.append("line")
        .attr("x1", padL).attr("x2", W - padR)
        .attr("y1", H - padB).attr("y2", H - padB);
      axisG.append("line")
        .attr("x1", padL).attr("x2", padL)
        .attr("y1", padT).attr("y2", H - padB);

      // x tick labels + small ticks below the axis.
      xTickVals.forEach((tx) => {
        axisG.append("line")
          .attr("class", "tickmark")
          .attr("x1", xScale(tx)).attr("x2", xScale(tx))
          .attr("y1", H - padB).attr("y2", H - padB + 4);
        axisG.append("text")
          .attr("class", "tick")
          .attr("x", xScale(tx))
          .attr("y", H - padB + 14)
          .attr("text-anchor", "middle")
          .text(tx.toFixed(tx === 0 || tx === 1 ? 0 : 2));
      });

      // y tick labels + small ticks left of the axis.
      yTickVals.forEach((ty) => {
        axisG.append("line")
          .attr("class", "tickmark")
          .attr("x1", padL - 4).attr("x2", padL)
          .attr("y1", yScale(ty)).attr("y2", yScale(ty));
        axisG.append("text")
          .attr("class", "tick")
          .attr("x", padL - 6)
          .attr("y", yScale(ty) + 3)
          .attr("text-anchor", "end")
          .text(formatYTick(ty));
      });

      // Axis titles — moved well clear of the corner ticks.
      axisG.append("text")
        .attr("class", "axis-label")
        .attr("x", (W - padR + padL) / 2)
        .attr("y", H - 4)
        .attr("text-anchor", "middle")
        .text("τ");
      axisG.append("text")
        .attr("class", "axis-label")
        .attr("x", 4)
        .attr("y", padT - 6)
        .attr("text-anchor", "start")
        .text("σ (Å)");

      // Curve.
      const line = d3.line()
        .x((d) => xScale(d[0]))
        .y((d) => yScale(Math.max(mode.sigmaRange[0], d[1])))
        .curve(d3.curveMonotoneX);
      root.append("path")
        .attr("class", "sched-line")
        .attr("d", line(mode.schedule));

      // Dot ON the curve + projection line straight down to the x-axis.
      gdot = root.append("g").attr("class", "sched-dot");
      gdot.append("line").attr("class", "sched-proj");
      gdot.append("circle").attr("r", 5.5).attr("class", "sched-dot-c");
    }

    function niceLinearTicks(min, max, n) {
      const arr = [];
      for (let i = 0; i <= n; i++) arr.push(min + (max - min) * (i / n));
      return arr;
    }
    function niceLogTicks(min, max) {
      // Powers of 10 between min and max, inclusive at the edges.
      const lo = Math.floor(Math.log10(min));
      const hi = Math.ceil(Math.log10(max));
      const arr = [];
      for (let p = lo; p <= hi; p++) {
        const v = Math.pow(10, p);
        if (v >= min * 0.99 && v <= max * 1.01) arr.push(v);
      }
      // Always include the actual endpoints.
      if (arr[0] !== min) arr.unshift(min);
      if (arr[arr.length - 1] !== max) arr.push(max);
      return arr;
    }

    function formatYTick(v) {
      if (mode.yType === "log") {
        if (v >= 100) return v.toFixed(0);
        if (v >= 1) return v.toFixed(0);
        if (v >= 0.01) return v.toFixed(2);
        return v.toExponential(0).replace("e+", "e").replace("e-0", "e-").replace("e-", "e-");
      }
      return v.toFixed(0);
    }

    function setMode(m) { mode = m; draw(); }

    function setT(t) {
      if (!gdot || !mode) return;
      const sigma = mode.sigmaAt(t);
      const cx = xScale(t);
      const cy = yScale(Math.max(mode.sigmaRange[0], sigma));
      gdot.select("line.sched-proj")
        .attr("x1", cx).attr("x2", cx).attr("y1", cy).attr("y2", H - padB);
      gdot.select("circle.sched-dot-c").attr("cx", cx).attr("cy", cy);
    }

    function resize() { draw(); }

    return { setMode, setT, resize };
  }

  // -------------------------------------------------------------------------
  // Single-panel setup. setFrame(framesArray, idx) writes coords directly
  // into the structure's atomStore so the SAME stage / component / camera
  // is reused across mode switches — just the atom positions swap.
  // -------------------------------------------------------------------------
  async function setupPanel(panelDataAttr, pdbString) {
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

    // Main cartoon ribbon (N→C palette gradient).
    component.addRepresentation("cartoon", {
      sele: ":A",
      colorScheme: heroScheme,
      smoothSheet: true,
      subdiv: 6,
      capped: true,
      aspectRatio: 4,
      radius: 0.55,
    });

    component.autoView(0);

    // Per-scroll frame update: write straight into the structure's
    // atomStore (Float32Array) and trigger a single re-render.
    //
    // NOTE: we deliberately skip structure.refreshPosition() — it rebuilds
    // the bond store / spatial hash from the new coords, and at EDM's
    // extreme-σ frames (σ ~ 2500 Å) the bond store tries to allocate a
    // multi-gigabyte buffer and throws RangeError. updateRepresentations
    // is enough to re-derive the cartoon mesh from the new atomStore.
    const atomStore = component.structure.atomStore;
    function setFrame(framesArray, idx) {
      const frame = framesArray[idx];
      for (let i = 0; i < heroLen; i++) {
        atomStore.x[i] = frame[i][0];
        atomStore.y[i] = frame[i][1];
        atomStore.z[i] = frame[i][2];
      }
      component.updateRepresentations({ position: true });
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
})().catch(err => {
  console.error(err);
  document.body.insertAdjacentHTML("afterbegin",
    `<pre style="background:#fdd;padding:1em;margin:0;color:#900">${err.message}\n${err.stack}</pre>`);
});

/* =========================================================================
 * Autoencoder diagram. Two NGL panels of 1ENH side-by-side: the left shows
 * all-atom (sticks + cartoon), the right shows backbone-only ribbon overlaid
 * on a stylized "Z" — the latent bottleneck the diffusion model actually
 * sees. Guide arrows from the Z point down to the t-SNE section and fade
 * out as the latent-atlas section enters the viewport.
 * ========================================================================= */
(async function autoencoderDiagram() {
  const allAtomEl = document.querySelector('[data-panel="ae-allatom"]');
  const backboneEl = document.querySelector('[data-panel="ae-backbone"]');
  const decodedEl = document.querySelector('[data-panel="ae-decoded"]');
  if (!allAtomEl || !backboneEl) return;

  function newStage(el, bg) {
    // NGL Stage with minimal options — `quality: "high"` + `sampleLevel`
    // can trigger a "Canvas has an existing context of a different type"
    // error when too many stages already exist on the page, since NGL
    // negotiates webgl2 → webgl1 fallback and the second getContext()
    // call on the same canvas fails. Defaults are safe.
    const stage = new NGL.Stage(el, { backgroundColor: bg });
    // Read-only — no user rotation; diagrams should stay still.
    if (stage.viewer.renderer?.domElement) {
      stage.viewer.renderer.domElement.style.pointerEvents = "none";
    }
    return stage;
  }

  // Force NGL to draw + keep pixels alive. NGL's renderer uses
  // preserveDrawingBuffer=true so a single render *should* persist, but
  // empirically — especially on Chrome with multiple WebGL contexts —
  // the back buffer can clear if the canvas isn't touched again before
  // the compositor runs. We trigger several renders across rAF ticks,
  // and re-trigger on IntersectionObserver enter.
  function keepAlive(stage) {
    let burstFrames = 0;
    function pump() {
      stage.viewer.handleResize();
      stage.viewer.requestRender();
      if (burstFrames-- > 0) requestAnimationFrame(pump);
    }
    function burst(n = 8) { burstFrames = n; requestAnimationFrame(pump); }
    burst(16);
    // Re-pump when the section scrolls into view (handles the case where
    // the stage was constructed off-screen and IntersectionObserver only
    // fires once the user reaches it).
    const obs = new IntersectionObserver((entries) => {
      for (const ent of entries) if (ent.isIntersecting) burst(8);
    }, { threshold: [0, 0.1, 0.5] });
    obs.observe(stage.viewer.container);
    return burst;
  }

  // Serialize the two stage builds. Parallel loadFile calls into separate
  // NGL stages races on internal state (ColormakerRegistry, shader cache)
  // in 2.3.1 and frequently leaves one buffer empty.
  const stageAll = newStage(allAtomEl, "#fafaf7");
  const compAll = await stageAll.loadFile("data/1enh.pdb", { ext: "pdb", defaultRepresentation: false });
  // All-atom view: gray cartoon ribbon for the backbone + teal sticks for
  // every heavy-atom sidechain. The cartoon is the "structure" the model
  // operates over (held fixed by the AE), and the teal sticks are the
  // *only* thing the AE has to compress into z — matching the LATENT Z
  // accent everywhere else on the page so the chain of logic reads
  // visually: teal atoms → teal Z → teal latent space.
  const aaScheme = NGL.ColormakerRegistry.addScheme(function () {
    // sidechainAttached includes CA — keep CA grey so the stick visibly
    // anchors to the cartoon, while the actual sidechain heavy atoms
    // (CB, CG, etc.) read as teal.
    const BB = new Set(["N", "CA", "C", "O", "OXT", "H", "HA"]);
    this.atomColor = function (atom) {
      return BB.has(atom.atomname) ? 0x08415C : 0x4FB9AF;
    };
  });
  compAll.addRepresentation("cartoon", {
    sele: ":A",
    color: 0x08415C,
    smoothSheet: true,
    radius: 0.35,
  });
  compAll.addRepresentation("ball+stick", {
    sele: ":A and sidechainAttached and not hydrogen",
    colorScheme: aaScheme,
    radius: 0.28,
    aspectRatio: 1.4,
    multipleBond: "off",
  });
  compAll.autoView();
  const burstAll = keepAlive(stageAll);

  const stageBb = newStage(backboneEl, "#f3f0f5");
  const compBb = await stageBb.loadFile("data/1enh.pdb", { ext: "pdb", defaultRepresentation: false });
  // Backbone-only ribbon. Same chain, no side chains. Paper_indigo ribbon
  // — same hex as the BACKBONE label (.backbone-highlight) so the structural
  // accent reads in both text and 3D. Pairs with the paper_teal LATENT Z
  // accent: cool palette duo for the encoder's two outputs.
  compBb.addRepresentation("cartoon", {
    sele: ":A",
    color: 0x08415C,
    smoothSheet: true,
    radius: 0.5,
  });
  compBb.autoView();
  const burstBb = keepAlive(stageBb);

  // Decoder-side panel: same all-atom ball+stick rendering as the input.
  // The model is an autoencoder, so the reconstructed structure ≈ input —
  // showing it makes the encoder-bottleneck-decoder loop explicit.
  let stageDec = null, compDec = null, burstDec = null;
  if (decodedEl) {
    stageDec = newStage(decodedEl, "#fafaf7");
    compDec = await stageDec.loadFile("data/1enh.pdb", { ext: "pdb", defaultRepresentation: false });
    compDec.addRepresentation("cartoon", {
      sele: ":A",
      color: 0x08415C,
      smoothSheet: true,
      radius: 0.35,
    });
    compDec.addRepresentation("ball+stick", {
      sele: ":A and sidechainAttached and not hydrogen",
      colorScheme: aaScheme,
      radius: 0.28,
      aspectRatio: 1.4,
      multipleBond: "off",
    });
    compDec.autoView();
    burstDec = keepAlive(stageDec);
  }

  // Expose for debugging.
  window.__ae = { stageAll, compAll, stageBb, compBb, stageDec, compDec, burstAll, burstBb, burstDec };

  // Final defensive double-pump after all three are loaded.
  setTimeout(() => { burstAll(8); burstBb(8); burstDec && burstDec(8); }, 400);

  // (Guide lines removed: visual coupling between the bottleneck Z and
  // the latent-Z t-SNE panel is now carried by a shared accent colour
  // on the word "LATENT Z" in both places. No SVG overlay needed.)

  // -------------------------------------------------------------------------
  // Latent-Z viewer: small horizontal bar chart of an 8-D z for a
  // representative residue, with a hover/click-pin state machine wired
  // to the .ae-z-card box above. Lives below the AE row.
  //
  // State machine:
  //   hidden       — opacity 0, pointer-events none, no layout cost
  //   hover-shown  — mouseenter on Z card; leaves on mouseleave
  //   pinned       — click on Z card; persistent. × button, Esc, or
  //                  another click on the Z card returns to hidden.
  // -------------------------------------------------------------------------
  const zCard   = document.querySelector(".ae-z-card");
  const viewer  = document.querySelector(".latent-z-viewer");
  const viewSvg = document.querySelector(".latent-z-viewer-svg");
  const closeBtn = document.querySelector(".latent-z-viewer-close");
  if (zCard && viewer && viewSvg) {
    // Fetch the atlas just for points[0].latent. If it fails, fall back to
    // a small synthetic vector so the viewer still renders something.
    let zVec = null;
    try {
      const atlas = await d3.json("data/latent_atlas.json?v=2");
      if (atlas && atlas.points && atlas.points[0] && atlas.points[0].latent) {
        zVec = atlas.points[0].latent;
      }
    } catch (e) {
      console.warn("latent_atlas fetch for Z viewer failed; using synthetic.", e);
    }
    if (!zVec) zVec = [0.6, -1.1, 0.3, 1.4, -0.5, 0.9, -0.2, 0.7];

    // Bar chart — horizontal axis = z_1..z_8, vertical = signed value.
    (function drawBars() {
      const svg = d3.select(viewSvg);
      const W = 380, H = 140;
      const padL = 28, padR = 10, padT = 10, padB = 22;
      svg.attr("viewBox", `0 0 ${W} ${H}`).attr("preserveAspectRatio", "xMidYMid meet");
      const x = d3.scaleBand().domain(d3.range(8)).range([padL, W - padR]).padding(0.22);
      const maxAbs = Math.max(0.5, d3.max(zVec, (v) => Math.abs(v)));
      const y = d3.scaleLinear().domain([-maxAbs, maxAbs]).range([H - padB, padT]);
      // Zero line + axis baseline.
      svg.append("line").attr("class", "bar-zero")
        .attr("x1", padL).attr("x2", W - padR)
        .attr("y1", y(0)).attr("y2", y(0));
      svg.append("g").selectAll("rect").data(zVec).join("rect")
        .attr("class", "bar")
        .attr("x", (_, i) => x(i))
        .attr("width", x.bandwidth())
        .attr("y", (d) => Math.min(y(d), y(0)))
        .attr("height", (d) => Math.abs(y(d) - y(0)))
        .attr("rx", 1.5);
      // z_1 .. z_8 labels (subscript via unicode).
      const subs = ["₁","₂","₃","₄","₅","₆","₇","₈"];
      svg.append("g").selectAll("text").data(d3.range(8)).join("text")
        .attr("class", "bar-tick")
        .attr("x", (i) => x(i) + x.bandwidth() / 2)
        .attr("y", H - padB + 12)
        .attr("text-anchor", "middle")
        .text((i) => `z${subs[i]}`);
    })();

    // ---- State machine wiring ----
    let state = "hidden";
    function apply() {
      viewer.classList.toggle("visible", state !== "hidden");
      viewer.classList.toggle("pinned", state === "pinned");
      viewer.setAttribute("aria-hidden", state === "hidden" ? "true" : "false");
      zCard.classList.toggle("pinned", state === "pinned");
    }
    function setState(next) { state = next; apply(); }

    zCard.addEventListener("mouseenter", () => {
      if (state === "hidden") setState("hover-shown");
    });
    zCard.addEventListener("mouseleave", () => {
      if (state === "hover-shown") setState("hidden");
    });
    zCard.addEventListener("click", () => {
      // Click on the Z box: hover-shown → pinned, pinned → hidden (toggle).
      if (state === "pinned") setState("hidden");
      else setState("pinned");
    });
    zCard.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (state === "pinned") setState("hidden");
        else setState("pinned");
      }
    });
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();  // don't bubble back to the zCard click handler
      setState("hidden");
    });
    // Esc unpins.
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && state === "pinned") setState("hidden");
    });

    // -----------------------------------------------------------------------
    // Backbone viewer — mirror of the latent-Z viewer, indigo accent. Shows
    // a small SVG of one N-CA-C(=O) peptide unit with φ/ψ torsion labels,
    // anchored under the same AE row as the Z viewer. The two viewers are
    // mutually exclusive: opening one collapses the other so they don't
    // overlap visually.
    // -----------------------------------------------------------------------
    const bbCard   = document.querySelector(".ae-bb-card");
    const bbViewer = document.querySelector(".backbone-viewer");
    const bbSvg    = document.querySelector(".backbone-viewer-svg");
    const bbClose  = document.querySelector(".backbone-viewer-close");
    if (bbCard && bbViewer && bbSvg) {
      // ---- Draw the peptide-unit sketch ----
      (function drawBackbone() {
        const svg = d3.select(bbSvg);
        const W = 440, H = 150;
        svg.attr("viewBox", `0 0 ${W} ${H}`).attr("preserveAspectRatio", "xMidYMid meet");

        // Atom layout. Backbone reads left-to-right N → CA → C, with the
        // carbonyl O branching upward off C and the next residue's N
        // implied to the right. Y values are picked to read like a
        // textbook peptide-unit cartoon.
        const yMain = 92;
        const yO    = 50;
        const atoms = [
          { id: "N",    x:  72, y: yMain, cls: "bb-atom-n",  label: "N"  },
          { id: "CA",   x: 160, y: yMain, cls: "bb-atom-ca", label: "Cα" },
          { id: "C",    x: 248, y: yMain, cls: "bb-atom-c",  label: "C"  },
          { id: "O",    x: 248, y: yO,    cls: "bb-atom-o",  label: "O"  },
          { id: "Nn",   x: 336, y: yMain, cls: "bb-atom-n",  label: "N"  },
        ];
        const byId = Object.fromEntries(atoms.map((a) => [a.id, a]));

        const g = svg.append("g");

        // C=O double bond (drawn as a thick translucent halo behind the
        // main single-bond stroke).
        const ca = byId.CA, c = byId.C, n = byId.N, o = byId.O, nn = byId.Nn;
        g.append("line").attr("class", "bb-dbond-outer")
          .attr("x1", c.x).attr("y1", c.y).attr("x2", o.x).attr("y2", o.y);
        g.append("line").attr("class", "bb-bond")
          .attr("x1", c.x).attr("y1", c.y).attr("x2", o.x).attr("y2", o.y);

        // Single bonds along the main chain.
        [[n, ca], [ca, c], [c, nn]].forEach(([a, b]) => {
          g.append("line").attr("class", "bb-bond")
            .attr("x1", a.x).attr("y1", a.y).attr("x2", b.x).attr("y2", b.y);
        });

        // φ torsion: rotation about N–CA. ψ torsion: rotation about CA–C.
        // Draw a small dashed arc + greek label above each bond's midpoint.
        function torsionArc(a, b, label, dy) {
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          g.append("path")
            .attr("class", "bb-tors-arc")
            .attr("d", `M ${mx - 16} ${my + dy + 8} Q ${mx} ${my + dy - 6} ${mx + 16} ${my + dy + 8}`);
          g.append("text")
            .attr("class", "bb-tors")
            .attr("x", mx).attr("y", my + dy + 22)
            .text(label);
        }
        torsionArc(n,  ca, "φ", -38);
        torsionArc(ca, c,  "ψ", -38);

        // Atoms on top of bonds; circles + single-letter labels inside.
        atoms.forEach((a) => {
          g.append("circle")
            .attr("class", a.cls)
            .attr("cx", a.x).attr("cy", a.y).attr("r", 14);
          g.append("text")
            .attr("class", "bb-label")
            .attr("x", a.x).attr("y", a.y)
            .text(a.label);
        });

        // Faint "···" continuation marks on either end to signal the
        // chain continues into neighbouring residues.
        const ell = "fill: rgba(8,65,92,0.45); font: 600 14px ui-monospace, \"SF Mono\", Menlo, monospace;";
        g.append("text").attr("x", 30).attr("y", yMain + 4).attr("text-anchor", "middle")
          .attr("style", ell).text("⋯");
        g.append("text").attr("x", W - 30).attr("y", yMain + 4).attr("text-anchor", "middle")
          .attr("style", ell).text("⋯");
      })();

      // ---- State machine wiring (mirror of the Z viewer) ----
      let bbState = "hidden";
      function bbApply() {
        bbViewer.classList.toggle("visible", bbState !== "hidden");
        bbViewer.classList.toggle("pinned",  bbState === "pinned");
        bbViewer.setAttribute("aria-hidden", bbState === "hidden" ? "true" : "false");
        bbCard.classList.toggle("pinned",    bbState === "pinned");
      }
      function closeBb() { if (bbState !== "hidden") { bbState = "hidden"; bbApply(); } }
      function setBbState(next) {
        // Mutual exclusion: opening the backbone viewer collapses the
        // Z viewer (so both never overlap on the same anchor). The
        // reverse direction (opening Z closes backbone) is wired via
        // listeners on the Z card below, since we can't safely reassign
        // its setState from out here.
        if (next !== "hidden" && state !== "hidden") setState("hidden");
        bbState = next;
        bbApply();
      }
      // Symmetric reverse mutual-exclusion: any Z-card open gesture
      // closes the backbone viewer first. Listeners added here run
      // before the Z card's own listeners reach setState (capture phase
      // ensures the order is deterministic regardless of bind order).
      zCard.addEventListener("mouseenter", closeBb, true);
      zCard.addEventListener("click",      closeBb, true);
      zCard.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") closeBb();
      }, true);

      bbCard.addEventListener("mouseenter", () => {
        if (bbState === "hidden") setBbState("hover-shown");
      });
      bbCard.addEventListener("mouseleave", () => {
        if (bbState === "hover-shown") setBbState("hidden");
      });
      bbCard.addEventListener("click", () => {
        if (bbState === "pinned") setBbState("hidden");
        else setBbState("pinned");
      });
      bbCard.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (bbState === "pinned") setBbState("hidden");
          else setBbState("pinned");
        }
      });
      bbClose.addEventListener("click", (e) => {
        e.stopPropagation();
        setBbState("hidden");
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && bbState === "pinned") setBbState("hidden");
      });
    }
  }
})().catch(err => {
  console.error("autoencoder diagram failed:", err);
  // Non-fatal — surface a quiet note next to the section instead of
  // shouting at the user. The latent atlas section below still works.
  const sec = document.querySelector(".ae-section");
  if (sec) {
    sec.insertAdjacentHTML("beforeend",
      `<p class="ae-error">autoencoder diagram failed to load (1ENH fetch?): ${err.message}</p>`);
  }
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
    // ?v=2 cache-bust: the JSON gained per-point `chi_strain` and stale
    // browser caches will skip the rotamer-strain colour scheme silently.
    atlas = await d3.json("data/latent_atlas.json?v=2");
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
  // Chemistry-grouped paper palette. Adjacent AAs in the legend share
  // a hue family so colour itself encodes chemistry:
  //   hydrophobic aliphatic → warm yellows / sage / terracotta
  //   aromatic              → purples
  //   polar uncharged       → teals
  //   positive              → blues
  //   negative              → warm pinks
  //   special (GLY/CYS)     → neutrals
  const AA_PALETTE_20 = [
    "#FFE0AC", // ALA — navaho   (hydrophobic)
    "#4B5FAA", // ARG — darkblue (positive)
    "#7C8BC8", // ASN — periwinkle (polar)
    "#FFACB7", // ASP — pink     (negative)
    "#5C7592", // CYS — steel    (special)
    "#9596C6", // GLN — lightblue (polar)
    "#FFC6B2", // GLU — melon    (negative)
    "#08415C", // GLY — indigo   (special)
    "#C88497", // HIS — dustyrose (aromatic)
    "#A9C99E", // ILE — sage     (hydrophobic)
    "#C8C383", // LEU — olive    (hydrophobic)
    "#6686C5", // LYS — blue     (positive)
    "#82CDB9", // MET — seafoam  (hydrophobic)
    "#D59AB5", // PHE — purple   (aromatic)
    "#D49580", // PRO — terracotta (hydrophobic)
    "#4FB9AF", // SER — teal     (polar)
    "#87A8D0", // THR — skyblue  (polar)
    "#A07895", // TRP — plum     (aromatic)
    "#B5A8D0", // TYR — lavender (aromatic)
    "#E8C58A", // VAL — mustard  (hydrophobic)
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

  // ---- Energy / conformer-strain proxy: ‖z‖₂ of the residue's latent.
  //      We don't have real Rosetta scores in the JSON, so we use the
  //      L2 norm of each residue's 8-D latent as a stand-in for "how
  //      far this conformer is from the bulk of the distribution"
  //      (which correlates with strain / atypicality the encoder needs
  //      extra capacity for). Percentile-clipped to keep a few outliers
  //      from washing out the rest of the palette. ----
  // Stash ‖z‖ directly on each point so colour lookups are O(1).
  for (const p of points) {
    let s = 0;
    for (const v of p.latent) s += v * v;
    p._zNorm = Math.sqrt(s);
  }
  // 2nd–98th percentile so a handful of outliers don't compress the
  // visible range to a single colour.
  const sortedZ = points.map((p) => p._zNorm).sort((a, b) => a - b);
  const ZN_LO = sortedZ[Math.floor(sortedZ.length * 0.02)];
  const ZN_HI = sortedZ[Math.floor(sortedZ.length * 0.98)];
  const zNormRamp = d3.scaleSequential(d3.interpolateRgbBasis(PAPER_RAMP))
    .domain([ZN_LO, ZN_HI]);

  // Rotamer-strain scheme: percentile-clipped to keep outliers from
  // collapsing the visible range. ALA/GLY are flat 0 (no χ axes).
  const sortedStrain = points.map((p) => p.chi_strain).filter((v) => v > 0).sort((a, b) => a - b);
  const STRAIN_LO = sortedStrain[Math.floor(sortedStrain.length * 0.05)];
  const STRAIN_HI = sortedStrain[Math.floor(sortedStrain.length * 0.95)];
  const strainRamp = d3.scaleSequential(d3.interpolateRgbBasis(["#4FB9AF", "#9596C6", "#08415C"])).domain([STRAIN_LO, STRAIN_HI]);

  // ---- Active colour scheme — switched by the four buttons up top. ----
  let scheme = "aa";
  function colorForPoint(p) {
    if (scheme === "aa") return aaColor(p.gt_restype);
    if (scheme === "hydro") {
      const b = HYDRO_BUCKETS[p.gt_restype];
      return HYDRO_COLORS[b] || "#888";
    }
    if (scheme === "energy") {
      const v = Math.max(ZN_LO, Math.min(ZN_HI, p._zNorm));
      return zNormRamp(v);
    }
    if (scheme === "rotamer") {
      if (p.chi_strain <= 0) return "#cccccc";  // GLY/ALA neutral
      const v = Math.max(STRAIN_LO, Math.min(STRAIN_HI, p.chi_strain));
      return strainRamp(v);
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

    if (scheme === "atoms" || scheme === "energy" || scheme === "rotamer") {
      // Gradient bar — no clickable filter, just min / max labels.
      const grad = document.createElement("div");
      grad.className = "legend-gradient";
      const bar = document.createElement("div");
      bar.className = "legend-gradient-bar";
      const rampForLegend = (scheme === "rotamer")
        ? ["#4FB9AF", "#9596C6", "#08415C"]
        : PAPER_RAMP;
      const stops = rampForLegend.map((c, i) => `${c} ${(i / (rampForLegend.length - 1) * 100).toFixed(0)}%`).join(", ");
      bar.style.background = `linear-gradient(to right, ${stops})`;
      const labels = document.createElement("div");
      labels.className = "legend-gradient-labels";
      if (scheme === "atoms") {
        labels.innerHTML = `<span>${ATOM_MIN} heavy atoms</span><span>${ATOM_MAX}</span>`;
      } else if (scheme === "energy") {
        labels.innerHTML = `<span>low ‖z‖ ${ZN_LO.toFixed(1)}</span><span>${ZN_HI.toFixed(1)} high ‖z‖</span>`;
      } else {  // rotamer
        labels.innerHTML = `<span>canonical ${STRAIN_LO.toFixed(2)}</span><span>${STRAIN_HI.toFixed(2)} strained</span>`;
      }
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
      // Reach controls the phantom bounding-box autoView fits to. Smaller
      // reach = tighter framing. NGL's autoView pads heavily, so we need
      // a small bbox AND an explicit zoom-in below to actually frame the
      // residue at a visible size. 1.0 Å keeps ALA centred and lets
      // TRP's 6 Å indole still mostly fit (edges may clip — that's the
      // size-of-sidechain story).
      const REACH = 1.0;
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
      // Extra zoom-IN on top of autoView. autoView pads heavily, so
      // without this the residue floats lonely in the middle. NGL's
      // viewerControls.zoom(z) multiplies the camera distance by
      // (1 - z) — so positive z = closer, negative z = further. 0.25
      // tightens the framing without pushing the near plane through
      // the molecule (which would clip the residue entirely).
      stage.viewerControls.zoom(0.25);
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
