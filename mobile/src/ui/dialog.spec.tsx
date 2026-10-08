import { View } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DialogProvider, useDialog, type DialogOptions } from './dialog';
import { BusyOverlay, DotsLoader, EggSpinner, useBusyOverlay, withBusyOverlay } from './loaders';

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const texts = (r: ReactTestRenderer): string => {
  const out: string[] = [];
  const walk = (n: unknown): void => { if (n === null || n === undefined) return; if (typeof n === 'string') { out.push(n); return; } if (Array.isArray(n)) { n.forEach(walk); return; } walk((n as { children?: unknown }).children); };
  walk(r.toJSON());
  return out.join(' ');
};
const press = (r: ReactTestRenderer, label: string) => { act(() => { r.root.findAll((n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0].props.onPress(); }); };

function setup() {
  const api: { current?: ReturnType<typeof useDialog> } = {};
  const Grab = () => { api.current = useDialog(); return null; };
  let r!: ReactTestRenderer;
  act(() => { r = create(<DialogProvider><Grab /></DialogProvider>); });
  return { r, api: () => api.current! };
}

describe('dialogs', () => {
  it('confirm resolves true for the confirm button and false for cancel', async () => {
    const { r, api } = setup();
    let answer: boolean | undefined;
    act(() => { void api().confirm({ title: 'Delete it?', message: 'This cannot be undone.', confirmLabel: 'Delete', destructive: true }).then((v) => { answer = v; }); });
    expect(texts(r)).toContain('Delete it?');
    expect(texts(r)).toContain('This cannot be undone.');
    await act(async () => { press(r, 'Delete'); });
    expect(answer).toBe(true);
    expect(texts(r)).not.toContain('Delete it?');
    act(() => { void api().confirm({ title: 'Again?' }).then((v) => { answer = v; }); });
    await act(async () => { press(r, 'Cancel'); });
    expect(answer).toBe(false);
  });

  it('notify shows one button and ask returns the chosen value (null when dismissed)', async () => {
    const { r, api } = setup();
    let done = false;
    act(() => { void api().notify({ title: 'Saved', tone: 'success' }).then(() => { done = true; }); });
    await act(async () => { press(r, 'OK'); });
    expect(done).toBe(true);

    let picked: string | null | undefined;
    const opts: DialogOptions<string> = { title: 'Photo', actions: [{ label: 'Camera', value: 'camera' }, { label: 'Library', value: 'library' }] };
    act(() => { void api().ask(opts).then((v) => { picked = v; }); });
    await act(async () => { press(r, 'Library'); });
    expect(picked).toBe('library');
    act(() => { void api().ask(opts).then((v) => { picked = v; }); });
    await act(async () => { press(r, 'Close dialog'); });
    expect(picked).toBeNull();
  });

  it('queues dialogs so a second one waits for the first', async () => {
    const { r, api } = setup();
    const order: string[] = [];
    act(() => {
      void api().notify({ title: 'First' }).then(() => order.push('first'));
      void api().notify({ title: 'Second' }).then(() => order.push('second'));
    });
    expect(texts(r)).toContain('First');
    expect(texts(r)).not.toContain('Second');
    await act(async () => { press(r, 'OK'); });
    expect(texts(r)).toContain('Second');
    await act(async () => { press(r, 'OK'); });
    expect(order).toEqual(['first', 'second']);
  });
});

describe('loaders', () => {
  it('render with accessible labels', () => {
    let r!: ReactTestRenderer;
    act(() => { r = create(<View><EggSpinner label="Loading flock" /><DotsLoader color="#fff" /></View>); });
    expect(r.root.findAll((n) => n.props.accessibilityLabel === 'Loading flock' && n.props.accessibilityRole === 'progressbar')).not.toHaveLength(0);
  });

  it('the busy overlay shows its message while the work runs and goes away afterwards, never flashing', async () => {
    let r!: ReactTestRenderer;
    act(() => { r = create(<BusyOverlay />); });
    expect(texts(r)).toBe('');
    let release!: () => void;
    let finished = false;
    const started = Date.now();
    await act(async () => {
      const p = withBusyOverlay('Signing you out…', () => new Promise<void>((res) => { release = res; }), 60).then(() => { finished = true; });
      await Promise.resolve();
      void p;
    });
    expect(texts(r)).toContain('Signing you out…');
    expect(useBusyOverlay.getState().message).toBe('Signing you out…');
    await act(async () => { release(); await new Promise((res) => setTimeout(res, 120)); });
    expect(finished).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(60); // kept up for the minimum time
    expect(useBusyOverlay.getState().message).toBeNull();
    expect(texts(r)).toBe('');
  });

  it('hides the overlay even when the work fails', async () => {
    await act(async () => { await expect(withBusyOverlay('Working…', async () => { throw new Error('boom'); }, 0)).rejects.toThrow('boom'); });
    expect(useBusyOverlay.getState().message).toBeNull();
  });
});
