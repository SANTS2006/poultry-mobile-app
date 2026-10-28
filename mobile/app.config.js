
/** Dynamic configuration layered on top of app.json. */
module.exports = ({ config }) => {
  const base = config;
  const production =
    process.env.EXPO_PUBLIC_APP_ENV === 'production';

  const plugins = [...(base.plugins ?? [])];

  const ios = {
    ...base.ios,
    infoPlist: {
      ...(base.ios?.infoPlist ?? {}),
    },
  };

  if (!production) {
    // Allow local development against a laptop on the same Wi-Fi.
    // Production builds do not enable cleartext traffic.
    plugins.push([
      'expo-build-properties',
      {
        android: {
          usesCleartextTraffic: true,
        },
      },
    ]);

    ios.infoPlist.NSAppTransportSecurity = {
      NSAllowsLocalNetworking: true,
    };
  }

  if (
    (process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '').trim()
  ) {
    const iosUrlScheme = (
      process.env.GOOGLE_IOS_URL_SCHEME ?? ''
    ).trim();

    plugins.push(
      iosUrlScheme
        ? [
            '@react-native-google-signin/google-signin',
            { iosUrlScheme },
          ]
        : '@react-native-google-signin/google-signin'
    );
  }

  return {
    ...base,
    ios,
    plugins,
  };
};
