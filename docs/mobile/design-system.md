# Mobile design system and UX audit

Direction: **"Farmhouse modern"** — deep egg-farm green, one warm yolk-amber accent, quiet neutral surfaces, generous spacing, one icon family.
Nothing about behaviour changed (API calls, sync, auth, permissions, validation rules); only presentation, navigation and feedback.

## Audit findings that drove the redesign
| Area | Before | After |
|---|---|---|
| Tab bar / icons | emoji (render differently per OS, not accessible) | Ionicons outline/filled pair per tab, badge for unread |
| Home | stack of equal cards | greeting → quick actions → "Needs your attention" → today's figures → charts |
| Success feedback | blocking system alert, then silent | non-blocking toast (announced to screen readers); offline saves say "Saved on this phone" |
| Sign-in | bare form, one red line | brand mark, inline validation, show/hide password, remember email, error card, invitation path |
| First launch | none | 3-slide skippable welcome (shown once) |
| Forms | errors at the bottom / in pop-ups | label always visible, error directly under the field with icon, focus ring, keyboard next/go |
| Loading | spinner | skeleton placeholders shaped like the content |
| Empty lists | one line of text | icon, explanation and a next-step button |
| Errors | red card | friendly title + plain message + "Try again" |
| More / Settings | flat lists | grouped cards with leading icons, profile header |
| Colours | some hard-coded hex values in screens | all colours from tokens (a test fails if hex appears in a screen) |

## Tokens (`src/ui/tokens.ts`)
- **Colour roles**: bg, surface/card, input, text, textSecondary, muted, border/borderStrong, primary(+Soft), accent(+Soft), success, warning, danger, info — light and dark.
  Every foreground/background pair in use is checked against WCAG AA (≥4.5:1) in `tokens.spec.ts`, both themes.
- **Type scale**: display 32 · title 22 · heading 17 · body 16 · label 14 · caption 13 · overline 12; weights 400/600/700 only.
- **Spacing**: 4-pt scale (4·8·12·16·24·32·48); screen gutter 16, section gap 24.
- **Radius**: 10 (controls) · 14 (buttons/inputs) · 20 (cards, sheets) · pill. **Elevation**: one soft card shadow, one float shadow (toast).
- **Touch targets**: ≥48 dp primary, ≥44 dp minimum; steppers, chips, rows and tab items meet it.

## Components (`src/ui/`)
`Text` (type roles) · `Icon` · `Screen` (safe areas, banners, keyboard avoidance, pull-to-refresh) · `Card` · `Button` (icon, busy, press feedback) · `Field` (label, icon, error, hint, password toggle) · `SearchBar` · `Segmented` · `Stepper` ·
`Badge` (icon + text, never colour alone) · `IconTile` · `Avatar` · `StatTile` · `ActionTile` · `ListRow`/`NavRow` · `SectionHeader` · `InlineError` · `Skeleton`/`Loading` · `EmptyState` · `ErrorView` · `Banner` ·
`ToastProvider/useToast` · `ReasonModal` · `PagedList` (skeleton rows, empty state with action) · `BrandMark`, `AuthHeader`, `SuccessPanel`.

## Motion
Only: button/tile press scale (native driver), skeleton pulse, toast fade/slide, stack slide, welcome fade. No decorative animation, no extra animation library.

## Accessibility
Roles/labels on all controls, errors announced (`alert`), toasts announced, status never colour-only, icons hidden from screen readers unless they stand alone, AA contrast tests, text scales with the system font setting (no fixed-height text containers), ≥44 dp targets.

## Verified vs not verified
Verified: TypeScript, ESLint (0 problems), 137 Jest tests (including contrast, component behaviour and design-consistency guards), Android and iOS Metro/Hermes bundles.
**Not verified**: how it looks and feels on a real phone — no screenshots were taken, no TalkBack/VoiceOver pass, no 200 % font-size pass, no small-device (320 dp) pass, and animation smoothness is untested. Treat the first device run as the visual QA and expect some spacing tweaks.
Deliberately not done: custom fonts (system fonts keep the app small and native-feeling), gradients/glass effects, tablet layouts, a self-service registration screen (accounts are invitation-only by design).
