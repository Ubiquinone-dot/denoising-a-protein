# Final Project Proposals — Explorable Explanations in Protein Design & Proteomics

CSE 442 final project. Theme: explorable explanation. Team: 3–4 people. Deliverable: deployed
interactive web page + 90-second demo video. Scope is "A3-sized but with more polish" —
one substantial interactive viz (or a small set of linked ones) interleaved with explanatory
copy in the Bret-Victor / Distill mold.

Below are six proposals at roughly comparable scope, ordered by my (Jasper's) rough
enthusiasm. Each is sized so a 3–4 person team can ship in ~4 weeks.

---

## 1. "Denoising a Protein" — RFdiffusion as an explorable

**Hook.** *How does a neural network design a protein from pure noise?* RFdiffusion (and
its successors RFD2/RFD3) literally take Gaussian-noise atomic coordinates and iteratively
denoise them into a coherent protein backbone. This is a stunning process to watch but
is currently locked inside Jupyter notebooks and Twitter GIFs.

**The viz.** A 3D protein viewer (NGL.js / Mol\*) in the center of the page. A horizontal
"diffusion time" slider runs from t=T (pure noise — backbone is a cloud) to t=0 (finished
design). As the user drags the slider:

- The backbone trace morphs through the denoising trajectory.
- A secondary panel shows the **noise schedule** (β_t curve) and where the cursor is on it.
- A contact map updates in real time, so the user sees "structure crystallizing" as off-
  diagonal blocks appear.
- Hover any residue → highlight its predicted neighbors and the radius of gyration ring.

**Conditioning is the punchline.** A toggle lets users switch between three conditioning
regimes:

1. *Unconditional* — let the model design whatever it wants.
2. *Motif scaffolding* — pin a known active site (e.g. the SH3 binding loop) and watch
   the model build a scaffold around it.
3. *Binder design* — pin a target protein on screen, watch a binder grow toward it.

**Where the data comes from.** Pre-computed trajectories from RFdiffusion. We'd generate
~20–30 trajectories ahead of time (covering the three regimes) and store them as a list of
PDB frames; the viewer interpolates. No model inference in the browser.

**Risk / scope notes.**

- Pro: I (Jasper) already run RFD-style pipelines, so trajectory generation is essentially
  free. The visual story sells itself.
- Pro: The explanation naturally layers — kids can drag the slider; biochemists can read
  the side-panel contact map; ML people can read the β-schedule.
- Con: Mol\*/NGL has a learning curve for the team. Frame interpolation between PDBs
  needs careful pre-processing (atom ordering must be consistent).
- Con: Diffusion models are "hot" — there is some risk of looking derivative of existing
  Distill-style writeups. We'd differentiate via *interactivity* (existing writeups are
  static GIFs).

**Why this could be the one.** Literally nothing on the public web today lets a user
*scrub* an RFdiffusion trajectory and *toggle conditioning regimes*. The closest thing is
the AlphaFold structure database, which is static. There's a real gap to fill.

---

## 2. "The Coevolution Trick" — from MSA columns to 3D contacts

**Hook.** *Before AlphaFold, how did we predict protein structure from sequence alone?*
The answer — co-evolving residues — is one of the most elegant insights in computational
biology, and it's totally visualizable. Two residues that are in contact in 3D must
co-evolve to remain stable, so columns in a multiple sequence alignment that co-vary
betray contacts in the folded structure.

**The viz.** Three linked panels:

1. **MSA panel.** A scrolling, colored multiple sequence alignment of a familiar protein
   (e.g. ubiquitin or a kinase). Each row is a homolog; each column a residue position.
2. **Co-evolution matrix.** A heatmap of mutual information (or DCA score) between every
   pair of columns. Click a cell → highlights the two columns in the MSA.
3. **3D structure.** The folded protein, with a line drawn between the residue pair that
   the user has selected. Watch contacts light up where co-evolution scores are highest.

**The "what if" interaction.** Let the user **mask MSA columns** (shift-click a range)
and watch the co-evolution matrix degrade in real time — and watch which contacts are
"lost." This teaches *why* MSA depth matters for predictors like AlphaFold.

A second toggle: "show only top-K predicted contacts vs. true contacts" — does
co-evolution actually recover the structure?

**Where the data comes from.** Pre-computed MSAs from Pfam or UniRef. Mutual information
or plmDCA scores computed offline. PDB structure for ground truth. ~5–10 MB of data; all
client-side.

**Risk / scope notes.**

- Pro: Pedagogically gorgeous. This is the canonical "aha" of protein bioinformatics.
- Pro: All three panels are 2D (the 3D viewer is a third-party widget) — no novel 3D
  graphics work needed.
- Con: Requires significant setup explaining what an MSA *is* — non-bio audiences need
  more onboarding.
- Con: The co-evolution insight has been somewhat eclipsed by AlphaFold in the public
  imagination; we'd need to frame this as "the idea AlphaFold is built on."

---

## 3. "The 20-Letter Alphabet" — a primer on amino acids

**Hook.** *Proteins are written in a 20-letter language. What does each letter do?*
Every biology textbook has the same dry table of 20 amino acids. We can do better.

**The viz.** An interactive "periodic table" of amino acids. Click a residue → its 3D
structure rotates in a side panel, with key properties labeled (hydrophobicity, pK_a,
charge, volume, secondary-structure propensity, BLOSUM substitution neighbors).

A secondary "sequence builder" lets the user type a short peptide; the viz shows:

- Predicted secondary structure (helix / sheet / coil) computed via a tiny in-browser
  model (or pre-cached from ESM2).
- A net hydrophobicity / charge plot.
- A "where in the cell would this end up?" indicator (signal peptide? transmembrane?
  cytoplasmic?) — informed by simple rules and visualized as a cartoon cell.

**The narrative.** Layered: "what is an amino acid," "what is a protein," "why are some
sequences functional and others junk."

**Risk / scope notes.**

- Pro: Approachable. Anyone can engage on day one.
- Pro: Modest data needs — all 20 amino acid structures are <5 KB each.
- Con: Risks feeling like a textbook unless we nail the *narrative* and *interactivity*.
  The 442 audience has seen "interactive periodic table" clones before.
- Con: Less "novel" than #1 or #2.

---

## 4. "Reading a Mass Spec" — from photon clouds to peptide sequences

**Hook.** *How does a mass spectrometer know what protein was in your blood sample?*
Proteomics' core inference loop is beautiful and totally unknown outside the field.

**The viz.** Two phases:

**Phase 1: forward simulation.** Start with a peptide (user-chosen from a short menu, or
typed). Show it being ionized, fragmented along its backbone, and producing a "b/y ion
ladder." A bar-chart spectrum builds up bar by bar as fragmentation proceeds. User can
hover any peak → see *which* fragment produced it.

**Phase 2: the inverse problem.** Show a "mystery" spectrum. The user tries to match it
to a peptide. We provide tools:

- Click two adjacent peaks → the difference is annotated as an amino acid mass (e.g.
  "Δ = 113.08 Da → Leu or Ile").
- A "search the database" button runs a real (in-browser) match against ~1000 candidate
  peptides and shows the score distribution.

**Narrative.** Built around a clinical scenario — "you have a blood sample, what's in it?"

**Risk / scope notes.**

- Pro: A genuine inferential puzzle that the user *solves*. Very gameful.
- Pro: 1D spectra are easy to render in D3.
- Con: The b/y ion notation requires real onboarding. Easy to lose lay readers.
- Con: Less visually striking than #1 or #2.

---

## 5. "What Makes a Binder?" — an interactive tour of protein-protein interfaces

**Hook.** *Why do some proteins stick together and others don't?* Drug discovery is
substantially the problem of designing a molecule that binds a target. The interface
itself is a beautiful object: shape-complementary, hydrophobic-packed, hydrogen-bond-
satisfied.

**The viz.** A 3D structure of a known binder-target pair (e.g. PD-1/PD-L1, an antibody-
antigen complex, or a designed mini-binder from David Baker's lab). The user can:

- Rotate, zoom.
- Toggle layers: hydrogen bonds (dashed lines), hydrophobic packing (van der Waals
  surfaces), salt bridges (charged residue pairs).
- Hover any interface residue → side panel shows its contribution to ΔG (computed
  offline by FoldX or Rosetta).
- *Mutate* an interface residue (click → drop-down of 19 alternatives) → see the
  predicted ΔΔG change, and watch the interface "relax" using a pre-computed alanine
  scan / saturation mutagenesis table.

**Narrative.** "Three classic binders, three different strategies." Walk through:

1. An antibody-antigen complex (CDR loops).
2. A natural protein-protein interface (PD-1 / PD-L1, immune checkpoint).
3. A *designed* mini-binder (de novo, from RFdiffusion or hallucination).

The punchline: designed binders look subtly different from natural ones, and that's a
sign of how far the field has come.

**Risk / scope notes.**

- Pro: Visually arresting. Interface chemistry photographs beautifully.
- Pro: Mutation interaction is a clear "verb" for the user.
- Con: Requires a 3D viewer and substantial pre-computation (alanine scans for each of
  the 3 complexes).
- Con: Overlaps thematically with #1 ("designed binders") — we'd want to pick one of the
  two, not both.

---

## 6. "Sequence Space" — exploring an ESM2 embedding atlas

**Hook.** *If proteins are points in a high-dimensional space, what does that space look
like?* Modern protein language models (ESM2, ProtT5) embed every protein sequence into a
~1280-dim vector. Project those vectors to 2D and you get a beautiful, fold-clustered
atlas where similar sequences cluster, sometimes for non-obvious reasons.

**The viz.** A scatterplot (canvas, ~10–50k points) of ESM2 embeddings projected via
UMAP. Each point is a protein. Color by:

- Pfam family (categorical).
- Length (continuous).
- Predicted disorder (continuous).

Click any point → side panel shows the sequence, predicted structure (ESMFold cache or
AlphaFold-DB lookup), Pfam annotation.

**The "what if."** A search box: paste any sequence, embed it client-side (with a tiny
ESM2 model, or via API call to ESM Atlas), watch where your sequence lands in the atlas.

**Risk / scope notes.**

- Pro: Beautiful, NameVoyager-style "exploration of a space" — analogous to my A3.
- Pro: Pre-computed UMAPs from ESM Atlas exist and are downloadable.
- Con: In-browser sequence embedding is probably impossible (ESM2 is too large). We'd
  rely on a pre-computed atlas only — limits novelty.
- Con: Risks feeling like "Embedding Projector for proteins."

---

## Comparison matrix

| #   | Idea                       | Wow factor | Data risk | 3D risk | Team familiarity (mine) |
|-----|----------------------------|------------|-----------|---------|--------------------------|
| 1   | RFdiffusion denoising      | ★★★★★      | Low       | High    | ★★★★★                    |
| 2   | Co-evolution → contacts    | ★★★★       | Low       | Low     | ★★★★                     |
| 3   | Amino acid alphabet        | ★★         | Low       | Low     | ★★★★                     |
| 4   | Mass spec inversion        | ★★★        | Low       | None    | ★★                       |
| 5   | Binders & interfaces       | ★★★★       | Medium    | High    | ★★★★                     |
| 6   | ESM2 embedding atlas       | ★★★        | Medium    | Low     | ★★★                      |

## My (Jasper's) recommendation

**Lead candidate: #1 (RFdiffusion denoising).** It's the most visually striking, has the
fewest existing competitors on the web, and my background means trajectory generation is
essentially free. The main risk is 3D-viewer learning curve, but Mol\* / NGL.js are
well-documented and a 3–4 person team can absorb one viewer-specialist.

**Backup: #2 (coevolution).** If the 3D risk on #1 scares the team, coevolution is a
pure-2D project with the same pedagogical depth.

**Combine?** A small portion of #1's "binder design" mode overlaps with #5; if we want
both we could do "design a binder *and* understand the interface" as a unified narrative,
but that's probably 2× the scope.

## Next steps

1. Vote on top two by Wed.
2. Pick one. Get the gitlab repo from course staff. Lock in.
3. Identify required pre-computation jobs (RFdiffusion trajectories OR MSA + DCA scores).
   I can run these on the HT25 cluster.
4. Sketch wireframes — single-page Idyll-style layout with the main viz pinned and prose
   alongside.
5. Pick one viewer library (Mol\* vs NGL.js for #1, plain D3 + heatmap for #2).
