import Constants, { ExecutionEnvironment } from 'expo-constants';

/**
 * True when running inside the Expo Go sandbox app (handy for trying the app on a phone, NOT for real use):
 * no SQLCipher (local database unencrypted), no remote push notifications, custom URL scheme links do not open the app.
 */
export const IS_EXPO_GO = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
