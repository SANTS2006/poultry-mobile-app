import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useAppStore } from '../state/store';
import { Button, Segmented, Stepper } from './components';
import { ReasonModal } from './reason-modal';
import { StatusBanners } from './status-banners';

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));

// react-test-renderer needs this flag to allow act() outside of a testing library
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const render = (el: React.ReactElement): ReactTestRenderer => { let r!: ReactTestRenderer; act(() => { r = create(el); }); return r; };
/** All visible text, concatenated (JSX splits text into several children). */
const texts = (r: ReactTestRenderer): string => {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (n === null || n === undefined) return;
    if (typeof n === 'string') { out.push(n); return; }
    if (Array.isArray(n)) { n.forEach(walk); return; }
    walk((n as { children?: unknown }).children);
  };
  walk(r.toJSON());
  return out.join('');
};

describe('Button', () => {
  it('does not fire while busy or disabled', () => {
    const onPress = jest.fn();
    const busy = render(<Button title="Save" onPress={onPress} busy />);
    const btn = busy.root.findByProps({ accessibilityRole: 'button' });
    expect(btn.props.disabled).toBe(true);
    expect(btn.props.accessibilityState).toMatchObject({ busy: true, disabled: true });
    const off = render(<Button title="Save" onPress={onPress} disabled />);
    expect(off.root.findByProps({ accessibilityRole: 'button' }).props.disabled).toBe(true);
    const ok = render(<Button title="Save" onPress={onPress} />);
    act(() => { ok.root.findByProps({ accessibilityRole: 'button' }).props.onPress(); });
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('Segmented', () => {
  it('marks the selected option and reports taps', () => {
    const onChange = jest.fn();
    const r = render(<Segmented value="B" onChange={onChange} options={[{ value: 'A', label: 'Alpha' }, { value: 'B', label: 'Beta' }]} />);
    const radios = r.root.findAll((n) => n.props.accessibilityRole === 'radio' && typeof n.props.onPress === 'function');
    expect(radios).toHaveLength(2);
    expect(radios.map((n) => n.props.accessibilityState.selected)).toEqual([false, true]);
    act(() => { radios[0].props.onPress(); });
    expect(onChange).toHaveBeenCalledWith('A');
  });
});

describe('Stepper', () => {
  it('only produces whole numbers within range', () => {
    const onChange = jest.fn();
    const r = render(<Stepper label="Crates" value={5} onChange={onChange} max={10} />);
    const input = r.root.findByProps({ accessibilityLabel: 'Crates' });
    act(() => { input.props.onChangeText('12abc'); });
    expect(onChange).toHaveBeenLastCalledWith(10); // digits only, clamped to max
    act(() => { input.props.onChangeText('-3'); });
    expect(onChange).toHaveBeenLastCalledWith(3); // the minus sign is stripped: never negative
    act(() => { input.props.onChangeText(''); });
    expect(onChange).toHaveBeenLastCalledWith(0);
  });
});

describe('StatusBanners', () => {
  const summary = { pending: 0, syncing: 0, conflict: 0, rejected: 0, blocked: 0, synced: 0, unsynced: 0, lastSyncedAt: null, online: true, syncing_now: false };
  const withSync = (s: Partial<typeof summary>) => { act(() => { useAppStore.getState().setSync({ ...summary, ...s }); }); };

  it('is silent when online and nothing is waiting', () => {
    withSync({});
    expect(texts(render(<StatusBanners />))).toBe('');
  });
  it('tells the user plainly when offline and when records need a decision', () => {
    withSync({ online: false, conflict: 1, rejected: 1 });
    const t = texts(render(<StatusBanners />));
    expect(t).toContain('Offline');
    expect(t).toContain('saved on this phone');
    expect(t).toContain('2 records need your attention');
  });
  it('shows sending progress when online', () => {
    withSync({ pending: 3 });
    expect(texts(render(<StatusBanners />))).toContain('Sending 3 saved records');
  });
});

describe('ReasonModal', () => {
  it('needs a reason of at least 5 characters before it can be confirmed, and starts empty each time', async () => {
    const onConfirm = jest.fn();
    const r = render(<ReasonModal visible title="Void?" onCancel={() => undefined} onConfirm={onConfirm} confirmLabel="Void" />);
    const field = () => r.root.findByProps({ accessibilityLabel: 'Reason (at least 5 characters)' });
    const confirm = () => r.root.findAll((n) => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function').find((n) => n.findAll((x) => x.children.includes('Void')).length > 0)!;
    expect(confirm().props.disabled).toBe(true);
    act(() => { field().props.onChangeText('typo'); });
    expect(confirm().props.disabled).toBe(true);
    act(() => { field().props.onChangeText('  entered twice by mistake  '); });
    expect(confirm().props.disabled).toBe(false);
    await act(async () => { await confirm().props.onPress(); });
    expect(onConfirm).toHaveBeenCalledWith('entered twice by mistake'); // trimmed
    act(() => { r.update(<ReasonModal visible={false} title="Void?" onCancel={() => undefined} onConfirm={onConfirm} />); });
    act(() => { r.update(<ReasonModal visible title="Void?" onCancel={() => undefined} onConfirm={onConfirm} />); });
    expect(field().props.value).toBe(''); // reopened: fresh form
  });
});

