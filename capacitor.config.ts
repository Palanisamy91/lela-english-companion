import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // If you already published an APK, keep its existing applicationId here
  // so Android can update the installed app instead of treating it as new.
  appId: 'com.palanisamy.myenglishbuddy',
  appName: 'Lela English Companion',
  webDir: 'dist/my-english-buddy/browser',
  bundledWebRuntime: false,
  android: {
    allowMixedContent: false
  }
};

export default config;
