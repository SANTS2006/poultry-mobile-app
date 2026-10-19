# Sign in with Google

Only accounts an administrator has already created can use it. Google proves the e-mail address; the server looks the user up by that address.
Unknown address → "Account not found. Please contact your administrator." (nothing is created). Disabled/locked accounts are refused. An invited
account that has not been activated yet is activated on first Google sign-in. Two-step sign-in (MFA) rules still apply afterwards.

## Set-up (once)
1. Google Cloud Console → APIs & Services → OAuth consent screen (Internal or External) → create it.
2. Credentials → Create OAuth client ID:
   - **Web application** → copy its client id. This is the one the server checks.
   - **Android** (package `com.makarifor.poultry`, SHA-1 of your signing key: `eas credentials` shows it; add the debug and the store key).
   - **iOS** (bundle id `com.makarifor.poultry`) → copy its client id and its *reversed* id (`com.googleusercontent.apps.…`).
3. Server `.env`: `GOOGLE_CLIENT_IDS=<web client id>` (comma-separate more ids if needed). Restart the API.
4. App environment (EAS secrets / `.env`): `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=<web client id>`, `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=<ios client id>`,
   `GOOGLE_IOS_URL_SCHEME=<reversed ios client id>`.
5. Make a **new native build** (`eas build`): the Google module is native, so it does not work in Expo Go. Leave the variables blank to hide the button.
