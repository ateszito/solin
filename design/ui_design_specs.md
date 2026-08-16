# Solin — Mobile-First UI Design System

> Full design specification for the Solin recipe platform mobile interface. All layouts optimized for 320px+ viewports first. ☆

## Brand Identity

### Color Palette (Solin)

| Token | Hex | Usage |
|-------|-----|-----|
| Primary | #FF6B6B | Main buttons, active states, progress rings |
| Primary Dark | #E55A5A | Hover/pressed states |
| Secondary | #2D3436 | Headings, bold text |
| Text Primary | #2D2D2D | Body text |
| Text Secondary | #8E8E93 | Metadata, hints, captions |
| Background | #FFFFFF | Main background |
| Card | #F5F5F5 | Section backgrounds |
| Card Accent | #FFF3E0 | Recipe card backgrounds |
| Success | #4CAF50 | Checked ingredients, completed progress |
| Warning | #FFA726 | Low stock, alt states |
| Border | #E0E0E0 | Dividers |

### Typography

| Level | Size | Weight | Usage |
|-------|------|--------|---|
| Display | 32px | 800 | App name, hero quotes |
| Hero | 24px | 700 | Recipe title (feed card) |
| H1 | 20px | 600 | Section headers (Ingredients, Steps) |
| H2 | 18px | 600 | Subsection headers |
| Body | 16px | 400 | Recipe description, step text |
| Label | 14px | 600 | Macro numbers, button text |
| Caption | 12px | 400 | Metadata (time, servings, tags) |
| Micro | 10px | 500 | Hashtag pills, timestamps |

### Spacing Scale (based on 4px grid)

| Token | Size | Usage |
|-------|------|---|
| xs | 4px | Icon padding |
| sm | 8px | List item padding |
| md | 16px | Section margins |
| lg | 24px | Page padding |
| xl | 32px | Container max-width |

## Layout System

### Mobile Layout (320-429px) — Single Column

```
┌────────────────────────────────────┐
│  [Header: Solin logo + Search]    │
├────────────────────────────────────┤
│  [Video Player - Full Width]      │
│  ┌──────────────────────────────┐  │
│  │                              │  │
│  │       VIDEO CONTENT          │  │
│  │                              │  │
│  └──────────────────────────────┘  │
│  ▶⏪ | ⏩  ────────────▶  01:02    │
├────────────────────────────────────┤
│  [Recipe Title + Rating]           │
│  Javítom magam              ★ 4.9  │
├────────────────────────────────────┤
│  [Macro Cards - Horizontal Scroll] │
│  ┌────┐ ┌────┐ ┌────┐ ┌────┐     │
│  │850 │ │45g │ │48g │ │29g │     │
│  │kcal│ │prot│ │carb│ │fat │     │
│  └────┘ └────┘ └────┘ └────┘     │
├────────────────────────────────────┤
│  [Description - Collapsible]       │
│  High-protein chicken & sausage... │
│  ──────────────────────────────     │
│  [▼ Show more]                      │
│                                     │
│  [#highprotein] [#quick] [▼more]   │
├────────────────────────────────────┤
│  [Ingredients - Accordion]         │
│  ──────────────────────────────     │
│  ☐ 200g red onion     ───  ─────   │
│  ☑ 50g sausage        ───  ─────   │
│  ☐ 650g chicken       ───  ─────   │
│  ☐ 3 cloves garlic    ───  ─────   │
│  ──────────────────────────────     │
│  Progress:████████░░  4/13          │
├────────────────────────────────────┤
│  [Steps - Accordion]               │
│  ──────────────────────────────     │
│  ① Chop onion + sausage [▶vid]    │
│  ② Add chicken breast  [▶vid]     │
│  ③ Season with spices  [▶vid]     │
│  ④ Add tomato paste  [▶vid]       │
│  ⑤ Add cream + water   [▶vid]     │
│  ⑥ Add pasta to sauce  [▶vid]     │
│  ⑦ Add spinach          [▶vid]     │
│  ⑧ Top with parmesan  [▶vid]     │
│  ──────────────────────────────     │
│  Steps:████████ 8/8 complete        │
├────────────────────────────────────┤
│  [Footer Nav]                      │
│  [🏠] [🔍] [❤️] [📤] [👤]        │
└────────────────────────────────────┘
```

### Tablet Layout (768-1023px) — Two Column

```
┌────────────────────┬─────────────────────┐
│                    │                     │
│   [Video Player]   │   [Macros Grid]     │
│                    │   ┌────┐ ┌────┐     │
│   ┌──────────┐     │   │850 │ │45g │     │
│   │          │     │   │kcal│ │prot│     │
│   │  VIDEO   │     │   └────┘ └────┘     │
│   │          │     │   ┌────┐ ┌────┐     │
│   └──────────┘     │   │48g │ │29g │     │
│                    │   │carb│ │fat │     │
│  [Recipe Title]    │   └────┘ └────┘     │
│  ────────────────  │                     │
│  [Description]     │   [Ingredients]      │
│  ────────────────  │   ───────────────    │
│  [Ingredients]     │   ☐ red onion       │
│  ────────────────  │   ☐ sausage         │
│  ☐ onion            │                      │
│  ☑ sausage          │   [Steps]            │
│  ☐ chicken          │   ───────────────    │
│  ────────────────  │   1. Chop... [▶vid]  │
│  [Steps]            │   2. Add chicken...  │
│  ────────────────  │                      │
│  ① Chop... [▶vid]  │                      │
│  ────────────────  │                      │
│  [Save Button]     │                      │
│                    │                      │
└────────────────────┴─────────────────────┘
```

### Desktop Layout (1024px+) — Three Column

```
┌──────────┬──────────────────┬────────────┐
│          │                  │            │
│  VIDEO   │   [Recipe Body]  │  SIDEBAR  │
│          │                  │            │
│ ┌──────┐ │ ─────────────────│  NUTRITION│
│ │      │ │  Javítom magam   │  GRAPH   │
│ │ VIDE │ │  ★ 4.9           │  ┌─────┐ │
│ │ O    │ │ ─────────────────│  │  ╱╲  │ │
│ │      │ │  Ingredients      │  │╱  ╲ │ │
│ └──────┘ │ ─────────────────│  └─────┘ │
│ ▶⏪⏩    │ │ ☐ onion           │            │
│  01:02   │ │ ☑ sausage        │  CREATOR  │
│          │ │ ☐ chicken        │  ──────  │
│          │ │ ─────────────────│  iamvar..│
│          │ │ Steps            │  ──────  │
│          │ │ ① Chop [▶vid]    │            │
│          │ │ ② Add [▶vid]     │  RELATED  │
│          │ │ ─────────────────│  ──────   │
│          │ │ [Save to list]   │  recipe 1 │
│          │ │ [Share]          │  recipe 2 │
│          │ │ ─────────────────│            │
└──────────┴──────────────────┴────────────┘
```

## Component Specifications

### 1. Video Player Component
- **Position:** Top section of recipe page, full-width
- **Size:** 100% width, 40% of viewport height (mobile)
- **Controls:**
  - Bottom overlay bar (transparent background)
  - Play/Pause toggle (left)
  - 15s backward button
  - 15s forward button
  - Progress bar (center, clickable)
  - Timestamp (right, HH:MM format)
  - Replay button (tap twice center to replay)
- **Overlay:** Creator name + title (top-left, fades after 3s)
- **Responsive:** Scales to viewport, maintains 16:9 aspect ratio

### 2. Macro Cards
- **Layout:** Horizontal scroll on mobile, grid on tablet/desktop
- **Each card shows:**
  - Large number (28px bold) — the value
  - Label (12px) — calories/protein/carbs/fat
  - Color-coded: calories=coral, protein=blue, carbs=green, fat=orange
- **Tap to expand:** Shows detailed nutrition breakdown in bottom sheet

### 3. Ingredient Checklist
- **Accordion section** (collapsible)
- Each ingredient row: checkbox | name + amount + prep | swipe hint
- Checkmark: coral-red circle with white check
- Progress bar below: shows X/total completed
- Swipe left on ingredient → edit amount
- Swipe right → mark as "skip"
- Long press → bulk add similar ingredients

### 4. Steps Navigator
- **Accordion section** (collapsible)
- Each step: numbered circle | instruction | ▶ video link (synced to timestamp)
- Active step highlighted with coral-red left border
- Step navigation arrows at top (◀ 3/8 ▶)
- "Jump to step 8" shortcut at bottom

### 5. Recipe Feed Card
- Card with:
  - Video thumbnail (tap to preview, hold to see step frames)
  - Title (24px bold)
  - Creator avatar + name (small, below title)
  - Rating star (top-right)
  - Mini macros row (bottom, 3 cards: kcal/protein/carbs)
  - Hashtags row (bottom): #highprotein #quick
  - Border radius: 12px
  - Shadow: subtle (0 2px 8px rgba(0,0,0,0.1))

### 6. Bottom Navigation
- 5 icons, fixed to bottom
- 🏠 Home Feed
- 🔍 Search / Filter
- ❤️ Saved / Collections
- 📤 Share / Export
- 👤 Profile
- Active icon: coral-red fill, others: gray outline

## States & Interactions

### Loading States
- Skeleton loaders for recipe cards (gray blocks with shimmer)
- Video loader: spinner + "Loading recipe..." text
- Ingredient loader: fading placeholder bullets

### Empty States
- Feed empty: "No recipes found. Try searching!" with search button
- Ingredients empty: "Add your first ingredient to get started!"
- Steps empty: "No steps yet. Watch the video to extract steps!"

### Error States
- Network error: "Connection lost. Tap to retry." with refresh button
- Video failed: "Video couldn't load. Tap to try again."
- Schema error: "Recipe data incomplete. Contact creator."

## Accessibility

| Criterion | Implementation |
|-----------|-----|
| Contrast ratio | All text ≥ 4.5:1 against background |
| Touch targets | Minimum 44x44px for all interactive elements |
| Font scaling | Body text scales to 16pt minimum (iOS) |
| VoiceOver | All icons have accessibility labels |
| Dynamic type | All text respects system font size |
| Color independence | Important info not conveyed by color alone |
| Reduced motion | Pause video animation toggle available |
| Focus states | Visible outline on all focusable elements |

## Animations & Transitions

| Element | Animation | Duration |
|---------|--------|------|
| Card press | Scale to 0.98, back to 1.0 | 150ms |
| Page transition | Slide right for forward, left for back | 300ms |
| Checkbox check | Bounce scale: 0.8 → 1.1 → 1.0 | 300ms |
| Progress bar | Smooth fill | 200ms |
| Ingredient swipe | Elastic bounce back | 250ms |
| Step highlight | Coral border sweep (left-to-right) | 150ms |
