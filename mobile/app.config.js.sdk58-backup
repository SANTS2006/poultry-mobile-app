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
  if ((process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '').trim()) {
    // iOS needs the "reversed client id" of the iOS OAuth client (looks like com.googleusercontent.apps.123-abc) as a URL scheme.
    const iosUrlScheme = (process.env.GOOGLE_IOS_URL_SCHEME ?? '').trim();
    plugins.push(iosUrlScheme ? ['@react-native-google-signin/google-signin', { iosUrlScheme }] : '@react-native-google-signin/google-signin');
  }
  return { ...base, ios, plugins };
};
