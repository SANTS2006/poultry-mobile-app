// Icon fonts load asynchronously (state updates outside act()); tests only need to know WHICH icon was rendered.
jest.mock('@expo/vector-icons', () => {
  const React = require('react');
  const Ionicons = ({ name, ...rest }) => React.createElement('Icon', { name, ...rest });
  return { Ionicons };
});
