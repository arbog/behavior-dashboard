# Research — naming: the words the community uses, and a shortlist

Research task for `PLAN` workstream N (name + domain — ATTENDED, but this
doc does the homework). Executed in-session 2026-11-05 via web search
(sources cited).

**DECIDED 2026-11-05: the product is KindBoard; the managed domain is
kindboard.app.** KindBoard won on the same test the shortlist was built
around — it is the VALUES.md thesis in one word, it is warm without being
cute, and kindboard.app was unregistered. The per-family managed origin is
`<name>.board.kindboard.app`, and the passkey RP-ID is `board.kindboard.app`
(the shared suffix: every family board's WebAuthn credentials bind to it,
and credential lookup is per board, so families stay isolated). The
`kindboard.app` domain itself is registered by the operator — an operator
action, not a code one. See docs/managed.md §domain.

## What the community says, in one page

**Symbols — the landmine everyone steps on first.** The puzzle piece is
rejected by a large share of autistic self-advocates: created by non-autistic
people in 1963, it reads as "missing something" and a thing to be fixed
(altogetherautism.org.nz: "Autism no puzzle, nothing wrong with us";
theconversation.com; Drexel Autism Institute). The symbol that replaced it in
community use is the **infinity sign — often in rainbow or gold**
(scienceinsights.org). Gold carries a double meaning: the chemical symbol
for gold is **Au**, and the autistic-pride infinity is frequently rendered in
gold.

**Language.** The community that rejects the puzzle piece overwhelmingly
prefers **identity-first** language — "autistic person", not "person with
autism" (heyasd.com). Deficit framing ("special needs", "high/low
functioning", "suffers from") is actively disliked; the affirming register is
**neurodiversity / neuroaffirming** everything
(ndconnection.co.uk, sinneavefoundation.org).

**Practice words that are loved (and what they call the thing this app
is):**
- **Now and Next board** — "the smallest possible visual support: two
  pictures side by side" (pictalk.org), "a fundamental way to communicate
  what's happening around a transition" (theautismpage.com). This is the
  community's own name for the thing our kiosk IS.
- **First / Then** — the two-slot ancestor of every schedule.
- **Co-regulation** — the affirming core of regulation work: a grown-up's
  steadiness lends the child theirs (autismontario.com). The board's battery
  and pause are co-regulation, rendered.
- **Stimming, unmasking, spiky profile** — self-advocacy vocabulary for the
  range the board must respect, not suppress.

**The line that decides whether a name is kind:** the
behavior-compliance era's vocabulary — "quiet hands", "calm body",
token boards that reward sitting still — is what autistic adults point to
when they say ABA hurt them (ASHA Leader, thinkingautismguide.com, PMC).
A name must not smell of compliance. "Regulation" and "steady" do not;
"control", "compliance", "target behaviors" do.

**What parents call the tool:** visual schedule, token board, choice board,
day plan, first-then, "what comes next instead of guessing" — the promise
every parent guide repeats (inclusiveaba.com, buildingblockresistance.com,
futureforautism.org).

## The competitive field (names already out there)

Stridesy, BloomPath, MyVisualRoutine, Visual Schedule app, Awakee, Goally —
the space skews generic-descriptive ("visual schedule X") with
nature-metaphor brands (Bloom, Branches). A name that is either
community-native or plainly warm stands out.

## The candidates, felt out

| Name | Why it could be right | Honest reservations | Domains (RDAP, 2026-11-05) |
|---|---|---|---|
| **Now & Next** | The community's own term for the smallest board; describes our kiosk *exactly* — the Now card and the strip counting what's next. Zero learning curve for any parent who has used a visual support. | Generic phrase = hard to own as a brand, easy to outrank. Every `nowandnext.*` domain I checked is registered. | all checked taken |
| **Steady Board** | Regulation is the point; "steady" is the word for what a dysregulated day lacks, and it is kind — no compliance smell. The battery metaphor is steadiness. Distinctive two-word brand. | Doesn't say "autism" — needs a tagline. First search results may confuse with unrelated "steady" products. | steadyboard.app/.io/.org **available**; .com taken |
| **KindBoard** | VALUES.md's thesis in one word; warm, simple, child-facing. | Reads slightly generic; "board" is doing heavy lifting; the kiosk is only half of it (the console is for grown-ups). | kindboard.app **available** |
| **First & Then** | The board IS a first-then machine, scaled up. Tool-real, community-native, friendly. | Describes the schedule layer, not the regulation layer; slightly nursery-coded. | firstandthen.app **available**; firstthen.* taken |
| **Au Board** | The quiet nod: Au = gold, the pride infinity. Community members will see it and smile. | Opaque to everyone else; requires the explanation. | auboard.app **available** |
| **Co-Regulate** | The affirming practice the board implements; verb-like, distinctive. | Clinical-adjacent; all checked domains taken. | taken |

## The feel-out summary

The two that survive every critique are the two that come from opposite
ends of the same truth:

1. **Now & Next** — the community's term, the app's literal interface, warm
   and wordless. Its weakness is purely commercial: the phrase is shared
   property, so the brand lives or dies on the domain and the design.
2. **Steady Board** — the regulation promise, ownable, and the battery that
   the child watches all day IS steadiness. Its weakness is that it says
   nothing about autism — which is arguably fine: the board is for one
   family, not a billboard.

A defensible shape: name the **product** for what the family does with it
(Now & Next), and name the **hosted service** for what it gives them
(Steady). But two names for one thing is a cost, not a feature.

## What the decision still needs (attended steps)

1. **Say it out loud to autistic adults** — especially the ones who critique
   ABA. The name must pass the "would this board have respected me as a
   child?" test, and no amount of research substitutes for that.
2. **Trademark search** before falling in love — the community's terms
   (visual schedule, now-and-next) are shared property; a distinctive mark
   is easier to defend than a generic one.
3. **The domain** — it is not just branding, it is the **passkey RP-ID**:
   every family's board binds its WebAuthn credentials to the exact domain
   (docs/integrations.md, docs/managed.md). Decide the domain shape
   (`<name>.<host>` per family vs family-owned domains) at the same time.
4. **Read it name-free.** The board works without a name on screen; the
   kiosk never shows it to the child. Whatever is chosen must be right in
   the URL bar and the sign-up page, not on the wall.
