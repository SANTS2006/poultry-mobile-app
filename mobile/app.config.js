/** Static config lives in app.json. This file only adds what depends on the build environment. */
const base = require('./app.json').expo;

module.exports = () => {
  const production = process.env.EXPO_PUBLIC_APP_ENV === 'production';
  const plugins = [...base.plugins];
  const ios = { ...base.ios, infoPlist: { ...base.ios.infoPlist } };
  if (!production) {
    // Development/staging against a laptop on the same Wi-Fi uses plain http://<LAN-IP>:3000. Production builds never allow cleartext.
    plugins.push(['expo-build-properties', { android: { usesCleartextTraffic: true } }]);
    ios.infoPlist.NSAppTransportSecurity = { NSAllowsLocalNetworking: true };
  }
  return { ...base, ios, plugins };
};
