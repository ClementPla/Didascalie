# Several annotators

A project can be annotated by several people, each with their own account. Every
account keeps its **own** annotations: two graders can label the same frame
without seeing or overwriting each other's work, and their results can then be
compared.

Everything stays in the one `.dida` file. People take turns opening it; it is
not a shared server, so only one person should have it open at a time.

## A typical study

1. One person creates the project, gives their name, and defines the labels and
   tasks. They are the administrator.
2. The file is passed to each grader in turn (or kept on a shared computer).
   Each one opens it, registers an account, and annotates.
3. Graders mark a frame **reviewed** when they have finished it, even if they
   drew nothing on it.
4. The administrator opens the **Inter-grader agreement** page to compare them.

To try this without preparing data, the example project
`fundus_vessels_two_graders.dida` holds 20 fundus photographs with the vessels
traced by two observers, one account each. Sign in as *First observer* to see
the agreement page.

## Accounts

A project always has at least one account. The person who creates the project
gets the first one, as an administrator.

Open the account page with the button showing your name in the top bar.

- **Sign in**: click your account. If it has a password, you are asked for it.
- **Register**: type your name in **New account**, optionally a password, and
  click **Create and sign in**. New accounts are editors.
- **Switch**: click another account. Your current frame is saved first.

A project with a single account and no password opens straight into it, so
working alone is the same as before.

!!! warning "Passwords are not security"

    A password keeps people from picking the wrong account. It is stored
    unencrypted in the project file, and anyone with the file can read every
    account's annotations with another tool.

## What is per account, and what is shared

| Per account | Shared by everyone |
| --- | --- |
| Masks and vector shapes | Images and sequences |
| Classification answers | Labels, tasks and text fields |
| Text descriptions | Registration keypoints |
| The reviewed mark, and so the progress shown in the gallery | The trained model |

Everything you do in the application applies to your account only: the gallery
shows your progress, export writes your annotations, propagation and clearing a
sequence touch your masks, and a model is trained on the frames *you* reviewed.

To export another grader's annotations, sign in as them. An administrator
cannot open another account's masks in the editor from their own account: the
agreement page is where graders are looked at side by side.

## Roles

| | Editor | Administrator |
| --- | --- | --- |
| Annotate, review, export, train | Yes | Yes |
| Rename own account, set own password | Yes | Yes |
| [Project settings](projects.md#changing-a-project-after-it-is-created), adding images | No | Yes |
| Change roles, rename or delete other accounts | No | Yes |
| Read the inter-grader report | No | Yes |

A project must keep at least one administrator.

Deleting an account erases everything it annotated. The dialog lists how many
frames are affected and asks you to confirm. It cannot be undone.

## Opening an older project

A project created before accounts existed is upgraded the first time it is
opened. It gains one administrator account, named **Admin**, which owns every
annotation and reviewed mark already in the project. Nothing is lost, and the
project opens straight into that account. Rename it from the account page.

Once upgraded, the file can no longer be opened by older versions of
Didascalie. Copy it first if you still need it there.

## Inter-grader agreement

The **Inter-grader agreement** page (administrators only) compares what the
graders annotated.

### Which frames are compared

Two graders are compared on the frames they have both worked on. Choose what
that means at the top of the page:

- **Reviewed by both** (default): frames both marked as reviewed. A frame a
  grader reviewed without drawing anything counts as "nothing here". This is
  the reliable choice, and the reason to mark frames reviewed when you finish
  them.
- **Annotated by both**: frames on which both stored an annotation. A frame one
  grader left empty on purpose is not compared, so agreement can look better
  than it is.

### What is reported

Graders are always compared two at a time. The first table has one row per pair
— three graders make three pairs, four make six — with the frames the pair
shares and one summary score for segmentation and for classification. Select a
row to see the detail and the examples for that pair. **All graders**, at the
bottom, summarises every pair together.

**Segmentation**, for each label. A grader's region is their painted mask
together with their vector shapes. Instance numbers are ignored: the graders
agree on a pixel when both marked it with the label.

| Column | Meaning |
| --- | --- |
| Dice | Overlap, with pixels summed over all compared frames |
| IoU | Intersection over union, summed the same way |
| Mean frame Dice | Dice computed on each frame, then averaged over the frames where at least one of the two drew the label. A frame only one of them annotated scores 0. |
| Kappa | Cohen's kappa on pixels (label present or absent) |

**Examples.** Under the label table, the page shows the frames behind the
numbers for the selected pair: the three with the lowest Dice and the three with
the highest, each drawn with both graders' annotations. White is where they
agree; orange and blue are what only one of them marked. Click a thumbnail to
enlarge it, or pick any compared frame from the list, which is sorted from least
to most agreement. **Show annotations** switches the drawing off to see the
image underneath. With several labels, choose which one is drawn.

The colours can be changed: click a colour in the legend. This helps on
greyscale or strongly tinted images, where the defaults can be hard to tell
apart from the image. **Edges only** draws the outline of each grader's region
instead of filling it, in a thickness you set, so the structure underneath stays
visible. These choices are remembered on your computer.

**Classification**, for each task. A missing answer is treated as an answer of
its own.

| Column | Meaning |
| --- | --- |
| Agreement | One-answer tasks: share of frames with the same answer. Several-answer tasks: mean overlap (Jaccard) of the two selections. |
| Kappa | Cohen's kappa. For several-answer tasks, computed per class and averaged. |

**All graders** averages the pairwise values and adds Fleiss' kappa for
classification, computed on the frames every grader has in common.

A dash means the value is undefined: the two graders share no frame, or the
answers do not vary at all, in which case kappa has no chance level to compare
against.

Text descriptions are not compared.
