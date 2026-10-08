// Icon fonts load asynchronously (state updates outside act()); tests only need to know WHICH icon was rendered.
jest.mock('@expo/vector-icons', () => {
  const React = require('react');
  const Ionicons = ({ name, ...rest }) => React.createElement('Icon', { name, ...rest });
  return { Ionicons };
});

// Native modules that do not exist in the test runner. Glass/blur are visual only; haptics and screen-capture are no-ops here.
jest.mock('expo-glass-effect', () => {
  const React = require('react');
  return {
    GlassView: ({ children, ...rest }) => React.createElement('GlassView', rest, children),
    GlassContainer: ({ children, ...rest }) => React.createElement('GlassContainer', rest, children),
    isLiquidGlassAvailable: () => false,
    isGlassEffectAPIAvailable: () => false,
  };
});
jest.mock('expo-blur', () => {
  const React = require('react');
  return { BlurView: ({ children, ...rest }) => React.createElement('BlurView', rest, children) };
});
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(async () => undefined), notificationAsync: jest.fn(async () => undefined), selectionAsync: jest.fn(async () => undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' }, NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));
jest.mock('expo-screen-capture', () => ({
  preventScreenCaptureAsync: jest.fn(async () => undefined), allowScreenCaptureAsync: jest.fn(async () => undefined), usePreventScreenCapture: jest.fn(),
}));
