"""Generate EDM-style forward-noising trajectories of a small protein for the
explorable explanation page.

Current hero: engrailed homeodomain (PDB 1ENH), a 54-residue three-helix
bundle. Clean and iconic.

Pipeline:
  1. Fetch HERO_PDB from RCSB and parse its CA atoms.
  2. PCA-project the clean hero onto its top-2 principal components, and
     reuse that projection matrix for every noised frame so atoms drift
     coherently in the same plane.
  3. Synthesize a "stylized target" partner chain by taking a slice of the
     hero (helix 1) and translating it to the side in 2D. This is a
     placeholder for a real binding partner -- it lets the binder variant
     have something to be "fixed against" without committing to a specific
     binder co-crystal yet.
  4. Apply EDM forward noising (Karras et al. 2022, RFD3 parameterization)
     at N_FRAMES noise levels for each of three variants:
       - unconditional : noise every CA on the hero
       - motif         : keep one alpha helix fixed, noise the rest
       - binder        : noise the entire hero; partner stays fixed
  5. Emit a single compact JSON at public/data/trajectories.json.

EDM constants match RFD3 (Karras schedule), found in
  ~/Projects/foundry/models/rfd3/configs/model/samplers/edm.yaml
  ~/Projects/foundry/.venv/.../atomworks/ml/transforms/diffusion/edm.py

    sigma_data = 16          # Å scale of CA coordinates
    sigma_min  = 4e-4
    sigma_max  = 160
    rho        = 7

The Karras inference schedule maps a clean -> noisy progress fraction
tau in [0, 1] to

    sigma(tau) = sigma_data * (
        sigma_min^(1/rho) + tau * (sigma_max^(1/rho) - sigma_min^(1/rho))
    )^rho

so that sigma(0) = sigma_data * sigma_min  (basically clean)
        sigma(1) = sigma_data * sigma_max  (structure dissolved into a cloud).

Note: with rho = 7 this schedule is extremely non-linear; most of the
"visually interesting" range (sigma in [0.5, 50] Å for ubiquitin) sits in
roughly the second half of tau.

Forward noise rule (matches atomworks/ml/.../edm.py):

    x_noised = x_clean + sigma * eps,    eps ~ N(0, 1)

applied per-atom on raw xyz. For motif / binder modes the noise is zeroed
for the fixed atoms (i.e. x_noised[fixed] = x_clean[fixed]).
"""

from __future__ import annotations

import json
import urllib.request
from pathlib import Path

import numpy as np

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Engrailed homeodomain (54 aa, 3-helix bundle, X-ray).  Single chain.
HERO_PDB = "1ENH"
HERO_LEN_TARGET = 54

N_FRAMES = 50

# EDM (Karras / RFD3) constants.  See module docstring for provenance.
SIGMA_DATA = 16.0
SIGMA_MIN = 4e-4
SIGMA_MAX = 160.0
RHO = 7.0

# Motif kept fixed in the "motif scaffolding" variant: helix 2 of the
# engrailed homeodomain.  PDB 1ENH numbering (3-59); helix 2 spans roughly
# residues 28-38 (the "recognition helix" in DNA-binding homeodomains -- it's
# the one that inserts into the major groove).  Picking this gives a single
# distinctive ~11-residue arc that stays put in the middle of the panel.
MOTIF_RESIDUES = list(range(28, 39))  # PDB residue numbering, 1-indexed

# Stylized partner for the binder variant.  We don't have a real co-crystal
# (1ENH binds DNA), so we synthesize a placeholder by copying helix 1 of the
# bundle and translating it to the side in PCA-projected 3D space.  Z is
# preserved so the partner has the same depth structure as helix 1, giving
# it a sense of solidity in the depth-shaded renderer.
PARTNER_SLICE_RESIDUES = list(range(10, 23))  # helix 1
PARTNER_OFFSET_3D = (-32.0, 4.0, 0.0)  # Å, in PCA-projected 3D coordinates

RNG_SEED = 0

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "public" / "data" / "trajectories.json"


# ---------------------------------------------------------------------------
# PDB fetch & parse
# ---------------------------------------------------------------------------


def fetch_pdb(pdb_id: str) -> str:
    """Download a PDB-format file from RCSB."""
    url = f"https://files.rcsb.org/download/{pdb_id}.pdb"
    print(f"  GET {url}")
    with urllib.request.urlopen(url, timeout=30) as response:
        return response.read().decode("utf-8")


def parse_chains(pdb_text: str) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    """Parse every chain's CA atoms.

    Returns {chain_id: (resnums [N], xyz [N, 3])}.

    - Only ATOM records (skips HETATM, so we ignore waters / ligands).
    - Only the first MODEL is read (NMR ensembles -> single conformer).
    - Only the first alternate location ('' or 'A') per residue.
    """
    chains: dict[str, dict[int, tuple[int, np.ndarray]]] = {}
    in_first_model = True

    for line in pdb_text.splitlines():
        if line.startswith("MODEL"):
            # If we've already read model 1, skip subsequent models entirely.
            model_id = int(line[10:14].strip() or "1")
            in_first_model = model_id == 1
            continue
        if line.startswith("ENDMDL"):
            in_first_model = False
            continue
        if not in_first_model:
            continue
        if not line.startswith("ATOM"):
            continue
        atom_name = line[12:16].strip()
        if atom_name != "CA":
            continue
        altloc = line[16]
        if altloc not in (" ", "A"):
            continue
        chain_id = line[21]
        resnum = int(line[22:26])
        xyz = np.array(
            [float(line[30:38]), float(line[38:46]), float(line[46:54])]
        )
        # First-altloc wins; dict key is resnum so duplicates are silently
        # dropped (which is what we want for altloc handling).
        chains.setdefault(chain_id, {})
        if resnum not in chains[chain_id]:
            chains[chain_id][resnum] = (resnum, xyz)

    out: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    for chain_id, res_dict in chains.items():
        ordered = sorted(res_dict.values(), key=lambda x: x[0])
        resnums = np.array([r for r, _ in ordered], dtype=int)
        coords = np.stack([xyz for _, xyz in ordered])
        out[chain_id] = (resnums, coords)
    return out


def pick_hero_chain(
    chains: dict[str, tuple[np.ndarray, np.ndarray]],
) -> str:
    """Pick the chain whose length is closest to HERO_LEN_TARGET."""
    if not chains:
        raise ValueError("No chains parsed from PDB")
    return min(chains, key=lambda c: abs(len(chains[c][0]) - HERO_LEN_TARGET))


# ---------------------------------------------------------------------------
# PCA projection
# ---------------------------------------------------------------------------


def pca_projection(coords3d: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Compute (center, basis) so that coords_pc = (coords3d - center) @ basis.

    basis is shape (3, 3): all three principal components.  The renderer uses
    the first two as (x, y) for SVG layout and the third as depth (z) for
    sphere shading and z-order sorting.
    """
    center = coords3d.mean(axis=0)
    centered = coords3d - center
    # SVD on centered (N, 3): Vt rows are principal directions, ordered by
    # decreasing singular value.  We keep all three so the third dimension
    # (smallest variance, perpendicular-to-page) can drive depth cues.
    _, _, vt = np.linalg.svd(centered, full_matrices=False)
    return center, vt.T  # (3, 3)


def project(
    coords3d: np.ndarray, center: np.ndarray, basis: np.ndarray
) -> np.ndarray:
    """Apply the (center, basis) projection to coordinates.

    Works for any leading shape: (..., 3) -> (..., 3).  Returned components
    are (x, y, z) in PCA space.
    """
    return (coords3d - center) @ basis


# ---------------------------------------------------------------------------
# EDM noising
# ---------------------------------------------------------------------------


def sigma_schedule(n_frames: int) -> np.ndarray:
    """Karras EDM sigma schedule with tau = 0 ≈ clean and tau = 1 = pure noise.

        sigma(tau) = sigma_data * (a + tau * (b - a))^rho
        where a = sigma_min^(1/rho), b = sigma_max^(1/rho)
    """
    tau = np.linspace(0.0, 1.0, n_frames)
    a = SIGMA_MIN ** (1.0 / RHO)
    b = SIGMA_MAX ** (1.0 / RHO)
    return SIGMA_DATA * (a + tau * (b - a)) ** RHO


def noise_frames(
    coords3d: np.ndarray,
    sigmas: np.ndarray,
    mask_fixed: np.ndarray | None,
    rng: np.random.Generator,
) -> np.ndarray:
    """Generate (n_frames, n_atoms, 3) forward-noised CA coordinates.

    Forward rule (atomworks EDM):
        x_t = x_0 + sigma_t * eps,    eps ~ N(0, 1)
    Masked (fixed) atoms have eps zeroed -> x_t[fixed] = x_0[fixed].
    """
    n_atoms = coords3d.shape[0]
    n_frames = sigmas.shape[0]
    noise = rng.standard_normal(size=(n_frames, n_atoms, 3))
    if mask_fixed is not None:
        noise[:, mask_fixed, :] = 0.0
    return coords3d[None, :, :] + sigmas[:, None, None] * noise


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    print(f"Fetching {HERO_PDB} from RCSB ...")
    pdb_text = fetch_pdb(HERO_PDB)

    print("Parsing chains ...")
    chains = parse_chains(pdb_text)
    for cid, (resnums, coords) in chains.items():
        print(
            f"  chain {cid}: {len(resnums):3d} CAs  "
            f"resnums {resnums.min()}-{resnums.max()}"
        )

    hero_id = pick_hero_chain(chains)
    print(f"  -> hero = chain {hero_id}")

    hero_resnums, hero_coords = chains[hero_id]

    if len(hero_resnums) != HERO_LEN_TARGET:
        # Not fatal -- some PDBs have a few resolved residues missing -- but
        # surface it loudly so we don't silently lose atoms.
        print(
            f"  WARNING: hero chain has {len(hero_resnums)} CAs, "
            f"expected {HERO_LEN_TARGET}"
        )

    # ----- PCA projection of the clean hero (shared by every frame) -------
    center, basis = pca_projection(hero_coords)
    hero_pc = project(hero_coords, center, basis)
    print(
        f"  PCA basis ready.  hero 3D bbox: "
        f"x in [{hero_pc[:, 0].min():.1f}, {hero_pc[:, 0].max():.1f}]  "
        f"y in [{hero_pc[:, 1].min():.1f}, {hero_pc[:, 1].max():.1f}]  "
        f"z in [{hero_pc[:, 2].min():.1f}, {hero_pc[:, 2].max():.1f}]"
    )

    # ----- synthesize the partner -----------------------------------------
    # We don't have a real co-crystal; build a placeholder "target" by
    # copying a slice of the hero (one of its helices) and translating it
    # in PCA-projected 3D space.  Z is preserved so the partner has the
    # same depth structure as helix 1.
    partner_mask = np.isin(hero_resnums, PARTNER_SLICE_RESIDUES)
    if partner_mask.sum() == 0:
        raise ValueError(
            f"PARTNER_SLICE_RESIDUES={PARTNER_SLICE_RESIDUES} not found "
            f"in hero chain {hero_id} "
            f"(resnums {hero_resnums.min()}-{hero_resnums.max()})"
        )
    partner_resnums = hero_resnums[partner_mask]
    partner_pc = hero_pc[partner_mask] + np.array(PARTNER_OFFSET_3D)
    print(
        f"  synthesized partner: {partner_mask.sum()} atoms "
        f"(hero residues {partner_resnums.tolist()}), 3D offset {PARTNER_OFFSET_3D}"
    )

    # ----- sigma schedule --------------------------------------------------
    sigmas = sigma_schedule(N_FRAMES)
    print(
        f"  sigma schedule: "
        f"sigma[0]={sigmas[0]:.4f}  "
        f"sigma[mid]={sigmas[N_FRAMES // 2]:.4f}  "
        f"sigma[-1]={sigmas[-1]:.4f}"
    )

    # ----- motif mask ------------------------------------------------------
    motif_mask = np.isin(hero_resnums, MOTIF_RESIDUES)
    kept_resnums = hero_resnums[motif_mask].tolist()
    print(
        f"  motif mask: {motif_mask.sum()} atoms fixed "
        f"(resnums {kept_resnums})"
    )
    if motif_mask.sum() == 0:
        raise ValueError(
            f"Motif mask is empty.  MOTIF_RESIDUES={MOTIF_RESIDUES} not "
            f"found in chain {hero_id} "
            f"(resnums {hero_resnums.min()}-{hero_resnums.max()})"
        )

    # ----- variants --------------------------------------------------------
    rng = np.random.default_rng(RNG_SEED)
    print("Generating variants ...")
    print("  unconditional ...")
    uncond_3d = noise_frames(hero_coords, sigmas, mask_fixed=None, rng=rng)
    print("  motif scaffolding ...")
    motif_3d = noise_frames(hero_coords, sigmas, mask_fixed=motif_mask, rng=rng)
    print("  binder design ...")
    # In binder mode the hero chain is noised (no internal mask); the
    # synthesized partner stays fixed at every frame.
    binder_3d = noise_frames(hero_coords, sigmas, mask_fixed=None, rng=rng)

    # Project each frame to PCA 3D space with the same (center, basis).
    uncond_pc = project(uncond_3d, center, basis)
    motif_pc = project(motif_3d, center, basis)
    binder_pc = project(binder_3d, center, basis)

    # NaN / Inf sanity check (per project policy: never silently drop).
    for name, arr in [
        ("uncond", uncond_pc),
        ("motif", motif_pc),
        ("binder", binder_pc),
    ]:
        if not np.isfinite(arr).all():
            n_bad = (~np.isfinite(arr)).sum()
            raise ValueError(f"{n_bad} non-finite values in '{name}' frames")

    # ----- serialize -------------------------------------------------------
    def round_arr(arr: np.ndarray, decimals: int = 2):
        return np.round(arr, decimals).tolist()

    out = {
        "pdb_id": HERO_PDB,
        "n_frames": N_FRAMES,
        "edm": {
            "sigma_data": SIGMA_DATA,
            "sigma_min": SIGMA_MIN,
            "sigma_max": SIGMA_MAX,
            "rho": RHO,
            "sigmas": sigmas.round(4).tolist(),
        },
        "hero": {
            "chain": hero_id,
            "resnums": hero_resnums.tolist(),
            "coords_3d": round_arr(hero_pc),
            "motif_resnums": kept_resnums,
        },
        "partner": {
            "synthesized": True,
            "from_hero_resnums": partner_resnums.tolist(),
            "coords_3d": round_arr(partner_pc),
        },
        "variants": {
            "uncond": {"frames": round_arr(uncond_pc)},
            "motif": {
                "frames": round_arr(motif_pc),
                "kept_resnums": kept_resnums,
            },
            "binder": {"frames": round_arr(binder_pc)},
        },
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print(f"Wrote {OUT}  ({OUT.stat().st_size / 1024:.1f} KB)")


if __name__ == "__main__":
    main()
