import * as fs from 'fs';
import * as path from 'path';

/** Guards that keep the design system honest: screens use tokens and the shared kit, not ad-hoc colours or emoji icons. */
const ROOT = path.resolve(__dirname, '..');
const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.(tsx?)$/.test(e.name) && !/\.spec\./.test(e.name) ? [path.join(dir, e.name)] : []));
const screens = [...files(path.join(ROOT, 'app')), ...files(path.join(ROOT, 'features'))];

describe('design consistency', () => {
  it('has screens to check', () => expect(screens.length).toBeGreaterThan(30));

  it('uses no hard-coded hex colours in screens (colours come from theme tokens)', () => {
    const offenders = screens.filter((f) => /#[0-9a-fA-F]{6}\b/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it('uses the icon set, not emoji, as icons in screens', () => {
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
    const offenders = screens.filter((f) => emoji.test(fs.readFileSync(f, 'utf8').replace(/[›’“”–—·…−×→]/g, '')));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it('does not import Alert for success confirmations (toasts are used) except where a blocking confirmation is intended', () => {
    const allowed = new Set(['app/(app)/settings/index.tsx', 'app/(app)/settings/profile.tsx', 'app/(app)/sync.tsx', 'app/(app)/notifications/preferences.tsx', 'app/(app)/settings/sessions.tsx', 'app/(app)/settings/mfa.tsx', 'app/(app)/settings/password.tsx', 'app/(app)/admin/notification-settings.tsx', 'app/(app)/reports/[name].tsx']);
    const offenders = screens.map((f) => path.relative(ROOT, f)).filter((f) => !allowed.has(f) && /\bAlert\b/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
