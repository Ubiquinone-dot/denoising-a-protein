# CSE 512 — Final Project Proposal

This document mirrors the responses submitted to the CSE 512 Spring 2026 Final
Project Registration form.

---

## Registration form responses

**Email** &nbsp;·&nbsp; `jbutch@uw.edu`

**Project Name** &nbsp;·&nbsp; Noising and Denoising Proteins

**Project Abstract** (≤ 200 words)

> Diffusion-based generative models — RFdiffusion, RFD3, Chroma, AlphaFold3 —
> have transformed protein design in the last three years. However, their
> training procedure remains under-explained outside the field: public-facing
> visualizations show a noise cloud miraculously denoising into a protein,
> hiding the recipe that actually shapes what the model can do. In particular,
> the way in which we train diffusion models involves tricks of data
> augmentation, which are unlike how traditional ML models are trained. With
> this project, we hope to elucidate some of the design components involved
> in training such diffusion models, giving the reader a deeper understanding
> of how modern protein structure modelling is tokenized.

### Team Member 1

- **Name:** Jasper Butcher
- **UW Email:** jbutch@uw.edu
- **GitLab Username (UWNetID):** jbutch

_Solo team — members 2–4 left blank._

---

## Live prototype

A working scroll-driven prototype is already deployed and serves as the
milestone-review artifact:

- **Page:** https://ubiquinone-dot.github.io/denoising-a-protein/
- **Repo:** https://github.com/Ubiquinone-dot/denoising-a-protein

The prototype currently includes:

1. **EDM (Karras / RFD3) section.** Engrailed homeodomain (PDB 1ENH, 54
   residues) rendered as an NGL cartoon ribbon. Progressive reveal — the
   unconditional panel noises alone in the first scroll phase, then motif
   scaffolding and binder design panels fade in for the second phase. EDM
   constants (σ\_data = 16, σ\_min = 4 × 10⁻⁴, σ\_max = 160, ρ = 7) match
   the RFD3 codebase exactly.
2. **Flow-matching section.** The same three masking recipes shown as
   straight-line interpolations between the clean structure (t = 0) and a
   fixed σ = 12 Å Gaussian cloud (t = 1). The bounded-variance character
   of flow matching contrasts visually with EDM's exploding schedule.

The data pipeline (`scripts/noise_ubiquitin.py`) generates all trajectories
offline; the page is fully static (HTML + D3 + NGL.js + a 320 KB JSON of
pre-computed coords).

---

## Remaining work for the final deliverable

| Date            | Milestone                              |
|-----------------|----------------------------------------|
| Tue **6 / 2**   | 90-second demo video                   |
| Mon **6 / 8**   | Final deliverable on CSE 512 GitLab    |

Planned additions before final submission:

- **A third section** showing inference (denoising), so the reader sees not
  just the training-side noising but the trained model's reverse process.
  Likely candidates: actual RFD3 inference frames, or a stylized
  velocity-field visualization for flow matching.
- **Tighter narrative prose** — current copy is functional but bare-bones.
  Aim for Distill-style interleaving of paragraphs and visualizations.
- **An "embedding atlas" coda** showing where popular benchmark proteins
  (ubiquitin, GFP, designed binders) land in ESM2 sequence space —
  contextualizes the small protein chosen for the explorable.
- **Mirror to the assigned CSE 512 GitLab repo** with the GitLab Pages
  CI/CD workflow once that repo is provisioned by the course staff.
