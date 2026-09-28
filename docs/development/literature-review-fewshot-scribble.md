# Literature Review — Few-Shot Learning, Active Learning, Online Learning & Scribble Prompting

*Compiled for Didascalie — with an eye toward a self-contained, no-Python-for-the-user, few-shot interactive annotator that adapts to the annotator's style on hard domains (e.g. fundus).*

**Reading lens.** Throughout, "promising" is judged for that specific goal, weighting three things: annotation-throughput impact × feasibility in a Rust/ONNX stack × fit to fundus resolution (thin vessels, microaneurysms). A method that is SOTA on a benchmark but un-shippable in-app is ranked below a humbler one that can actually be built.

**Feasibility legend**
- 🟢 fully in-app, no gradient training
- 🟡 in-app but needs a heavier model (e.g. SAM2) or GPU inference
- 🔴 needs a real training loop (Python / offline side, e.g. pydidascalie)

---

## Table of Contents

1. [Few-shot fine-tuning of neural networks](#1-few-shot-fine-tuning-of-neural-networks)
2. [Few-shot / low-budget active learning](#2-few-shot--low-budget-active-learning)
3. [Online learning](#3-online-learning)
4. [The unifying thread: training-free feature reuse](#4-the-unifying-thread-training-free-feature-reuse)
5. [Top 10 most promising approaches (ranked)](#5-top-10-most-promising-approaches-ranked)
6. [Scribble prompting — three lineages](#6-scribble-prompting--three-lineages)
7. [Overall synthesis & recommendations](#7-overall-synthesis--recommendations)

---

## 1. Few-shot fine-tuning of neural networks

The field splits into two camps: **gradient-based parameter-efficient fine-tuning (PEFT)** and **training-free / cache adapters**. The second is the one that matters for a no-autograd, in-app path.

### PEFT (needs a training loop → implies Python/GPU) 🔴
- **Silva-Rodríguez et al., "Towards Foundation Models and Few-Shot PEFT for Volumetric Organ Segmentation," Medical Image Analysis 2025** — [arXiv 2303.17051](https://arxiv.org/abs/2303.17051) · [code](https://github.com/jusiro/fewshot-finetuning). Reference point for few-shot medical seg via LoRA / AdaptFormer / black-box adapters; matches full fine-tuning at a fraction of the parameters. Best-paper at MedAGI'23.
- **Mixture-of-LoRA-experts / magnitude-based LoRA** — [arXiv 2507.06558](https://arxiv.org/pdf/2507.06558).
- **Curated landscape** — [Awesome-PEFT-for-Foundation-Models](https://github.com/THUDM/Awesome-Parameter-Efficient-Fine-Tuning-for-Foundation-Models).

### Training-free / cache adapters (fit a light head on frozen features — no backprop) 🟢
- **Tip-Adapter (ECCV 2022)** — [arXiv 2207.09519](https://arxiv.org/abs/2207.09519). The seminal idea: build a key–value cache from the few-shot support set; classify a test feature by similarity to cached keys. Training-free yet competitive with fine-tuned adapters; optionally unfreeze the cache for a small boost. **Essentially the algorithm to port to Rust.**
- **Proto-Adapter (Sensors 2024)** — [MDPI](https://www.mdpi.com/1424-8220/24/11/3624). Collapses the cache into class prototypes; cheaper and cleaner.

### Foundation-model few-shot adaptation for medical / interactive segmentation
- **FATE-SAM — Few-Shot Adaptation of a Training-Free Foundation Model for 3D Medical Segmentation** — [arXiv 2501.09138](https://arxiv.org/abs/2501.09138). Adapts SAM2 with a few support volumes, no fine-tuning. 🟡
- **Retrieval-augmented Few-shot Medical Segmentation** — [arXiv 2408.08813](https://arxiv.org/abs/2408.08813). Retrieve similar support examples to condition the model. 🟢/🟡
- **"Adapting Foundation Models for Few-Shot Medical Segmentation, Actively and Sequentially"** — [arXiv 2502.01000](https://arxiv.org/abs/2502.01000). Explicitly couples few-shot FM adaptation with active learning.
- **Review — Few-Shot Learning for Medical Image Segmentation (ACM Computing Surveys 2025)** — [doi](https://dl.acm.org/doi/10.1145/3746224). The current map of the subfield, 2019 → 2025.

---

## 2. Few-shot / low-budget active learning

Key modern finding: at **tiny** budgets, naive uncertainty sampling *fails* (cold-start); **typicality / diversity wins first**, then uncertainty takes over as the labeled pool grows.

- **TypiClust** — [arXiv 2505.19404 (federated study)](https://arxiv.org/html/2505.19404). On self-supervised features, pick *typical* (high-density) samples per cluster instead of uncertain ones. Still the low-budget baseline to beat.
- **DEUCE (2025)** — [arXiv 2502.00305](https://arxiv.org/pdf/2502.00305). Dual diversity + uncertainty for cold-start AL.
- **MedCAL-Bench (2025)** — [arXiv 2508.03441](https://arxiv.org/pdf/2508.03441). A dedicated benchmark for *cold-start* AL in medical imaging.
- **Survey — Deep Active Learning in Medical Image Analysis** — [arXiv 2310.14230](https://arxiv.org/pdf/2310.14230).

### Segmentation-specific (region / superpixel budgets — most relevant) 🟢
- **Dynamic-budget superpixel AL for semantic segmentation (Frontiers in AI 2024)** — [PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC11754207/). Query a *variable* number of high-uncertainty superpixels per image; +5.6% mIoU over static budgets at low budget. Maps 1:1 onto a superpixel-based UI.
- **Diffusion-Driven Two-Stage Low-Budget AL (NeurIPS 2025)** — [proceedings](https://proceedings.neurips.cc/paper_files/paper/2025/hash/208c5f815d330f6ca13df32dea63d735-Abstract-Conference.html). Decouple diversity (stage 1) from uncertainty (stage 2); strong at extreme pixel budgets.
- **nnActive (2025)** — [arXiv 2511.19183](https://arxiv.org/pdf/2511.19183). nnU-Net-style standardized evaluation framework for 3D biomedical AL.
- **A²LC — Active & Automated Label Correction (2025)** — [arXiv 2506.11599](https://arxiv.org/pdf/2506.11599). Active *label correction* (fix model drafts) — the "correct the pre-label" loop.

**Takeaway.** For low-budget segmentation AL, the current best recipe is **superpixel-level, dynamic-budget, typicality → uncertainty scheduling** — and it is the recipe most compatible with a classical in-app classifier.

---

## 3. Online learning

For this use case, "online learning" mostly appears as **continual test-time adaptation (CTTA)** — adapting a *deployed* network to a shifting stream without labels. Conceptually adjacent but heavier than an in-app few-shot learner.

- **BECoTTA (ICML 2024)** — input-dependent online mixture-of-experts for CTTA.
- **TEGDA (MICCAI 2025)** — [paper](https://papers.miccai.org/miccai-2025/0906-Paper2263.html). Evaluation-guided dynamic adaptation for *medical* segmentation under domain shift; continual and online.
- **Domain Consistency Learning for CTTA (Pattern Recognition 2025)** — [ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0031320325002456).
- **Confidence-guided adaptive CTTA (2026)** — [ScienceDirect](https://www.sciencedirect.com/science/article/pii/S2405959526000640).
- **Tracking list** — [awesome-test-time-adaptation](https://github.com/tim-learn/awesome-test-time-adaptation) (OTTA / CTTA / SFDA branches).

**Honest note.** CTTA adapts BatchNorm / prompt / expert params of a big net online — it assumes you *have* that net. It does not give a from-scratch, few-scribble learner. For that, the relevant "online learning" is classical **incremental / streaming classifiers** (online logistic regression, Mondrian / streaming random forests, Hoeffding trees): mature, CPU-cheap, Rust-portable — exactly what an in-app learner would use. 🟢

---

## 4. The unifying thread: training-free feature reuse

The recurring 2024–2026 result: **a frozen ViT encoder + a non-gradient head (prototype / nearest-neighbor / linear) gives competitive few-shot segmentation with zero training.** This is the strongest evidence that a no-Python, in-app path is viable.

- **AnomalyDINO (WACV 2025)** — [arXiv 2405.14529](https://arxiv.org/abs/2405.14529). Patchwise nearest-neighbor matching in frozen DINOv2 space → SOTA one/few-shot *dense* segmentation, fully training-free. Cleanest template for "encoder in ONNX, matcher in Rust."
- **FSSDINO / "Semantic Selection Gap in DINOv3"** — [arXiv 2602.07550](https://arxiv.org/html/2602.07550v1). Class-prototype segmentation on frozen DINOv3 features.
- **DINOv2-powered Few-Shot Semantic Segmentation** — [arXiv 2504.15669](https://arxiv.org/html/2504.15669v2).
- **"No time to train!" — Training-Free Reference-Based Instance Segmentation** — [arXiv 2507.02798](https://arxiv.org/html/2507.02798).
- **SANSA — unlocking SAM2's latent semantics for few-shot** — [arXiv 2505.21795](https://arxiv.org/pdf/2505.21795). 🟡
- **SegGPT — Segmenting Everything in Context** — [arXiv 2304.03284](https://arxiv.org/abs/2304.03284). One prompt image+mask → same segmentation on new images, no weight updates. 85.6 mIoU one-shot on FSS-1000. 🟡
- **DINO-MVR** — [arXiv 2605.07221](https://arxiv.org/pdf/2605.07221) · **MRI-CORE** — [arXiv 2506.12186](https://arxiv.org/pdf/2506.12186). Frozen-backbone, annotation-efficient medical segmentation.

> **The fundus caveat.** Every DINO-based method here operates on **patch-level features** (14–16 px stride) — precisely the resolution problem for thin vessels and microaneurysms. The literature *validates the mechanism* (frozen features + light head) but *confirms the resolution gap* for the hardest structures. This is why the recommended design is **hybrid**: frozen deep features (semantic) **concatenated with** full-resolution classical filters (vesselness / color), fed to a cheap classifier — none of which needs a gradient step.

---

## 5. Top 10 most promising approaches (ranked)

Ranked *for the Didascalie goal* (self-contained, few-shot, fundus), not by generic citation count.

1. **Hybrid frozen-features ⊕ full-res classical-filter classifier** 🟢
   Concatenate deep semantic features (SAM/DINO ONNX encoder, upsampled) with full-resolution classical filters (Frangi vesselness, green-channel/LAB, multi-scale Hessian) → a cheap head. **Best fit for fundus** because it fixes the one thing every DINO method can't: patch-resolution loss. Synthesis of §4; mechanism validated throughout.

2. **Tip-Adapter / Proto-Adapter cache head, densified** 🟢
   Build a key–value cache (or class prototypes) from the annotator's scribbles; classify each pixel/superpixel by similarity. Training-free, milliseconds to fit, trivially portable to Rust. The concrete "learns your style with no backprop" engine. — [Tip-Adapter](https://arxiv.org/abs/2207.09519) · [Proto-Adapter](https://www.mdpi.com/1424-8220/24/11/3624)

3. **AnomalyDINO-style patchwise nearest-neighbor matching** 🟢
   Frozen DINOv2 features + patchwise kNN → SOTA one/few-shot *dense* segmentation, training-free. Clean "encoder in ONNX, matcher in Rust" template. Caveat: patch resolution (why #1 hybridizes it). — [AnomalyDINO](https://arxiv.org/abs/2405.14529) · [FSSDINO](https://arxiv.org/html/2602.07550v1)

4. **Dynamic-budget superpixel active learning + typicality-first schedule** 🟢
   The "active" half. Query a *variable* number of high-value superpixels per image; start typical/diverse (cold-start), shift to uncertainty as the pool grows. +5.6% mIoU at low budget. — [Dynamic-budget superpixel AL](https://pmc.ncbi.nlm.nih.gov/articles/PMC11754207/) · [TypiClust](https://arxiv.org/html/2505.19404)

5. **Filter-bank + incremental / streaming classifier (modern ilastik)** 🟢
   The *online-learning* engine: online logistic regression or a Mondrian / streaming random forest over the filter stack, refit live as scribbles arrive. Old idea, unbeaten for CPU-cheap interactive per-project learning; pairs with #1 as the head.

6. **FATE-SAM: training-free few-shot SAM2 memory-bank prompting** 🟡
   Drop a few support masks into a memory bank; segment new frames with no fine-tuning. Very promising *if* SAM2 is adopted, and it naturally exploits frame sequences. — [FATE-SAM](https://arxiv.org/abs/2501.09138)

7. **Retrieval-augmented few-shot (support retrieval from the project store)** 🟢/🟡
   Store past scribble→mask examples; for a new frame, retrieve the most similar support and match. This *is* the "project remembers how you segment" story, and composes with #2/#3/#6. — [Retrieval-aug few-shot med seg](https://arxiv.org/abs/2408.08813)

8. **SANSA: unlocking SAM2's latent semantics for few-shot** 🟡
   Domain-class few-shot segmentation from SAM2's internal features rather than raw point prompts — a better use of SAM2 than MedSAM-style prompting. — [SANSA](https://arxiv.org/pdf/2505.21795)

9. **SegGPT / in-context segmentation** 🟡
   One prompt image+mask → same segmentation on new images, zero weight updates. Conceptually ideal, but heavy to run in ONNX/Rust and patch-resolution — hence mid-rank. — [SegGPT](https://arxiv.org/abs/2304.03284)

10. **PEFT (LoRA / black-box adapters) via the offline path** 🔴
    Most *capable* for context-heavy targets that filter-banks can't reach (position-dependent lesions, DR grading cues) — but needs a gradient loop, so it lives on the offline Python side as the complement. — [Few-shot PEFT organ seg (MedIA'25)](https://arxiv.org/abs/2303.17051) · [FM few-shot actively & sequentially](https://arxiv.org/abs/2502.01000)

**Deliberately *not* in the top 10:** CTTA ([TEGDA](https://papers.miccai.org/miccai-2025/0906-Paper2263.html), BECoTTA) — premature until a trained net exists to adapt per-institution; active label correction ([A²LC](https://arxiv.org/pdf/2506.11599)) — a workflow pattern worth stealing for the correction UX, not a segmenter; diffusion-feature AL — feature extractor too heavy for in-app.

**If building one thing:** #1 + #2 + #5 as the interactive core (hybrid features → cache/prototype head → incremental refit), #4 as the active-learning loop, #10 reserved for the hard residual. That stack is entirely self-contained, matches the annotator's style by construction, and is the only combination that directly answers the fundus resolution problem.

---

## 6. Scribble prompting — three lineages

People often conflate three distinct meanings of "scribble prompting." They have very different implications: one is buildable in-app with no Python, one is the "if you ever train" recipe, and one is a shippable pretrained model.

### Lineage A — Classical, training-free interactive scribble segmentation 🟢

Given foreground/background scribbles, solve a per-pixel labeling with **no learning at all**. Milliseconds on CPU; ports cleanly to Rust.

- **Random Walker** (Grady, 2006) — treat the image as a resistor grid; each pixel gets the probability that a random walk reaches a foreground vs. background scribble first. Sparse linear solve, soft probabilities, native multi-label. Still a top baseline.
- **Geodesic segmentation / GeoS** — weighted geodesic distance from each pixel to the nearest scribble; extremely fast when foreground is homogeneous.
- **Graph Cuts / Lazy Snapping / Geodesic Graph Cut** — [Price & Morse](https://www.researchgate.net/publication/221364303_Geodesic_graph_cut_for_interactive_image_segmentation). Min-cut energy with scribbles as hard seeds; the geodesic+graphcut hybrid needs fewer strokes.
- **Survey** — [interactive segmentation methods, CVMJ 2020](https://link.springer.com/article/10.1007/s41095-020-0177-5).

*Relevance:* the training-free scribble engine to build alongside the existing scribble UI + CRF. Running Random Walker in **feature space** (edge weights from a filter-stack / deep features, not raw pixels) is how you make it work on fundus vessels.

### Lineage B — Scribbles as weak supervision for training a network 🔴

Scribbles as sparse labels to *train* a net once (offline path). The **loss formulation is the reusable idea**.

Foundational recipe (backbone of nearly every 2024–25 paper):
- **Partial Cross-Entropy (pCE)** on scribbled pixels, plus a **regularized loss** on unlabeled pixels:
  - **Normalized Cut Loss** — [Tang et al., ECCV 2018](https://fperazzi.github.io/files/publications/ncloss.pdf)
  - **Gated CRF Loss** & **KernelCut (CRF + NCut)** — best combination. [On Regularized Losses / rloss](https://arxiv.org/pdf/1803.09569) · [code](https://github.com/meng-tang/rloss).

Recent (2024–2026) — mostly consistency + pseudo-labels on top of pCE:
- **HELPNet** — [arXiv 2412.18738](https://arxiv.org/pdf/2412.18738). Hierarchical perturbation consistency + entropy-guided ensemble.
- **ScribbleVC** — [arXiv 2307.16226](https://arxiv.org/pdf/2307.16226). Vision-class embedding.
- **ScribSD+** — [ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0895611124000934). Multi-scale distillation + class-wise contrastive regularization.
- **"From Few to More"** — [arXiv 2408.12814](https://arxiv.org/html/2408.12814v1). Masked context modeling + continuous pseudo-labels.
- **AttenScribble** — [arXiv 2312.06614](https://arxiv.org/pdf/2312.06614). Attentive similarity learning.
- **ScribbleGen** — [OpenReview](https://openreview.net/forum?id=0lJq8pmlXM). ControlNet diffusion augmentation.
- **"Scribble Hides Class"** — [arXiv 2402.17555](https://arxiv.org/abs/2402.17555). Exploit the scribble's class label for pseudo-labeling.
- **Tracking list** — [awesome-weakly-supervised-semantic-segmentation](https://github.com/gyguo/awesome-weakly-supervised-semantic-segmentation).

*Relevance:* if/when the offline trainer learns from accumulated scribbles, **pCE + gated-CRF loss is the standard**, and an in-app CRF already provides the tools to generate the dense pseudo-labels these methods rely on.

### Lineage C — Scribbles as prompts to a promptable / foundation model

Contains the single most relevant recent paper.

- **ScribblePrompt (ECCV 2024, MIT)** — [arXiv 2312.07381](https://arxiv.org/abs/2312.07381) · [project](https://scribbleprompt.csail.mit.edu/) · [code](https://github.com/halleewong/ScribblePrompt). Promptable biomedical segmentation that natively consumes **scribbles, clicks, and boxes**; trained on 54k+ images / 65 datasets. **−28% annotation time, +15% Dice vs. SAM**; beats SAM-Med2D / MedSAM / MIDeepSeg on *unseen* structures. Two variants:
  - **ScribblePrompt-UNet** — small fully-convolutional net (not a heavy ViT). **The big one:** ONNX-exportable → in-app inference via `ort` with no Python at inference; scribble-native; purpose-built for biomedical. 🟡 (inference-only, no training)
  - **ScribblePrompt-SAM** — fine-tuned SAM-ViT-b decoder variant.
  - **MedScribble** dataset — [README](https://github.com/halleewong/ScribblePrompt/blob/main/MedScribble/README.md). Multi-annotator scribbles (3 annotators × 14 tasks) — also evidence that annotator *style* varies.
- **WeakMedSAM** — [arXiv 2503.04106](https://arxiv.org/pdf/2503.04106). SAM + sub-class exploration + prompt-affinity mining from weak scribbles/points.
- **All-in-SAM** — [PMC](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11925546/). Weak prompts → SAM pixel labels → prompt-based finetuning (bootstrap dense labels from scribbles).
- **SparseMamba-PCL** — [arXiv 2503.01633](https://arxiv.org/pdf/2503.01633). SAM-guided progressive collaborative learning.
- **DeepIGeoS** — [arXiv 1707.00652](https://arxiv.org/pdf/1707.00652). Classic bridge: geodesic distance maps from scribbles fed as extra CNN channels — clean way to compose Lineage A and C.

*Relevance:* **ScribblePrompt-UNet is arguably the most important single result for this situation** — a counter-example to "MedSAM is poor on hard images," scribble-native, and small enough to be self-contained at inference. Worth benchmarking on fundus data *first*, before building anything.

---

## 7. Overall synthesis & recommendations

**Clean mental model for scribbles:**
- **Lineage A** = the in-app, training-free engine (Random Walker / geodesic in feature space + CRF).
- **Lineage C (ScribblePrompt-UNet)** = a shippable pretrained scribble model to test now.
- **Lineage B** = the loss recipe for when the offline trainer learns from accumulated scribbles.

They **stack** rather than compete.

**Priority actions:**

1. **Benchmark ScribblePrompt-UNet on fundus data now.** Fastest answer to "is there already a scribble model that works where MedSAM didn't"; architecture is ONNX-exportable for in-app, no-Python inference. Low effort, potentially high payoff.
2. **Build a classical scribble engine (Random Walker or geodesic) in feature space** as the always-available, training-free fallback — running the walk over filter-stack / deep-feature edge weights instead of raw pixels, cleaned by the existing CRF. This is the self-contained core that never depends on any model being good on the domain, and it *is* "learns from this image's scribbles" by construction.
3. **Reserve pCE + gated-CRF loss for the offline trainer** — the proven recipe when training from accumulated scribbles; the in-app CRF already generates the dense pseudo-labels those losses consume.
4. **Layer the interactive core with the few-shot + active-learning stack:** hybrid features (§4/§5 #1) → cache/prototype head (#2) → incremental refit (#5) → dynamic-budget superpixel active learning (#4). Keep gradient-based PEFT (#10) on the offline side for the hard, context-heavy residual.

**The one-line vision:** the model becomes the co-annotator — a self-contained, training-free scribble/few-shot core that learns the annotator's style on-device, with the offline trainer reserved for what classical features genuinely can't reach.

---

### Full source list

**Few-shot fine-tuning**
[Tip-Adapter](https://arxiv.org/abs/2207.09519) ·
[Proto-Adapter](https://www.mdpi.com/1424-8220/24/11/3624) ·
[Few-shot PEFT organ seg (MedIA'25)](https://arxiv.org/abs/2303.17051) · [code](https://github.com/jusiro/fewshot-finetuning) ·
[Mixture-of-LoRA / magnitude LoRA](https://arxiv.org/pdf/2507.06558) ·
[Awesome-PEFT](https://github.com/THUDM/Awesome-Parameter-Efficient-Fine-Tuning-for-Foundation-Models) ·
[FATE-SAM](https://arxiv.org/abs/2501.09138) ·
[Retrieval-aug few-shot med seg](https://arxiv.org/abs/2408.08813) ·
[FM few-shot actively & sequentially](https://arxiv.org/abs/2502.01000) ·
[FSL med-seg review (CSUR'25)](https://dl.acm.org/doi/10.1145/3746224)

**Active learning**
[TypiClust / federated](https://arxiv.org/html/2505.19404) ·
[DEUCE](https://arxiv.org/pdf/2502.00305) ·
[MedCAL-Bench](https://arxiv.org/pdf/2508.03441) ·
[Deep AL med survey](https://arxiv.org/pdf/2310.14230) ·
[Dynamic-budget superpixel AL](https://pmc.ncbi.nlm.nih.gov/articles/PMC11754207/) ·
[Diffusion two-stage low-budget AL (NeurIPS'25)](https://proceedings.neurips.cc/paper_files/paper/2025/hash/208c5f815d330f6ca13df32dea63d735-Abstract-Conference.html) ·
[nnActive](https://arxiv.org/pdf/2511.19183) ·
[A²LC](https://arxiv.org/pdf/2506.11599)

**Online learning / test-time adaptation**
[TEGDA (MICCAI'25)](https://papers.miccai.org/miccai-2025/0906-Paper2263.html) ·
[Domain-consistency CTTA](https://www.sciencedirect.com/science/article/abs/pii/S0031320325002456) ·
[Confidence-guided CTTA](https://www.sciencedirect.com/science/article/pii/S2405959526000640) ·
[awesome-test-time-adaptation](https://github.com/tim-learn/awesome-test-time-adaptation)

**Training-free feature reuse / in-context**
[AnomalyDINO (WACV'25)](https://arxiv.org/abs/2405.14529) ·
[FSSDINO / DINOv3](https://arxiv.org/html/2602.07550v1) ·
[DINOv2-powered FSS](https://arxiv.org/html/2504.15669v2) ·
[No time to train](https://arxiv.org/html/2507.02798) ·
[SANSA](https://arxiv.org/pdf/2505.21795) ·
[SegGPT](https://arxiv.org/abs/2304.03284) ·
[DINO-MVR](https://arxiv.org/pdf/2605.07221) ·
[MRI-CORE](https://arxiv.org/pdf/2506.12186)

**Scribble — classical / losses**
[Geodesic Graph Cut](https://www.researchgate.net/publication/221364303_Geodesic_graph_cut_for_interactive_image_segmentation) ·
[Interactive seg survey (CVMJ'20)](https://link.springer.com/article/10.1007/s41095-020-0177-5) ·
[Normalized Cut Loss (ECCV'18)](https://fperazzi.github.io/files/publications/ncloss.pdf) ·
[On Regularized Losses / rloss](https://arxiv.org/pdf/1803.09569) · [code](https://github.com/meng-tang/rloss)

**Scribble — deep weak supervision**
[HELPNet](https://arxiv.org/pdf/2412.18738) ·
[ScribbleVC](https://arxiv.org/pdf/2307.16226) ·
[ScribSD+](https://www.sciencedirect.com/science/article/abs/pii/S0895611124000934) ·
[From Few to More](https://arxiv.org/html/2408.12814v1) ·
[AttenScribble](https://arxiv.org/pdf/2312.06614) ·
[ScribbleGen](https://openreview.net/forum?id=0lJq8pmlXM) ·
[Scribble Hides Class](https://arxiv.org/abs/2402.17555) ·
[awesome-WSSS](https://github.com/gyguo/awesome-weakly-supervised-semantic-segmentation)

**Scribble — promptable / foundation models**
[ScribblePrompt (ECCV'24)](https://arxiv.org/abs/2312.07381) · [project](https://scribbleprompt.csail.mit.edu/) · [code](https://github.com/halleewong/ScribblePrompt) · [MedScribble](https://github.com/halleewong/ScribblePrompt/blob/main/MedScribble/README.md) ·
[WeakMedSAM](https://arxiv.org/pdf/2503.04106) ·
[All-in-SAM](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11925546/) ·
[SparseMamba-PCL](https://arxiv.org/pdf/2503.01633) ·
[DeepIGeoS](https://arxiv.org/pdf/1707.00652)

---

*Compiled July 2026.*
