# Use Cases from TikTok Starter Videos — Solin Platform

> Derived from iamvargacsaba's viral TikTok recipe videos. These use cases define what the Solin platform must support from day one. ☆

---

## Recipe 1: "Javítom magam" — Chicken & Sausage Pasta

| Field | Value |
|-------|-------|
| **Title** | Javítom magam - Chicken & Sausage Pasta |
| **Creator** | iamvargacsaba |
| **Source** | https://vm.tiktok.com/ZN88s6bGY |
| **Rating** | 9.9/10 |
| **Servings** | 5 |
| **Calories/serving** | ~850 kcal |
| **Video file** | ~/Documents/VideoContent/video1.mp4 (5.5 MB) |
| **Transcript** | ~/Documents/VideoContent/video1_transcript.txt |

### Ingredient List (per full recipe, divided into 5 servings)

| # | Ingredient | Amount | Prep |
|---|-----------|--------|------|
| 1 | Red onion | 200g | chopped |
| 2 | Sausage | 50g | diced |
| 3 | Chicken breast | 650g | diced |
| 4 | Salt (iodized) | 1 pinch | — |
| 5 | Chili | 1 dash | to taste |
| 6 | Smoked paprika | 1 tsp | — |
| 7 | Black pepper | 1 pinch | freshly ground |
| 8 | Garlic | 3 cloves | minced |
| 9 | Tomato paste | 3 tbsp | — |
| 10 | Cream or rice cream | 160g | — |
| 11 | Pasta (cooked) | 240g | pre-cooked |
| 12 | Spinach | 80g | optional |
| 13 | Parmesan | 40g | grated |

### Per-Serving Macros (estimated)
| Nutrient | Amount |
|----------|--------|
| Calories | 850 kcal |
| Protein | 45.2g |
| Carbs | 48.0g |
| Fat | 28.5g |
| Fiber | 3.2g |
| Sugar | 8.0g |
| Sodium | 920mg |

### Step-by-Step Instructions (from video timestamps)

| Step | Instruction | Video Start | Video End |
|------|------------|-------------|-----------|
| 1 | Chop 200g red onion, add to pan with 50g diced sausage | 00:06.720 | 00:11.600 |
| 2 | Dice 650g chicken breast and add to pan | 00:11.800 | 00:15.600 |
| 3 | Season with salt, chili, smoked paprika, pepper, garlic | 00:20.200 | 00:25.760 |
| 4 | Add 3 tbsp tomato paste once meat is cooked | 00:31.840 | 00:34.960 |
| 5 | Add 160g cream and splash of water | 00:35.120 | 00:37.880 |
| 6 | Add 240g cooked pasta to the sauce | 00:41.200 | 00:43.240 |
| 7 | Add 80g spinach (optional but recommended) | 00:46.080 | 00:48.960 |
| 8 | Top with 40g grated parmesan and serve | 00:49.000 | 00:51.200 |

---

## Use Case Specifications

### UC-01: Browse Recipe Feed
**Actor:** Recipe consumer
**Description:** User browses a scrollable feed of recipe cards
**Preconditions:** User has installed the app
**Flow:**
1. User opens the app → sees recipe feed
2. Each card shows: video thumbnail, title, rating, mini macros
3. User taps a card → opens full recipe view
**Test scenarios:**
- [ ] Feed loads 10+ recipes with proper pagination
- [ ] Tapping a card navigates to full recipe view
- [ ] Macro values display correctly on cards
- [ ] Rating displays as 9.9/10 format

### UC-02: Watch Video Recipe with Step Sync
**Actor:** Recipe consumer
**Description:** User watches the video tutorial with synced step highlighting
**Preconditions:** User has opened a recipe
**Flow:**
1. Full-screen video player at top
2. Current step highlight advances as video progresses
3. User can tap a step → video jumps to that step's timestamp
**Test scenarios:**
- [ ] Video plays from start
- [ ] Step 1 highlighted at 00:06.720
- [ ] Step 2 highlighted at 00:11.800
- [ ] Tapping step 8 jumps to 00:49.000
- [ ] Steps auto-scroll as video progresses

### UC-03: Check Off Ingredients
**Actor:** Recipe consumer
**Description:** User taps ingredients off as they are cooking
**Preconditions:** User has opened a recipe
**Flow:**
1. User scrolls to ingredients section
2. Each ingredient has a checkbox
3. User taps → ingredient checked, progress bar updates
4. All 13 ingredients checked → "All ingredients ready!"
**Test scenarios:**
- [ ] All 13 ingredients display correctly
- [ ] Tapping toggles check state
- [ ] Progress bar updates incrementally
- [ ] Checkoff persists on page reload
- [ ] Ingredient name strikethrough when checked

### UC-04: View Macro Dashboard
**Actor:** Recipe consumer
**Description:** User views nutritional breakdown for the recipe
**Preconditions:** User has opened a recipe
**Flow:**
1. User scrolls to macro section
2. Four cards display: Calories, Protein, Carbs, Fat
3. User taps a macro number → shows detailed breakdown
**Test scenarios:**
- [ ] Calories: 850 displayed prominently
- [ ] Protein: 45.2g displayed
- [ ] Carbs: 48.0g displayed
- [ ] Fat: 28.5g displayed
- [ ] Macro values match recipe schema

### UC-05: Create Recipe from TikTok Video
**Actor:** Recipe editor
**Description:** Creator uses the platform to build a structured recipe from a TikTok video
**Preconditions:** Creator has downloaded a TikTok video + transcript
**Flow:**
1. Creator uploads video file
2. Platform parses transcript to extract ingredient names
3. Creator fills in amounts, units, steps, macros
4. Creator saves as draft → reviews → publishes
**Test scenarios:**
- [ ] Video upload works (≤50MB)
- [ ] Transcript file upload works
- [ ] Ingredient auto-extraction identifies at least 10 of 13 ingredients
- [ ] User can edit all macro fields
- [ ] Save draft works
- [ ] Publish flow validates all required fields

### UC-06: Advanced Search by Macros
**Actor:** Recipe consumer
**Description:** User filters recipes by nutritional preferences
**Preconditions:** User has 10+ recipes in platform
**Flow:**
1. User opens search
2. Sets filters: "protein > 40g", "carbs < 50g"
3. Results show recipes matching criteria
**Test scenarios:**
- [ ] Filter: protein≥40g → both starter recipes returned
- [ ] Filter: calories≤900 → both returned
- [ ] Filter: dairy-free → neither returned (has cream, parmesan)
- [ ] Filter: vegetarian → neither returned (has chicken, sausage)

---

## Acceptance Criteria Summary

| # | Criterion | Priority | Status |
|---|-----------|----------|--------|
| AC-01 | Recipe cards display with title, rating, mini-macros | Must | Pending |
| AC-02 | Video player with play/pause/skip controls | Must | Pending |
| AC-03 | Steps highlighted in sync with video playback | Must | Pending |
| AC-04 | Ingredient checklist with tap-to-check | Must | Pending |
| AC-05 | Macro cards (calories, protein, carbs, fat) | Must | Pending |
| AC-06 | All 13 ingredients for "Javítom magam" stored | Must | Pending |
| AC-07 | All 8 steps with video timestamps stored | Must | Pending |
| AC-08 | Mobile viewport 320px+ fully functional | Must | Pending |
| AC-09 | Recipe schema validates all required fields | Must | Pending |
| AC-10 | PostgreSQL schema with indexed search on tags/cuisine | Should | Pending |
| AC-11 | Search by macros works | Should | Pending |
| AC-12 | Dev and prod environments documented | Should | Pending |
| AC-13 | Git repo with dev/prod branches | Should | Pending |
| AC-14 | Use cases mapped to test scenarios | Should | Pending |
| AC-15 | Documentation includes all video transcript data | Must | Pending |
