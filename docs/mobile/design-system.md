# Mobile design system and UX audit

Direction: **"Farmhouse modern"** — deep egg-farm green, one warm yolk-amber accent, quiet neutral surfaces, generous spacing, one icon family.
Nothing about behaviour changed (API calls, sync, auth, permissions, validation rules); only presentation, navigation and feedback.

## Audit findings that drove the redesign
| Area | Before | After |
|---|---|---|
| Tab bar / icons | emoji (render differently per OS, not accessible) | Ionicons outline/filled pair per tab, badge for unread |
| Home | stack of equal cards | greeting → quick actions → "Needs your attention" → today's figures → charts |
| Success feedback | blocking system alert, then silent | non-blocking toast (announced to screen readers); offline saves say "Saved on this phone" |
| Sign-in | bare form, one red line | brand header + rounded sheet (also used by forgot/reset password and first-sign-in password), pill fields, show/hide password, remember email, error card |
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

## Forms: when errors appear (applies to every screen)
One rule, implemented once in `src/lib/validation.ts` (`useForm`):
- tapping into a field, or leaving it empty, never shows an error;
- once someone has typed something and left the field, wrong formats (email, phone, money, 6-digit codes, password policy…) are flagged and the message stays current as they edit;
- pressing the main button checks everything, including required fields.
The server re-validates all input; the phone-side rules only save a round trip. Text fields keep a constant 2 px border (only its colour changes) so focusing a field never shifts the layout.

## Modals: which surface for what
| Surface | Used for | How |
|---|---|---|
| **Bottom sheet** | add / edit forms of normal size: customer, coop, payment, stock adjustment, invite, profile, email, password | native `formSheet` presentation (swipe down or ✕ to close) via `SheetScreen` |
| **Full-screen modal** | longer forms: record production, new sale, new expense | native `fullScreenModal` with a close button |
| **Dialog** | confirmations, notices and small forms (the reason box, photo choice, "discard this record?") | `useDialog()` (`confirm`, `notify`, `ask`) and `DialogShell`; replaces the system alert everywhere (a test forbids `Alert`) |
| **Toast** | quiet confirmations ("Saved") | `useToast()` |
| **Busy overlay** | work that must not be interrupted (signing out) | `withBusyOverlay("Signing you out…", fn)` |

## Charts (react-native-svg, no chart library)
`ui/charts.tsx`: line/area (trend), bar, histogram (spread of daily output), pie/donut (share of a whole). Rules from the data-viz method: one axis, thin marks, 2 px gaps, categorical colours in a fixed order (validated: colour-blind separation and normal-vision floor pass in both modes; three light-mode slots are under 3:1 so every slice is also labelled with value and percentage), more than five categories fold into "Other", touch any point/bar/slice to read it, and every chart has a table view (`ChartCard`) and a screen-reader summary.

## Loading and activity
`EggSpinner` (bouncing egg; breathes instead when the phone has "reduce motion" on), `DotsLoader` (inside every busy button), `BrandLoading`/`Loading` (spinner + skeleton cards), `BusyOverlay`. The boot screen uses the same egg.

## iOS look
`ui/glass.tsx`: `GlassSurface` is the system **liquid glass** on iOS 26+, a system blur material on earlier iOS, and a plain elevated card on Android. Cards, stat tiles, dialogs, the profile menu, the busy overlay and the floating tab bar use it; a soft colour backdrop (`GlassBackdrop`) sits behind screens so the glass has something to refract. iOS also gets continuous (squircle) corners, light haptics on buttons/tabs/toggles, native sheets, and the system's own navigation bar (no fixed header colour). **Unverified**: none of this has been seen on a device; the glass effect needs iOS 26 and a development or store build (Expo Go on an older iOS shows the blur fallback).

## iOS dark mode and start-up (added)
- The root view, safe-area provider, native window (`expo-system-ui`) and every stack's `contentStyle` use the theme background, so no white shows behind the header or during transitions in dark mode. The status bar style is explicit (light icons in dark mode, dark icons in light mode).
- Stack headers always use the theme background on iOS too (they previously used the system bar, which could stay white).
- The loading screen (`BootSplash`) uses fixed brand colours so it is visible in either mode. The privacy cover starts hidden and only appears when the app goes inactive/background, so a cold start can no longer be stuck on a blank cover.
- Not verified on an iPhone. Rebuild the dev client (splash settings in `app.json` are native) or restart with `npx expo start -c`.
