# "Denoising a Protein" — design sketch v1

We're going with proposal #1 (RFdiffusion denoising), with a key twist that flips the
narrative on its head: **show how the same protein gives rise to four different training
recipes by being noised in four different ways.** Then let the reader scrub the noise
level bidirectionally to *feel* what each recipe is teaching the model.

## The central idea

Most existing protein-diffusion explainers tell the *inference* story: "noise → finished
structure." That's the model being run. **Our explorable tells the *training* story** —
how do we even teach the network to denoise in the first place? The answer is that we
take real PDB structures, noise them forward, and ask the network to predict the
denoising step. **The conditioning recipe — i.e. *what we keep fixed while we noise* —
is what determines whether you end up with a model that does unconditional generation,
motif scaffolding, binder design, etc.**

That insight is genuinely under-explained in the field. Even people who can run RFdiffusion
often don't have a clean mental model of *why* the same architecture can do all those
tasks. We can fix that with a single visual.

## Page layout

```
                      ┌───────────────────────────┐
                      │      ubiquitin (76 aa)    │
                      │   2D CA-trace projection  │
                      │   colored by residue idx  │
                      └────────────┬──────────────┘
                                   │
                       ╱           │           ╲
                     ╱             │             ╲
                   ↓               ↓               ↓
            ┌────────────┐  ┌────────────┐  ┌────────────┐
            │  uncond.   │  │   motif    │  │  binder    │
            │            │  │ scaffolding│  │  design    │
            │  (all CAs  │  │ (active    │  │ (target    │
            │   noised)  │  │  site kept)│  │  chain     │
            │            │  │            │  │  fixed)    │
            └────────────┘  └────────────┘  └────────────┘
                  │               │               │
                  │               │               │
     ←── scroll up = denoise ── scroll down = noise ──→
                  │               │               │
              (caption)       (caption)       (caption)
```

A single scroll position controls the noise level `t ∈ [0, T]` for *all three* variants
simultaneously. Scroll down = forward diffusion (noise increases). Scroll up = reverse
diffusion (denoise back to the structure at the top). Each panel reacts in real time:

- **Unconditional** — every CA drifts. By t=T, the whole panel is a cloud of points.
- **Motif scaffolding** — a chosen motif (we'll use ubiquitin's C-terminal `LRGG` tail —
  the docking motif used in ubiquitination — or alternatively the K48 lysine + its
  neighbors as a famous functional site) stays crystal-sharp at every t. The rest of the
  chain drifts. By t=T you see a sharp motif floating in noise.
- **Binder design** — we use ubiquitin in complex with a binding partner (e.g. a known
  ubiquitin-binding domain, or a designed mini-binder); the target chain stays sharp,
  the binder chain drifts. By t=T the target sits there with a noise cloud orbiting it.

The fan-out arrows from the top protein **literally embody the masking pattern** —
each arrow color-codes which atoms it's about to dissolve.

## What the reader takes away

After a few scrolls, the reader internalizes:

1. Diffusion training is a **noise-then-denoise** game. The model only ever sees noised
   inputs and is asked to predict the clean version.
2. **Conditioning = "what's not noised."** The set of atoms you choose to keep is the
   entire difference between modes. There's no special "binder head" or "motif head" —
   just a mask.
3. This is *why* RFdiffusion is so flexible: by changing the mask at inference, you get
   a different task without retraining.

That third bullet alone is worth the project. It's a thing people working *in* the field
get confused about.

## The bidirectional scroll mechanic

Two implementation options:

### Option A: scrollytelling (recommended)

Use `scrollama.js`. The viz section sticks to the viewport; as the user scrolls past it,
the page scroll *drives* the noise level. Once they scroll past the end of the section,
the page continues normally. This is the NYT/Pudding house style — readers know it.

- Pro: feels natural, doesn't fight the browser.
- Pro: lets us interleave prose with viz state. ("At this noise level, can you still see
  the helix? Keep scrolling.")
- Con: requires careful UX so users don't get trapped.

### Option B: explicit slider + scroll wheel capture

A horizontal slider sits at the top of the four-panel grid. The mouse wheel, when over
the grid, is captured and drives the slider. Scroll page normally when outside the grid.

- Pro: more explicit; user knows the slider exists.
- Con: scroll-jacking is widely hated.

**Lean: Option A.** Use Option B's slider as a *visible indicator* of where in the
trajectory we are, but drive it from scrollama.

## Data pipeline

We don't run any model in the browser. Everything is **pre-computed CA-coordinate
trajectories**.

1. **Hero: ubiquitin** (PDB `1UBQ`, 76 residues, classic β-grasp fold). Recognizable,
   tiny enough that 76 CA points read cleanly in 2D, and has obvious candidates for
   both a "motif" sub-region and a binding-partner story (ubiquitin-binding domains are
   well-characterized).
2. For each of the three variants, generate a forward-noising trajectory at ~50 noise
   levels evenly spaced in `t`. We don't need PDBs — only the CA coords per frame.
   - **Unconditional:** noise all 76 CAs with the schedule's σ(t).
   - **Motif scaffolding:** keep a chosen motif (e.g. residues 71–76, the LRGG tail, or
     K48 + neighbors) fixed at every t; noise the rest.
   - **Binder design:** include a ubiquitin-binding domain (e.g. from a UIM or UBA
     domain co-crystal); keep the binding-partner chain fixed, noise ubiquitin.
3. Pre-compute is trivial — no GPU needed since this is plain forward noising under a
   fixed schedule. A Python script with NumPy is enough.
4. **Output format.** A single JSON file `trajectories.json` with shape roughly:
   ```
   {
     "hero":  { "coords": [[x,y,z], ...], "motif_idx": [70,...,75] },
     "variants": {
       "uncond":  { "frames": [ [[x,y,z], ...], ... ] },   // 50 frames × 76 atoms
       "motif":   { "frames": [...], "kept_idx": [70,...,75] },
       "binder":  { "frames": [...], "target_coords": [...], "binder_idx": [...] }
     }
   }
   ```
   At 50 frames × ~76 atoms × 3 coords × 8 bytes ≈ 90 KB per variant. **Total well
   under 1 MB.** A pleasant change from the billboard project.

Forward noising is *vastly* easier than running the trained model. For the explorable, we
literally just need the *forward* trajectory — we never need to run denoising inference.
The reader's scroll *is* the denoising. This is a beautiful simplification.

### 2D projection

Since we're rendering in 2D, we project the 3D CA coordinates once (at t=0) using **PCA
onto the top-2 principal components** of the clean structure. We then apply *the same
projection matrix* to every noised frame, so the noise visually drifts in the same plane
that the structure was projected through. This keeps the visualization coherent — atoms
don't pop in and out of frame just because the projection shifted.

## Frontend stack

| Layer            | Choice                          | Why                                    |
|------------------|----------------------------------|----------------------------------------|
| Rendering        | **D3 + SVG (or canvas)**         | 2D CA-trace projection — points connected by the polypeptide backbone. SVG for ≤200 atoms, canvas if we ever go bigger. |
| Scroll           | scrollama.js                     | Industry-standard scrollytelling.      |
| Annotations      | D3 SVG overlays                  | Arrows from hero → variants; noise-level captions; motif highlighting. |
| Prose layout     | Plain HTML + a CSS grid          | Idyll is tempting but adds complexity. |

**No WebGL.** Going 2D-only sidesteps the WebGL-context problem entirely and gives the
page a uniform illustration-y feel. The visual aesthetic: 76 dots connected by a thin
polyline, colored along a gradient from N-terminus → C-terminus (paper palette: navaho
→ melon → pink → amaranth → coolgrey → blue → darkblue). At t=0 the polyline traces
the β-grasp fold; as t grows, the polyline becomes a "tangled string" and eventually a
point cloud.

## Decisions locked in

1. **Hero protein:** ubiquitin (PDB `1UBQ`).
2. **Rendering:** 2D CA-trace via D3 (no WebGL, no 3D viewer library).
3. **Number of variants:** three — unconditional, motif scaffolding, binder design.
4. **Hero swap:** out of scope for v1; single hero only.

## Still open

- **What's the prose doing?** Is each variant accompanied by a paragraph, or do we keep
  the page minimal and let the visuals carry it? Lean minimal.
- **Exact motif choice for ubiquitin.** C-terminal LRGG tail (functionally meaningful,
  visually a tail dangling off the fold) vs K48 + neighbors (involved in poly-Ub
  linkage). Tail is probably more legible.
- **Binder partner choice.** Pick a specific co-crystal — e.g. a UIM (ubiquitin-
  interacting motif) helix or a UBA domain. Need to find a PDB entry with clean
  coordinates.

## Risks

- **Scrollytelling UX.** First-time readers may not realize they should scroll. A clear
  "↓ scroll to noise / ↑ scroll to denoise" hint near the hero protein helps.
- **Pedagogical level.** The "training-not-inference" framing is exactly the right
  mental model but only if we sell it in the first few sentences. The intro copy is
  critical.
- **2D projection legibility.** A PCA projection of 76 atoms onto 2 dimensions may not
  faithfully convey the β-grasp fold. We may need to hand-tweak the projection axis or
  even use a known "good" view of ubiquitin (e.g. the canonical view in textbooks).

## MVP vs stretch

**MVP (proposal milestone, Wed 2/19):**
- Static page layout.
- Hero protein at top (3D, rotatable).
- Four greyed-out placeholder panels with captions only.

**Prototype milestone (Tue 3/4):**
- All three variants render real noised CA traces.
- Scrollytelling drives `t` for all panels in sync.
- Basic intro prose.

**Final deliverable (Tue 3/18):**
- Polished prose.
- Hover interactions on the hero protein (label motif residues, target/binder chains).
- Demo video (90 s).

## Next concrete steps

1. Write `scripts/noise_ubiquitin.py` — pull `1UBQ` CA coords, PCA-project once, then
   emit 50 forward-noised frames for each of the three variants into
   `public/data/trajectories.json`.
2. Pick the binder partner PDB (need a clean ubiquitin–partner co-crystal).
3. Stub `public/index.html`, `public/app.js`, `public/style.css` with the page skeleton:
   header, hero panel, three variant panels, scroll-driven `t` indicator.
4. Wire scrollama.js to drive the global `t` state; all four panels (hero + three
   variants) re-render on `t` change.
5. Write the intro paragraph that sells the training-vs-inference framing.
